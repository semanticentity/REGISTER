// Porting an instrument: draft a map from its HTML, attach the bridge, and
// drive it both ways. Uses a toy instrument so this runs anywhere.
const path = require('path');
const { execFileSync } = require('child_process');
const { test } = require('../lib');
const B = { browser: true };
const root = path.join(__dirname, '..', '..');

function draftMap() {
  const out = execFileSync('node', [path.join(root, 'tools/map-from-html.js'),
    path.join(root, 'tests/fixtures/toy-instrument.html'), path.join(root, 'tests/fixtures/toy.config.json')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out);
}

test('the drafted map is one contiguous map with typed fields and CAPS', t => {
  const map = draftMap();
  let at = parseInt(map.space[0], 16);
  for (const r of map.regions) {
    t.equal(parseInt(r.start, 16), at, `${r.name} starts where the last region ended`);
    at = parseInt(r.end, 16) + 1;
  }
  t.equal(at, parseInt(map.space[1], 16) + 1, 'covers the whole space');
  const byName = Object.fromEntries(map.regions.filter(r => r.fields).map(r => [r.name, r.fields[0]]));
  t.equal(byName.TOY_CUTOFF.control.curve, 'log', 'a wide frequency range gets a log curve');
  t.equal(byName.TOY_WAVE.options, ['sine', 'square', 'saw'], 'options use value, or text when there is none');
  t.equal(byName.LENGTH.control.raw, true, 'a small whole-number range stores the value itself');
  t.ok(byName.TOY_SWING, 'a control made at startup is mapped from the config');
  t.equal(byName.CAPS.type, 'readonly');
});

test('POKE moves the instrument\'s controls and steps; moving a control rewrites the byte', async t => {
  const map = draftMap();
  const p = await t.page('tests/fixtures/toy-instrument.html', { wait: 300 });
  await p.evaluate(m => { window.TOY_MAP = m; }, map);
  for (const f of ['map-panel.js', 'register-console.js', 'dom-bridge.js']) await p.addScriptTag({ url: '/' + f });
  const r = await p.evaluate(() => {
    const bridge = RegisterBridge.attach({ map: TOY_MAP, afterArrayWrite: () => { toy.redraws++; } });
    RegisterBridge.dock({ map: TOY_MAP, bridge });
    const M = bridge.mem, o = {};
    o.start = { cutoff: M[0x5002], level: M[0x5003], length: M[0x5000], tracks: M[0x5001] };
    REGISTER.run('POKE $5002, 255');
    REGISTER.run('POKE $5005, 2');
    REGISTER.run('POKE $5001, 2');
    REGISTER.run('POKE $5000, 8');
    REGISTER.run('POKE $5110, 1');                       // step 17
    REGISTER.run('POKE $5005, 9');                       // not an option
    o.after = {
      cutoff: document.getElementById('toyCutoff').value, heardCutoff: toy.state.toyCutoff,
      wave: document.getElementById('toyWave').value, byteWave: M[0x5005],
      tracks: [...document.querySelectorAll('.toyTrack')].map(c => c.checked),
      length: document.querySelector('.toy-length').value,
      step17: toy.steps[16], redraws: toy.redraws
    };
    const level = document.getElementById('toyLevel');
    level.value = 1; level.dispatchEvent(new Event('input', { bubbles: true }));
    o.levelByte = M[0x5003];
    o.caps = M[0x50F0];
    return o;
  });
  t.equal(r.start, { cutoff: 144, level: 128, length: 16, tracks: 1 }, 'memory starts as the controls are: 1000 Hz on a 20-20000 log scale is byte 144');
  t.equal(r.after.cutoff, '20000', 'byte 255 is the top of the range');
  t.equal(r.after.heardCutoff, '20000', 'the instrument\'s own handler saw it');
  t.equal(r.after.wave, 'saw', 'enum by index');
  t.equal(r.after.byteWave, 2, 'an invalid option snaps back');
  t.equal(r.after.tracks, [false, true], 'bits drive checkboxes');
  t.equal(r.after.length, '8', 'raw value');
  t.ok(r.after.step17 && r.after.redraws > 0, 'steps write the array, then the instrument redraws');
  t.equal(r.levelByte, 255, 'moving a control rewrites its byte');
  t.equal(r.caps, 3, 'CAPS: both packs');
  await p.click('.reg-dock-btn');
  await p.waitForTimeout(400);
  t.above(await p.locator('.reg-dock .map-row').count(), 4, 'the dock shows the map panel');
  t.equal(p.errors, []);
}, B);

test('custom bindings bridge state that is not a control, such as a list', async t => {
  const p = await t.page('tests/fixtures/toy-instrument.html', { wait: 300 });
  await p.addScriptTag({ url: '/dom-bridge.js' });
  const r = await p.evaluate(() => {
    window.toy.cables = [{ from: 'lfo', amount: 0.5 }, { from: 'env', amount: -1 }];
    const map = {
      name: 'TOY2', space: ['0x6000', '0x60FF'], caps_addr: '0x60F0', caps_bits: { 0: 'TOY2' },
      regions: [{ start: '0x6000', end: '0x6001', pack: 'TOY2', name: 'CABLES', fields: [
        { name: 'CABLE_1', type: 'u8', control: { custom: 'cable', slot: 0 } },
        { name: 'CABLE_2', type: 'u8', control: { custom: 'cable', slot: 1 } }] }]
    };
    const custom = { cable: {
      read(b, mem) { const c = toy.cables[b.c.slot]; mem[b.addr] = c ? Math.round(c.amount * 64 + 128) : 128; },
      write(b, mem) { toy.cables[b.c.slot].amount = (mem[b.addr] - 128) / 64; }
    } };
    const bridge = RegisterBridge.attach({ map, custom });
    const before = [bridge.mem[0x6000], bridge.mem[0x6001]];
    bridge.mem[0x6001] = 192; bridge.push(0x6001);
    return { before, amount: toy.cables[1].amount };
  });
  t.equal(r.before, [160, 64], 'read through the adapter');
  t.equal(r.amount, 1, 'written through the adapter');
}, B);

test('a range that crosses zero keeps zero exact, and a memory snapshot restores the instrument', async t => {
  const map = draftMap();
  const p = await t.page('tests/fixtures/toy-instrument.html', { wait: 300 });
  await p.evaluate(m => { window.TOY_MAP = m; }, map);
  for (const f of ['map-panel.js', 'register-console.js', 'dom-bridge.js']) await p.addScriptTag({ url: '/' + f });
  const r = await p.evaluate(() => {
    const bridge = RegisterBridge.attach({ map: TOY_MAP });
    const addr = n => parseInt(TOY_MAP.regions.find(x => x.name === n).start, 16);
    const zero = bridge.mem[addr('TOY_PAN')];
    bridge.mem[addr('TOY_PAN')] = 128; bridge.push(addr('TOY_PAN'));
    const backToZero = document.getElementById('toyPan').value;
    const read = () => ['toyCutoff', 'toyLevel', 'toyPan', 'toyWave', 'toySwing'].map(id => document.getElementById(id).value).join(',') + '|' + toy.steps.join('');
    const before = read(), snap = bridge.mem.slice(0x5000, 0x5200);
    for (const id of ['toyCutoff', 'toyLevel', 'toyPan', 'toySwing']) { const e = document.getElementById(id); e.value = e.max; e.dispatchEvent(new Event('input', { bubbles: true })); }
    document.getElementById('toyWave').value = 'saw'; toy.steps.fill(true);
    const scrambled = read();
    bridge.restore(snap, 0x5000);
    return { zero, backToZero, before, scrambled, after: read() };
  });
  t.equal(r.zero, 128, 'pan 0 is byte 128');
  t.equal(r.backToZero, '0', 'byte 128 is exactly 0');
  t.ok(r.scrambled !== r.before, 'scrambled');
  // Everything comes back; a continuous value comes back within one byte step
  const [aVals, aSteps] = r.after.split('|'), [bVals, bSteps] = r.before.split('|');
  const av = aVals.split(','), bv = bVals.split(',');
  t.near(Number(av[0]), Number(bv[0]), Number(bv[0]) * 0.02, 'cutoff within a byte step (log scale)');
  t.equal(av.slice(1), bv.slice(1), 'level, pan, wave and swing restored exactly');
  t.equal(aSteps, bSteps, 'steps restored');
}, B);
