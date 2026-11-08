// The tweet player, PIXEL and the sequencer: playback, song structure, visuals.
const { test } = require('../lib');
const B = { browser: true };

for (const mode of ['wasm', 'js']) {
  test(`tweet player (${mode} core): the arranged example plays its intro, drop and live edits`, async t => {
    const p = await t.page('tweet.html', { wait: 300 });
    if (mode === 'js') {
      // Reload with WebAssembly blocked, so the JS fallback core runs
      await p.addInitScript(() => { WebAssembly.instantiate = () => Promise.reject(new Error('blocked')); });
      await p.reload();
    }
    await p.waitForTimeout(700);
    const engine = await p.textContent('#engine');
    t.ok(mode === 'wasm' ? /runtime\.wasm/.test(engine) : /JS fallback/.test(engine), engine);
    await p.click('.example:has-text("arranged")');
    const snap = () => p.evaluate(() => {
      const m = core.mem;
      return { pos: m[0x1760] | (m[0x1761] << 8), tempo: m[0x1501], snare: Array.from(m.slice(0x1020, 0x1030)).join(''), bass: m[0x1200], osc: window.__osc };
    });
    await p.waitForTimeout(1200);
    const intro = await snap();
    await p.waitForTimeout(4200);
    const drop = await snap();
    t.equal(intro.snare, '0000000000000000', 'no snare in the intro');
    t.equal(drop.snare, '0000100000001000', 'snare in the drop');
    t.equal(drop.tempo, 124, 'tempo change');
    t.above(drop.osc, 10, 'the engine made sound');
    await p.evaluate(() => {
      const el = document.getElementById('input');
      el.value = el.value.replace('@pattern back "....x.......x..."', '@pattern back "....x.......xx.x"');
      el.dispatchEvent(new Event('input'));
    });
    await p.waitForTimeout(300);
    t.equal((await snap()).snare, '0000100000001101', 'a live edit lands mid-song');
    await p.click('#btn-stop');
    t.equal(p.errors, []);
  }, B);
}

test('tweet player: a sound setting is heard (lead on FM uses the FM engine)', async t => {
  const p = await t.page('tweet.html');
  const r = await p.evaluate(async () => {
    initAudio();
    MEM[0x1502] = 0; MEM[0x1100] = 60; MEM[0x115A] = 0;
    let before = window.__osc; audioImports.triggerLead(); const plain = window.__osc - before;
    MEM[0x115A] = 1;
    before = window.__osc; audioImports.triggerLead(); const fm = window.__osc - before;
    return { plain, fm };
  });
  t.above(r.fm, r.plain, `FM builds more oscillators (${r.fm} vs ${r.plain})`);
}, B);

test('PIXEL: the picture follows the song and the chip clock', async t => {
  const p = await t.page('pixel.html', { wait: 1200 });
  await p.click('#btn-play');
  const seen = new Set(), sums = new Set();
  for (let i = 0; i < 24; i++) {
    await p.waitForTimeout(120);
    const s = await p.evaluate(() => {
      let sum = 0; for (let i = 0x3000; i < 0x4000; i++) sum += mem[i];
      return { step: mem[0x1502], sum };
    });
    seen.add(s.step); sums.add(s.sum);
  }
  await p.click('#btn-stop');
  t.above(seen.size, 8, 'the song steps');
  t.above(sums.size, 5, 'the framebuffer changes');
  t.equal(p.errors, []);
}, B);

test('PIXEL: the mini view follows you down the page and back', async t => {
  const p = await t.page('pixel.html', { device: 'iPhone 13', wait: 1200 });
  const shown = () => p.evaluate(() => document.getElementById('mini').classList.contains('show'));
  t.ok(!(await shown()), 'hidden at the top');
  await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await p.waitForTimeout(500);
  t.ok(await shown(), 'shown when the big picture is off screen');
  await p.click('#mini-screen');
  await p.waitForTimeout(900);
  t.ok(!(await shown()), 'tapping it scrolls back up');
}, B);

test('sequencer: plays live through the shared engine, with bitcrush ready', async t => {
  const p = await t.page('sequencer.html', { wait: 2500 });
  await p.evaluate(() => { const s = document.getElementById('boot-screen'); if (s) s.remove(); togglePlay(); });
  await p.waitForTimeout(2000);
  const r = await p.evaluate(() => ({ playing: isPlaying, steps: totalSteps, osc: window.__osc, crush: !!masterCrush }));
  await p.evaluate(() => togglePlay());
  t.ok(r.playing && r.steps > 8, `stepped ${r.steps}`);
  t.above(r.osc, 10, 'voices sounded');
  t.ok(r.crush, 'bitcrush worklet in the chain');
  t.equal(p.errors, []);
}, B);

test('sequencer: songs saved with the old ignored drum envelope load as neutral', async t => {
  const p = await t.page('sequencer.html', { wait: 2500 });
  await p.evaluate(() => {
    const d = { version: '1010seq-v2', tempo: 120, swing: 0, currentScene: 0, scenes: SCENES.map(s => Array.from(s)) };
    d.scenes[0].splice(0x60, 4, 5, 20, 0, 50);   // the old kick slider defaults
    d.scenes[0][0x68] = 33;                      // a real lead setting, kept
    localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
  });
  await p.reload();
  await p.waitForTimeout(2500);
  const r = await p.evaluate(() => [MEM[0x1060], MEM[0x1061], MEM[0x1062], MEM[0x1063], MEM[0x1068]]);
  t.equal(r, [0, 0, 255, 255, 33]);
}, B);

test('sequencer: unison spreads copies of a note in cents', async t => {
  const p = await t.page('sequencer.html', { wait: 2500 });
  const r = await p.evaluate(() => {
    initAudio();
    const freqs = [];
    const real = AudioParam.prototype.setValueAtTime;
    AudioParam.prototype.setValueAtTime = function (v, tt) { freqs.push(Math.round(v * 100) / 100); return real.call(this, v, tt); };
    MEM[0x115A] = 0; MEM[0x105C] = 30; MEM[0x105D] = 5;
    const before = window.__osc;
    playLead(audioCtx.currentTime + 0.1, 69, 0);
    AudioParam.prototype.setValueAtTime = real;
    MEM[0x105C] = 0; MEM[0x105D] = 0;
    return { osc: window.__osc - before, has440: freqs.includes(440), spread: freqs.filter(f => f > 420 && f < 460).length };
  });
  t.equal(r.osc, 10, 'five copies, two oscillators each');
  t.ok(r.has440, 'the middle copy is in tune');
}, B);
