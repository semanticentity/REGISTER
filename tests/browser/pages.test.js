// Every page loads cleanly, fits a phone, and plays through the shared engine.
const { test } = require('../lib');
const B = { browser: true };
const PAGES = ['index', 'tweet', 'sequencer', 'pixel', 'debugger', 'arcade', 'tour', 'asm'];

for (const name of PAGES) {
  test(`${name}.html loads with no errors and fits a phone screen`, async t => {
    const p = await t.page(`${name}.html`, { device: 'iPhone 13', wait: name === 'sequencer' ? 2500 : 900 });
    const w = await p.evaluate(() => ({ vw: document.documentElement.clientWidth, doc: document.documentElement.scrollWidth }));
    t.equal(p.errors, [], 'page errors');
    t.ok(w.doc <= w.vw, `page is ${w.doc}px wide on a ${w.vw}px screen`);
  }, B);
}

test('pages also run when opened as a local file', async t => {
  for (const name of ['tweet', 'sequencer', 'pixel', 'debugger']) {
    const p = await t.page(`${name}.html`, { file: true, wait: name === 'sequencer' ? 2500 : 900 });
    t.equal(p.errors, [], `${name} from file://`);
  }
}, B);

test('CAPS tell the truth on each machine', async t => {
  const caps = async (name, wait) => {
    const p = await t.page(`${name}.html`, { wait });
    // CAPS ($15F0) and CAPS_EXT ($15F5, bits 32-63)
    return p.evaluate(() => [0x15F0, 0x15F5].map(a => ((MEM[a] | (MEM[a + 1] << 8) | (MEM[a + 2] << 16) | (MEM[a + 3] << 24)) >>> 0).toString(16)));
  };
  t.equal(await caps('sequencer', 2500), ['c04003ff', '7'], 'sequencer: CORE, XSTEP, XSEQ and the engine packs; XBUS, XPOKEY, XFAULT');
  t.equal(await caps('tweet', 1200), ['e000037f', '6'], 'tweet: CORE and XSONG from the core, plus the engine packs; XPOKEY, XFAULT');
  t.equal(await caps('pixel', 1200), ['e000037f', '6'], 'pixel: the same sound chip');
}, B);

test('the debugger steps through memory and plays through the engine', async t => {
  const p = await t.page('debugger.html');
  for (let i = 0; i < 9; i++) await p.click('#btn-step');
  const r = await p.evaluate(() => ({ osc: window.__osc, step: document.body.innerText.match(/Step: (\d+)/)[1] }));
  t.equal(r.step, '9');
  t.above(r.osc, 5, 'voices made sound');
  t.equal(p.errors, []);
}, B);

test('the console opens with the backtick key and POKE / PEEK work', async t => {
  for (const name of ['tweet', 'sequencer', 'pixel']) {
    const p = await t.page(`${name}.html`, { wait: name === 'sequencer' ? 2500 : 1200 });
    await p.keyboard.press('`');
    await p.waitForTimeout(200);
    const r = await p.evaluate(() => {
      REGISTER.run('POKE $105C, 33');
      return { open: !!document.querySelector('.reg-console.open'), out: REGISTER.run('PEEK $105C') };
    });
    t.ok(r.open, `${name}: console opened`);
    t.ok(/= 33/.test(r.out), `${name}: ${r.out}`);
    t.equal(p.errors, [], name);
  }
}, B);
