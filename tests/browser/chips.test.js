// Wavetable voice, parameter locks, their editors, and saving chip settings.
const { test } = require('../lib');
const B = { browser: true };

async function bar(page, setup) {
  return page.evaluate(async src => {
    initAudio();
    await new Promise(r => setTimeout(r, 300));
    tempo = 120; swing = 0;
    for (const a of [0x1000, 0x1020, 0x1100, 0x1200, 0x1300]) MEM.fill(0, a, a + 16);
    MEM.fill(0, 0x1400, 0x14A0); MEM.fill(0, 0x1080, 0x1096); MEM.fill(0, 0x1E00, 0x1E41);
    const rms = (buf, t0, t1) => { const d = buf.getChannelData(0), a = Math.floor(t0 * 44100), z = Math.floor(t1 * 44100); let s = 0; for (let i = a; i < z; i++) s += d[i] * d[i]; return Math.sqrt(s / (z - a)); };
    const render = () => exportWAV(1, { returnBuffer: true });
    return (new Function('MEM', 'render', 'rms', 'return (async () => {' + src + '})()'))(MEM, render, rms);
  }, setup);
}

test('the wave engine plays the 32 bytes at $1A20: a different table, a different sound', async t => {
  const p = await t.page('sequencer.html', { wait: 2500 });
  const r = await bar(p, `
    MEM[0x1100] = 57; MEM[0x115A] = 4; MEM.set([5, 60, 180, 60], 0x1068);
    for (let i = 0; i < 32; i++) MEM[0x1A20 + i] = Math.round(Math.sin(2 * Math.PI * i / 32) * 100) & 255;
    const sine = await render();
    for (let i = 0; i < 32; i++) MEM[0x1A20 + i] = (i < 16 ? 127 : -128) & 255;
    const square = await render();
    const a = sine.getChannelData(0), b = square.getChannelData(0);
    let d = 0; for (let i = 2205; i < 8820; i++) d += Math.abs(a[i] - b[i]);
    return { sine: rms(sine, 0.05, 0.2), square: rms(square, 0.05, 0.2), d };`);
  t.above(r.sine, 0.01, 'the sine table sounds');
  t.above(r.square, r.sine, 'the square table is louder for the same peak');
  t.above(r.d, 20, 'and the waveforms differ');
  t.equal(p.errors, []);
}, B);

test('a parameter lock changes one step only, then puts the byte back', async t => {
  const p = await t.page('sequencer.html', { wait: 2500 });
  const r = await bar(p, `
    MEM[0x1100] = 60; MEM[0x1108] = 60; MEM[0x115A] = 0; MEM.set([5, 40, 180, 40], 0x1068);
    MEM[0x10B2] = 20;                                         // lead quiet
    const plain = await render();
    MEM[0x1E00] = 1; MEM.set([8, 0xB2, 0x10, 127], 0x1E01);   // step 8: LEAD_VOL = 127
    const locked = await render();
    return { s0: rms(locked, 0.06, 0.16) / rms(plain, 0.06, 0.16), s8: rms(locked, 1.06, 1.16) / rms(plain, 1.06, 1.16), after: MEM[0x10B2] };`);
  t.near(r.s0, 1, 0.05, 'step 0 unchanged');
  t.above(r.s8, 4, 'step 8 is much louder');
  t.equal(r.after, 20, 'the byte is restored');
}, B);

test('locks cannot touch the transport, CAPS or the lock table', async t => {
  const p = await t.page('sequencer.html', { wait: 2500 });
  const r = await p.evaluate(() => {
    MEM[0x1E00] = 2; MEM.set([0, 0x00, 0x15, 0], 0x1E01); MEM.set([0, 0x00, 0x1E, 9], 0x1E05);
    const restore = applyLocks(0);
    return { n: restore.length, ctrl: MEM[0x1500], count: MEM[0x1E00] };
  });
  t.equal(r.n, 0, 'both refused');
  t.equal(r.count, 2);
}, B);

test('wave and lock editors write chip memory, and the settings survive a reload', async t => {
  const p = await t.page('sequencer.html', { device: 'iPhone 13', wait: 2500 });
  await p.evaluate(() => { const s = document.getElementById('boot-screen'); if (s) s.remove(); });
  await p.click('#btn-wave');
  await p.waitForTimeout(500);
  await p.click('#wave-panel button[data-shape="square"]');
  t.equal(await p.evaluate(() => [MEM[0x1A20], MEM[0x1A30]]), [127, 128], 'square: +127 then -128');
  const box = await p.locator('#wave-panel canvas').boundingBox();
  await p.mouse.click(box.x + 2, box.y + box.height - 2);          // bottom left: sample 0 near -128
  t.ok(await p.evaluate(() => MEM[0x1A20] > 127), 'drawing writes a negative sample');
  await p.click('#btn-locks');
  await p.waitForTimeout(500);
  await p.selectOption('#locks-panel .ce-step', '12');
  await p.selectOption('#locks-panel .ce-field', String(0x1055));  // SNARE_NOISE_LEVEL
  await p.fill('#locks-panel .ce-value', '230');
  await p.click('#locks-panel .ce-add');
  t.equal(await p.evaluate(() => [MEM[0x1E00], MEM[0x1E01], MEM[0x1E02], MEM[0x1E03], MEM[0x1E04]]), [1, 12, 0x55, 0x10, 230]);
  t.equal(await p.evaluate(() => document.documentElement.scrollWidth), 390, 'fits a phone');
  await p.evaluate(() => saveToLocalStorage());
  await p.reload();
  await p.waitForTimeout(2500);
  t.equal(await p.evaluate(() => [MEM[0x1E00], MEM[0x1E04], MEM[0x1A30]]), [1, 230, 128], 'locks and wave restored');
  t.equal(p.errors, []);
}, B);
