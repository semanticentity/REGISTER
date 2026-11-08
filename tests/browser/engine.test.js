// The sound engine, checked by rendering audio offline and measuring it.
// Each test renders one bar through exportWAV, the same path as WAV export.
const { test } = require('../lib');
const B = { browser: true };

// Runs in the page: clear the patterns, set bytes, render one bar, measure.
async function render(page, setup) {
  return page.evaluate(async src => {
    initAudio();
    await new Promise(r => setTimeout(r, 300));
    tempo = 120; swing = 0;
    for (const a of [0x1000, 0x1020, 0x1100, 0x1200, 0x1300]) MEM.fill(0, a, a + 16);
    MEM.fill(0, 0x1400, 0x14A0);          // probability, ratchets
    MEM.fill(0, 0x1080, 0x1096);          // filter, delay, bitcrush
    MEM.fill(0, 0x10B0, 0x10BA);          // voice volume, pan
    const rms = (buf, ch, t0, t1) => {
      const d = buf.getChannelData(ch), a = Math.floor(t0 * 44100), z = Math.floor(t1 * 44100);
      let s = 0; for (let i = a; i < z; i++) s += d[i] * d[i];
      return Math.sqrt(s / Math.max(1, z - a));
    };
    const bright = (buf, t0, t1) => {
      const d = buf.getChannelData(0), a = Math.floor(t0 * 44100), z = Math.floor(t1 * 44100);
      let s = 0; for (let i = a + 1; i < z; i++) { const x = d[i] - d[i - 1]; s += x * x; }
      return Math.sqrt(s / (z - a));
    };
    const bar = () => exportWAV(1, { returnBuffer: true });
    return (new Function('MEM', 'bar', 'rms', 'bright', 'return (async () => {' + src + '})()'))(MEM, bar, rms, bright);
  }, setup);
}

test('a neutral drum envelope is the engine\'s own sound, sample for sample', async t => {
  const p = await t.page('sequencer.html', { wait: 2000 });
  const diff = await render(p, `
    MEM[0x1000] = 1; MEM[0x1058] = 1;
    MEM.set([0, 0, 0, 0], 0x1060); const none = await bar();
    MEM.set([0, 0, 255, 255], 0x1060); const neutral = await bar();
    const a = none.getChannelData(0), b = neutral.getChannelData(0);
    let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
    return m;`);
  t.equal(diff, 0);
}, B);

test('envelopes shape every engine: short decay cuts the kick, slow attack softens the lead', async t => {
  const p = await t.page('sequencer.html', { wait: 2000 });
  const r = await render(p, `
    MEM[0x1000] = 1; MEM[0x1058] = 1;
    MEM.set([0, 0, 255, 255], 0x1060); const ring = await bar();
    MEM.set([0, 10, 0, 0], 0x1060); const short = await bar();
    MEM[0x1000] = 0; MEM[0x1100] = 60; MEM[0x115A] = 0;
    MEM.set([0, 40, 200, 60], 0x1068); const fast = await bar();
    MEM.set([255, 40, 200, 60], 0x1068); const slow = await bar();
    return { ring: rms(ring, 0, 0.15, 0.5), short: rms(short, 0, 0.15, 0.5), fast: rms(fast, 0, 0.05, 0.11), slow: rms(slow, 0, 0.05, 0.11) };`);
  t.above(r.ring, 0.01, 'the 808 kick rings');
  t.below(r.short, 0.0005, 'a short decay cuts it');
  t.above(r.fast / r.slow, 5, 'slow attack is much quieter at the start');
}, B);

test('channel strips: volume 32 is 32/127 of full, pan -64 is hard left', async t => {
  const p = await t.page('sequencer.html', { wait: 2000 });
  const r = await render(p, `
    MEM[0x1100] = 60; MEM[0x115A] = 0; MEM.set([10, 40, 128, 60], 0x1068);
    MEM[0x10B2] = 127; const full = await bar();
    MEM[0x10B2] = 32; const low = await bar(); MEM[0x10B2] = 0;
    MEM[0x10B7] = (-64) & 255; const left = await bar();
    return { ratio: rms(low, 0, 0.05, 0.4) / rms(full, 0, 0.05, 0.4), right: rms(left, 1, 0.05, 0.4) / rms(left, 0, 0.05, 0.4) };`);
  t.near(r.ratio, 32 / 127, 0.01, 'volume');
  t.below(r.right, 0.001, 'right channel silent');
}, B);

test('WAV export uses the real engines: FM differs from the plain lead, speech is not silent', async t => {
  const p = await t.page('sequencer.html', { wait: 2000 });
  const r = await render(p, `
    MEM[0x1100] = 60; MEM.set([10, 40, 128, 60], 0x1068);
    MEM[0x115A] = 0; const lead = await bar();
    MEM[0x115A] = 1; const fm = await bar();
    MEM[0x115A] = 3; const lpc = await bar(); MEM[0x115A] = 0;
    const a = lead.getChannelData(0), b = fm.getChannelData(0);
    let d = 0; for (let i = 0; i < 44100; i++) d += Math.abs(a[i] - b[i]);
    return { d, lpc: rms(lpc, 0, 0.05, 0.3) };`);
  t.above(r.d, 100, 'FM sounds different');
  t.above(r.lpc, 0.01, 'speech renders');
}, B);

test('delay: feedback and wet level are separate', async t => {
  const p = await t.page('sequencer.html', { wait: 2000 });
  const r = await render(p, `
    tempo = 60;
    MEM[0x1300] = 1; MEM[0x1310] = 2; MEM[0x1090] = 44; MEM[0x1091] = 1;  // 300 ms
    const echoes = b => [1, 2, 3].map(k => rms(b, 0, 0.05 + k * 0.3, 0.13 + k * 0.3));
    MEM[0x1092] = 0; MEM[0x1093] = 255; const one = echoes(await bar());
    MEM[0x1092] = 230; MEM[0x1093] = 60; const tail = echoes(await bar());
    return { one, tail };`);
  t.above(r.one[0], 0.01, 'a loud first echo');
  t.below(r.one[1], 0.0001, 'and no second one with feedback 0');
  t.above(r.tail[2], 0.002, 'high feedback keeps echoing');
  t.below(r.tail[1], r.tail[0], 'each echo quieter than the last');
}, B);

test('filter envelope follows only the voices in $1084', async t => {
  const p = await t.page('sequencer.html', { wait: 2000 });
  const r = await render(p, `
    MEM[0x1100] = 72; MEM[0x115A] = 0; MEM.set([10, 40, 128, 60], 0x1068);
    MEM[0x1080] = 1; MEM[0x1081] = 10; MEM[0x1082] = 40;
    const closed = bright(await bar(), 0.05, 0.12);
    MEM[0x1083] = 255; MEM[0x1084] = 1; const kickOnly = bright(await bar(), 0.05, 0.12);
    MEM[0x1084] = 4; const lead = bright(await bar(), 0.05, 0.12);
    return { closed, kickOnly, lead };`);
  t.equal(r.kickOnly, r.closed, 'a lead hit does not open a kick-only envelope');
  t.above(r.lead, r.closed * 2, 'the lead bit opens it');
}, B);

test('bitcrush: 2 bits silences a quiet voice; the hidden value keeps it, crunched', async t => {
  const p = await t.page('sequencer.html', { wait: 2000 });
  const r = await render(p, `
    MEM[0x1100] = 72; MEM[0x115A] = 0; MEM.set([10, 40, 128, 60], 0x1068); MEM[0x10B2] = 30;
    const clean = await bar();
    MEM[0x1094] = 2; const two = await bar();
    MEM[0x1094] = 16; const hidden = await bar();
    const x = hidden.getChannelData(0), y = clean.getChannelData(0);
    let e = 0, s = 0; for (let i = 2205; i < 8820; i++) { e += (x[i] - y[i]) ** 2; s += y[i] ** 2; }
    return { clean: rms(clean, 0, 0.05, 0.2), two: rms(two, 0, 0.05, 0.2), hidden: rms(hidden, 0, 0.05, 0.2), distortion: Math.sqrt(e / s), worklet: !!masterCrush };`);
  t.ok(r.worklet, 'the bitcrush worklet loads over http');
  t.below(r.two, 0.0005, '2 bits rounds a quiet voice away');
  t.near(r.hidden, r.clean, r.clean * 0.4, 'the hidden value keeps it audible');
  t.above(r.distortion, 0.08, 'and crunched');
}, B);

test('timeline export renders snapshots, and live audio is restored after any export', async t => {
  const p = await t.page('sequencer.html', { wait: 2000 });
  const r = await p.evaluate(async () => {
    initAudio();
    for (const a of [0x1000, 0x1020, 0x1100, 0x1200, 0x1300]) MEM.fill(0, a, a + 16);
    MEM[0x1000] = 1;
    TIMELINE.snapshots = { 0: { mem: Array.from(MEM.slice(0x1000, 0x1400)) } };
    const buf = await exportTimelineWAV({ returnBuffer: true });
    const d = buf.getChannelData(0); let peak = 0; for (const x of d) peak = Math.max(peak, Math.abs(x));
    return { seconds: buf.duration, peak, live: audioCtx instanceof AudioContext && masterBus === liveChain.gain };
  });
  t.above(r.seconds, 8, 'four bars at the current tempo plus a tail');
  t.above(r.peak, 0.05, 'the snapshot plays');
  t.ok(r.live, 'the live context and master chain are back');
}, B);
