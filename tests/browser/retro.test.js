// Ported from the $1010 prototype: FM wired like the Yamaha chips, the WSG and
// SCC wave modes and wave drums, the POKEY, and the bus budget (XBUS).
const { test } = require('../lib');
const B = { browser: true };

async function bar(page, setup) {
  return page.evaluate(async src => {
    initAudio();
    await new Promise(r => setTimeout(r, 300));
    tempo = 120; swing = 0;
    for (const a of [0x1000, 0x1020, 0x1100, 0x1200, 0x1300]) MEM.fill(0, a, a + 16);
    MEM.fill(0, 0x1400, 0x14A0); MEM.fill(0, 0x1080, 0x1096); MEM.fill(0, 0x1E00, 0x1E41); MEM.fill(0, 0x1508, 0x150D);
    const seg = (buf, t0, t1) => buf.getChannelData(0).slice(Math.floor(t0 * 44100), Math.floor(t1 * 44100));
    const rms = (buf, t0, t1) => { const d = seg(buf, t0, t1); let s = 0; for (const v of d) s += v * v; return Math.sqrt(s / d.length); };
    const diff = (a, b) => { let d = 0, e = 0; for (let i = 0; i < a.length; i++) { d += Math.abs(a[i] - b[i]); e += Math.abs(a[i]) + 1e-9; } return d / e; };
    // Pitch from upward zero crossings
    const pitch = (buf, t0, t1) => { const d = seg(buf, t0, t1); let n = 0, first = -1, last = -1; for (let i = 1; i < d.length; i++) if (d[i - 1] < 0 && d[i] >= 0) { if (first < 0) first = i; last = i; n++; } return (n - 1) * 44100 / (last - first); };
    const render = () => exportWAV(1, { returnBuffer: true });
    return (new Function('MEM', 'render', 'rms', 'seg', 'diff', 'pitch', 'return (async () => {' + src + '})()'))(MEM, render, rms, seg, diff, pitch);
  }, setup);
}

test('FM: every operator is heard in every one of the 8 Yamaha algorithms', async t => {
  const p = await t.page('sequencer.html', { wait: 2500 });
  const r = await bar(p, `
    MEM[0x1100] = 57; MEM[0x115A] = 1; MEM.set([5, 60, 180, 60], 0x1068);
    const out = [];
    for (let alg = 0; alg < 8; alg++) {
      MEM[0x1910] = alg; MEM[0x1911] = 0; MEM.fill(0, 0x1912, 0x1916);
      for (let i = 0; i < 4; i++) { MEM.set([16 * (i + 1), 60, 0, 0], 0x1900 + i * 4); MEM.set([5, 100, 200, 80], 0x1920 + i * 4); }
      const carriers = FM_ALGORITHMS[alg].carriers;
      carriers.forEach(c => { MEM[0x1901 + c * 4] = 200; });
      const base = seg(await render(), 0.05, 0.3);
      const moved = [];
      for (let i = 0; i < 4; i++) {
        const old = MEM[0x1901 + i * 4];
        MEM[0x1901 + i * 4] = carriers.includes(i) ? 40 : 255;
        moved.push(+diff(base, seg(await render(), 0.05, 0.3)).toFixed(2));
        MEM[0x1901 + i * 4] = old;
      }
      out.push(moved);
    }
    // Feedback reshapes OP4 alone; DT1 detunes it
    MEM[0x1910] = 7; for (let i = 0; i < 3; i++) MEM[0x1901 + i * 4] = 0; MEM[0x190D] = 200;
    const pure = seg(await render(), 0.05, 0.3);
    MEM[0x190E] = 200; const fb = seg(await render(), 0.05, 0.3); MEM[0x190E] = 0;
    MEM[0x1915] = 3; const dt = seg(await render(), 0.05, 0.3);
    return { out, fb: diff(pure, fb), dt: diff(pure, dt), ratio: [fmRatio(0), fmRatio(16), fmRatio(48)] };`);
  r.out.forEach((moved, alg) => moved.forEach((d, op) => t.above(d, 0.3, `algorithm ${alg}: OP${op + 1} changes the sound (${d})`)));
  t.above(r.fb, 0.3, 'feedback changes the timbre');
  t.above(r.dt, 0.3, 'DT1 detune drifts the phase');
  t.equal(r.ratio, [0.5, 1, 3], 'ratio bytes: 0 = 0.5x, 16 = 1x, 48 = 3x');
  t.equal(p.errors, []);
}, B);

test('WAVE_MODE: WSG 4-bit keeps 16 levels and sounds different from SCC 8-bit; drums play the table', async t => {
  const p = await t.page('sequencer.html', { wait: 2500 });
  const r = await bar(p, `
    MEM[0x1100] = 57; MEM[0x115A] = 4; MEM.set([5, 60, 180, 60], 0x1068);
    for (let i = 0; i < 32; i++) MEM[0x1A20 + i] = Math.round(Math.sin(2 * Math.PI * i / 32) * 40) & 255;   // a quiet sine: 4 bits shows its steps
    MEM[0x1A40] = 0; const scc = seg(await render(), 0.05, 0.25);
    MEM[0x1A40] = 1; const wsg = seg(await render(), 0.05, 0.25);
    MEM[0x1100] = 0;
    MEM[0x1058] = 3; MEM[0x1059] = 3; MEM[0x135A] = 1;
    MEM[0x1000] = 1; MEM[0x1010] = 36; MEM[0x1024] = 1; MEM[0x1034] = 180; MEM[0x1044] = 120; MEM[0x1308] = 1; MEM[0x1318] = 8;
    const drums = await render();
    return { d: diff(scc, wsg), kick: rms(drums, 0.05, 0.15), snare: rms(drums, 0.55, 0.65), noise: rms(drums, 1.05, 1.1), names: [SYNTH_IDS.kick[3], SYNTH_IDS.snare[3], SYNTH_IDS.noise[1]] };`);
  t.above(r.d, 0.05, `the two modes differ (${r.d.toFixed(3)})`);
  t.equal(r.names, ['wave', 'wave', 'wave']);
  t.above(r.kick, 0.02, 'wave kick');
  t.above(r.snare, 0.01, 'wave snare');
  t.above(r.noise, 0.01, 'wave noise');
  t.equal(p.errors, []);
}, B);

test('POKEY: real polynomial counters, dividers that go out of tune at 64 kHz, and all five voices', async t => {
  const p = await t.page('sequencer.html', { wait: 2500 });
  const r = await bar(p, `
    const ones = a => a.reduce((n, b) => n + b, 0);
    const polys = [2, 3, 4, 5].map(k => [pokeyPattern(k).length, ones(pokeyPattern(k))]);
    MEM.fill(0, 0x1A50, 0x1A60);
    MEM[0x115A] = 5; MEM.set([0, 30, 255, 40], 0x1068); MEM[0x1100] = 69;   // A4 on pokey, held
    MEM[0x1A5F] = 2; const inTune = pitch(await render(), 0.07, 0.15);       // 1.79 MHz
    MEM[0x1A5F] = 0; MEM[0x1100] = 84; const c6 = pitch(await render(), 0.07, 0.15);   // 64 kHz
    const c6Expect = pokeyRate(midiHz(84), 1, POKEY_CLOCKS[0]) / 2;
    MEM[0x1100] = 0;
    MEM[0x1058] = 4; MEM[0x1059] = 4; MEM[0x125A] = 4; MEM[0x135A] = 2;
    MEM[0x1000] = 1; MEM[0x1010] = 36; MEM[0x1024] = 1; MEM[0x1034] = 180; MEM[0x1044] = 120; MEM[0x1308] = 1; MEM[0x1318] = 8; MEM[0x120C] = 45;
    MEM.set([0, 30, 200, 40], 0x106C);
    const all = await render();
    return { polys, inTune, c6, c6Expect, kick: rms(all, 0.05, 0.13), snare: rms(all, 0.55, 0.63), noise: rms(all, 1.05, 1.08), bass: rms(all, 1.57, 1.65),
      defaults: [pokeyOf('bass').poly, pokeyOf('lead').poly, pokeyOf('noise').poly, pokeyOf('kick').vol] };`);
  t.equal(r.polys, [[15, 8], [31, 16], [511, 256], [131071, 65536]], '4, 5, 9 and 17-bit counters: maximal length, half ones');
  t.near(r.inTune, 440, 4, `A4 at 1.79 MHz is in tune (${r.inTune.toFixed(1)} Hz)`);
  t.near(r.c6, r.c6Expect, 8, `C6 at 64 kHz lands where the 8-bit divider puts it (${r.c6.toFixed(0)} Hz, not 1047)`);
  t.ok(Math.abs(r.c6Expect - 1046.5) > 5, 'and that is audibly off');
  t.equal(r.defaults, [2, 1, 5, 15], 'not set: bass buzzes (4-bit), lead is pure, noise hisses (17-bit), volume 15');
  for (const k of ['kick', 'snare', 'noise', 'bass']) t.above(r[k], 0.01, `pokey ${k}`);
  t.equal(p.errors, []);
}, B);

test('XBUS: automation gets SPEED writes a step; the rest drop, corrupt, run late or alias', async t => {
  const p = await t.page('sequencer.html', { wait: 2500 });
  const r = await p.evaluate(() => {
    const o = {};
    const locks = n => { MEM[0x1E00] = n; for (let i = 0; i < n; i++) MEM.set([0, 0xB0 + i, 0x10, 77], 0x1E01 + i * 4); };   // step 0: KICK_VOL... NOISE_VOL = 77
    MEM.fill(20, 0x10B0, 0x10B5);
    // Off: every lock lands
    MEM[0x1508] = 0; locks(5); busBegin(0); let rest = applyLocks(0); o.off = rest.length; rest.reverse().forEach(([a, v]) => { MEM[a] = v; });
    // On, 2 writes a step, drop
    MEM.set([1, 2, 0], 0x1508); MEM[0x150B] = 0;
    busBegin(0); rest = applyLocks(0);
    o.drop = { landed: rest.length, overflows: MEM[0x150B], load: MEM[0x150C], misses: bus.events.map(e => e.mode) };
    rest.reverse().forEach(([a, v]) => { MEM[a] = v; });
    // late: the 3 that missed land at the start of the next step, as locks
    MEM[0x150A] = 2; busBegin(0); rest = applyLocks(0); rest.reverse().forEach(([a, v]) => { MEM[a] = v; });
    MEM[0x1E00] = 0; MEM[0x1509] = 8; const late = busBegin(1); rest = applyLocks(1, late);
    o.late = rest.map(([a]) => a);
    rest.reverse().forEach(([a, v]) => { MEM[a] = v; });
    // corrupt: lands with flipped bits
    MEM.set([1, 0, 1], 0x1508); MEM[0x1509] = 1; locks(2); busBegin(0); rest = applyLocks(0);
    o.corrupt = MEM[0x10B1]; rest.reverse().forEach(([a, v]) => { MEM[a] = v; });
    // alias: lands one address line away
    MEM[0x150A] = 3; busBegin(0); rest = applyLocks(0);
    o.alias = bus.events.map(e => e.to ^ e.addr);
    rest.reverse().forEach(([a, v]) => { MEM[a] = v; });
    // Automation: ten writes, room for three
    MEM.set([1, 3, 0], 0x1508); MEM[0x1E00] = 0; MEM.fill(0, 0x1300, 0x1310); busBegin(2);
    busAutomation('evolve', 2, () => { for (let i = 0; i < 10; i++) MEM[0x1300 + i] = 1; });
    o.auto = Array.from(MEM.slice(0x1300, 0x130A));
    // Your own writes are never counted
    const before = MEM[0x150C]; MEM[0x1301] = 5; o.userLoad = MEM[0x150C] === before;
    return o;
  });
  t.equal(r.off, 5, 'bus off: all five locks');
  t.equal(r.drop.landed, 2, 'bus on, speed 2: two land');
  t.equal(r.drop.overflows, 3, 'three overflow');
  t.equal(r.drop.load, 5, 'BUS_LOAD counts all five tries');
  t.equal(r.drop.misses, ['drop', 'drop', 'drop']);
  t.equal(r.late, [0x10B2, 0x10B3, 0x10B4], 'late: the three missed locks land on the next step');
  t.ok(r.corrupt !== 77 && r.corrupt !== 20, `corrupt: the second lock landed as ${r.corrupt}, not 77`);
  t.ok(r.alias.length === 1 && [1, 2, 4, 8].includes(r.alias[0]), 'alias: one low address line flipped');
  t.equal(r.auto, [1, 1, 1, 0, 0, 0, 0, 0, 0, 0], 'automation: three of ten writes land');
  t.ok(r.userLoad, 'a direct write is not budgeted');
}, B);

test('XBUS in the sequencer: the panel sets the bytes, misses mark grid cells, and it plays clean', async t => {
  const p = await t.page('sequencer.html', { wait: 2500 });
  await p.click('#btn-bus');
  await p.waitForSelector('#bus-panel .ce-on');
  await p.check('#bus-panel .ce-on');
  await p.selectOption('#bus-panel .ce-busmode', '2');
  const r = await p.evaluate(async () => {
    const o = { ctrl: MEM[0x1508], mode: MEM[0x150A] };
    showBusMisses([{ addr: 0x1003, value: 1, source: 'evolve', mode: 'drop', step: 3 }]);
    o.cell = document.querySelectorAll('#grid-kick .grid-cell')[3].classList.contains('glitch-drop');
    MEM[0x1509] = 1;
    if (!evolveActive) document.getElementById('btn-evolve').click();
    togglePlay();
    await new Promise(res => setTimeout(res, 2500));
    togglePlay();
    o.ext = MEM[0x15F5];
    return o;
  });
  t.equal([r.ctrl, r.mode], [1, 2], 'checkbox and select write $1508 and $150A');
  t.ok(r.cell, 'a dropped gate write marks its cell');
  t.equal(r.ext & 7, 7, 'CAPS_EXT: XBUS, XPOKEY and XFAULT');
  t.equal(p.errors, []);
}, B);

test('sounds: a POKEY setting belongs to the voice, and only travels when the voice is on pokey', async t => {
  const p = await t.page('sequencer.html', { wait: 2500 });
  await p.addScriptTag({ url: '/memory-map.js' });
  await p.addScriptTag({ url: '/sounds.js' });
  const r = await p.evaluate(() => {
    const index = RegisterSounds.buildIndex(window.REGISTER_MAP);
    const opts = { engineOptions: v => SYNTH_IDS[v] };
    const buzz = RegisterSounds.STARTERS.find(s => s.startsWith('SOUND POKEY Buzz Bass'));
    MEM.fill(0, 0x1A50, 0x1A60);
    const a = RegisterSounds.apply(index, MEM, buzz, 'bass', opts);
    const onPokey = RegisterSounds.capture(index, MEM, 'bass', opts);
    MEM[0x115A] = 0;
    const onLead = RegisterSounds.capture(index, MEM, 'lead', opts);
    return { engine: SYNTH_IDS.bass[MEM[0x125A]], poly: MEM[0x1A59], clock: MEM[0x1A5F], skipped: a.skipped, onPokey, onLead };
  });
  t.equal(r.engine, 'pokey');
  t.equal(r.poly, 2, 'BASS_POKEY_POLY = 4-bit');
  t.equal(r.skipped, []);
  t.ok(/POKEY_POLY = 4-bit/.test(r.onPokey) && /POKEY_CLOCK = 64 kHz/.test(r.onPokey), 'captured with its pokey settings');
  t.ok(!/POKEY/.test(r.onLead), 'a voice on another engine leaves them out');
}, B);

test('the wave editor switches WSG and SCC mode', async t => {
  const p = await t.page('sequencer.html', { wait: 2500 });
  await p.click('#btn-wave');
  await p.waitForSelector('#wave-panel [data-chip="wsg round"]');
  await p.click('#wave-panel [data-chip="wsg round"]');
  const wsg = await p.evaluate(() => [MEM[0x1A40], MEM[0x1A20 + 4]]);
  await p.click('#wave-panel [data-chip="scc brass"]');
  const scc = await p.evaluate(() => MEM[0x1A40]);
  t.equal(wsg, [1, (Math.round(14 / 15 * 255 - 128)) & 255], 'a WSG shape: 4-bit values, WSG mode');
  t.equal(scc, 0, 'an SCC shape: SCC mode');
  t.equal(p.errors, []);
}, B);

test('XFAULT: the engine reports what it skipped; with halt on, the sequencer stops on a panic screen', async t => {
  const p = await t.page('sequencer.html', { wait: 2500 });
  const r = await p.evaluate(async () => {
    const o = {};
    const fault = () => [MEM[0x1511], MEM[0x1512] | (MEM[0x1513] << 8)];
    MEM.fill(0, 0x1510, 0x1514);
    MEM[0x1E00] = 1; MEM.set([0, 0x00, 0x15, 9], 0x1E01);          // a lock aimed at SEQ_CTRL
    applyLocks(0); o.lock = fault();
    MEM[0x1E00] = 0; MEM[0x115A] = 200; getVoiceSynth('lead'); o.engine = fault(); o.played = getVoiceSynth('lead');
    MEM[0x115A] = 0; MEM[0x1511] = 0;
    MEM.set([1, 1, 2], 0x1508); bus.late = new Array(64).fill({ addr: 0x10B0, value: 1, source: 'lfo' });
    busRoute(0x10B1, 5, 'lfo', 0); busRoute(0x10B2, 5, 'lfo', 0); o.bus = fault();
    bus.late = []; MEM[0x1508] = 0;
    // Halt on: playing stops and the panic screen comes up
    MEM[0x1510] = 1; MEM[0x1511] = 0;
    MEM[0x1E00] = 1; MEM.set([0, 0x00, 0x15, 9], 0x1E01);
    togglePlay();
    await new Promise(res => setTimeout(res, 1200));
    o.playing = isPlaying;
    o.panel = !!document.querySelector('.ce-panic');
    o.text = document.querySelector('.ce-panic') && document.querySelector('.ce-panic').innerText;
    return o;
  });
  t.equal(r.lock, [1, 0x1500], 'fault 1: a lock aimed at $1500');
  t.equal(r.engine, [3, 0x115A], 'fault 3: engine byte 200 names no engine');
  t.equal(r.played, 'lead', 'and the voice played its first engine');
  t.equal(r.bus, [2, 0x10B2], 'fault 2: the late queue was full');
  t.equal(r.playing, false, 'halt on fault stopped the sequencer');
  t.ok(r.panel && /SYSTEM PANIC/.test(r.text) && /\$1500/.test(r.text), 'panic screen with the address');
  await p.click('.ce-panic button');
  t.equal(await p.evaluate(() => [MEM[0x1511], !!document.querySelector('.ce-panic')]), [0, false], 'RST clears FAULT_CODE');
  t.equal(p.errors, []);
}, B);

test('11 to 9: everything to the top, pull back until one is left, then keep or undo', async t => {
  const p = await t.page('sequencer.html', { wait: 2500 });
  await p.evaluate(() => { MEM.set([90, 80, 70, 60, 0], 0x10B0); });
  await p.click('#btn-mix');
  await p.waitForSelector('#mix-panel .ce-eleven');
  await p.click('#mix-panel .ce-eleven');
  const eleven = await p.evaluate(() => Array.from(MEM.slice(0x10B0, 0x10B5)));
  for (const v of [0, 1, 3, 4]) await p.click(`#mix-panel [data-v="${v}"]`);
  const r = await p.evaluate(() => ({
    vols: Array.from(MEM.slice(0x10B0, 0x10B5)),
    say: document.querySelector('#mix-panel .ce-say').innerText,
    pokes: document.querySelector('#mix-panel .ce-pokes').innerText,
    leadDisabled: document.querySelector('#mix-panel [data-v="2"]').disabled
  }));
  await p.click('#mix-panel .ce-undo');
  const undone = await p.evaluate(() => Array.from(MEM.slice(0x10B0, 0x10B5)));
  t.equal(eleven, [127, 127, 127, 127, 127], 'all to 11');
  t.equal(r.vols, [104, 104, 127, 104, 104], 'four pulled back to 9 (104)');
  t.ok(/LEAD is on top/.test(r.say), r.say);
  t.ok(r.leadDisabled, 'the last one cannot be pulled back');
  t.ok(/POKE \$10B4, 104/.test(r.pokes), 'shows the POKE lines it wrote');
  t.equal(undone, [90, 80, 70, 60, 0], 'UNDO puts the mix back');
  t.equal(p.errors, []);
}, B);
