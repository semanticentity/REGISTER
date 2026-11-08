const { execFileSync } = require('child_process');
const path = require('path');
const { test } = require('../lib');
const root = path.join(__dirname, '..', '..');

test('memory maps pass check-map (one map, typed fields, addresses in code)', t => {
  const out = execFileSync('node', [path.join(root, 'tools/check-map.js')], { encoding: 'utf8' });
  t.ok(/memory-map\.json: ok/.test(out) && /pixel-map\.json: ok/.test(out), out);
});

test('every .wasm and embedded core matches its .wat', t => {
  const out = execFileSync('node', [path.join(root, 'tools/build-wasm.js'), '--check'], { encoding: 'utf8' });
  t.ok(/wasm ok/.test(out), out);
});

test('planned packs define no bytes and no machine claims them', t => {
  const map = require(path.join(root, 'memory-map.json'));
  const planned = new Set(map.regions.filter(r => r.status === 'planned').map(r => r.pack));
  t.ok(planned.size >= 1, 'some packs are planned');
  const bitOf = Object.fromEntries(Object.entries(map.caps_bits).map(([b, n]) => [n, Number(b)]));
  // The CAPS each machine writes: sequencer (CORE, XSTEP + engine) and the
  // WASM core pages (CORE, XSONG + engine). Read the engine's from engine.js.
  const fs = require('fs');
  const engine = fs.readFileSync(path.join(root, 'engine.js'), 'utf8');
  const m = engine.match(/const ENGINE_CAPS = \(([^;]+)\) >>> 0;/);
  t.ok(m, 'ENGINE_CAPS found');
  const engineCaps = Function(`return (${m[1]}) >>> 0`)();
  for (const pack of planned) t.ok(!(engineCaps & (1 << bitOf[pack])), `engine does not claim planned ${pack}`);
  const ext = engine.match(/const ENGINE_CAPS_EXT = \(([^;]+)\) >>> 0;/);
  t.ok(ext, 'ENGINE_CAPS_EXT found');
  const extCaps = Function(`return (${ext[1]}) >>> 0`)();
  for (const pack of planned) if (bitOf[pack] > 31) t.ok(!(extCaps & (1 << (bitOf[pack] - 32))), `engine does not claim planned ${pack}`);
  t.equal(extCaps, ((1 << (bitOf.XPOKEY - 32)) | (1 << (bitOf.XFAULT - 32))) >>> 0, 'the engine claims XPOKEY and XFAULT in the second word');
});

test('CAPS has a second word for bits 32-63, and check-map guards it', t => {
  const fs = require('fs'), os = require('os');
  const map = require(path.join(root, 'memory-map.json'));
  t.equal(map.caps_ext_addr, '0x15F5');
  const ext = map.regions.find(r => r.start === map.caps_ext_addr);
  t.equal([ext.name, ext.end], ['CAPS_EXT', '0x15F8'], 'a 4-byte read-only region right after SPEC_VERSION');
  t.ok(Object.keys(map.caps_bits).some(b => Number(b) > 31), 'some packs live in the second word');
  // A map with a bit above 31 and no second word fails the check
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-'));
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.copyFileSync(path.join(root, 'tools/check-map.js'), path.join(dir, 'tools/check-map.js'));
  const bad = { name: 'T', space: ['0x0000', '0x0007'], caps_addr: '0x0000', js_name: 'T_MAP', caps_bits: { 0: 'A', 40: 'B' },
    regions: [{ start: '0x0000', end: '0x0003', pack: 'A', name: 'CAPS', fields: [{ name: 'CAPS', type: 'readonly', size: 4 }] },
      { start: '0x0004', end: '0x0007', pack: 'B', name: 'B1', fields: [{ name: 'B1', type: 'table', size: 4 }] }] };
  fs.writeFileSync(path.join(dir, 't-map.json'), JSON.stringify(bad));
  let out = '';
  try { execFileSync('node', [path.join(dir, 'tools/check-map.js'), '--write'], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { out = String(e.stderr); }
  t.ok(/caps bit 40 needs caps_ext_addr/.test(out), out || 'no failure');
});
