// llms.txt: generated from the map and engine.js, so it cannot drift.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { test } = require('../lib');
const root = path.join(__dirname, '..', '..');
const map = require(path.join(root, 'memory-map.json'));
const { engineLists } = require(path.join(root, 'tools/build-llms.js'));
const { parse } = require(path.join(root, 'tools/render.js'));

test('llms.txt and llms-full.txt match the map (CI fails when they do not)', t => {
  const out = execFileSync('node', [path.join(root, 'tools/build-llms.js'), '--check'], { encoding: 'utf8' });
  t.ok(/llms ok/.test(out), out);
});

test('every pack is in llms.txt, every field in llms-full.txt, every engine in both', t => {
  const short = fs.readFileSync(path.join(root, 'llms.txt'), 'utf8');
  const full = fs.readFileSync(path.join(root, 'llms-full.txt'), 'utf8');
  for (const [bit, pack] of Object.entries(map.caps_bits)) t.ok(short.includes(`bit ${bit} ${pack} `), `${pack} listed`);
  for (const r of map.regions) for (const f of r.fields || []) {
    t.ok(full.includes(`  - ${f.name} $`), `${f.name} in llms-full.txt`);
    if (f.options) t.ok(full.includes(f.options.map((o, i) => `${i} ${o}`).join(', ')), `${f.name} options`);
  }
  const lists = engineLists();
  for (const [voice, names] of Object.entries(lists)) {
    t.ok(short.includes(`${voice.toUpperCase()}_ENGINE`) && short.includes(names.map((n, i) => `${i} ${n}`).join(', ')), `${voice} engines`);
  }
  t.below(short.length, 16000, 'llms.txt stays short');
});

test('render.js reads console lines and SOUND blocks in order', t => {
  const items = parse('POKE $1501, 120 ; tempo\n\nSOUND Pad\nFROM lead\nA = 5\n\nPOKE LEAD_ENGINE fm');
  t.equal(items, [{ line: 'POKE $1501, 120' }, { sound: 'SOUND Pad\nFROM lead\nA = 5' }, { line: 'POKE LEAD_ENGINE fm' }]);
});
