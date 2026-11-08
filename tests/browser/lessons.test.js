// The lessons load, fit a phone, and their goals can be completed.
const { test } = require('../lib');
const B = { browser: true };

for (const n of [1, 2, 3]) {
  test(`lesson ${n} loads with no errors and fits a phone`, async t => {
    const p = await t.page(`lesson${n}.html`, { device: 'iPhone 13' });
    t.equal(p.errors, []);
    t.equal(await p.evaluate(() => document.documentElement.scrollWidth), 390);
    t.equal(await p.locator('.k-check.done').count(), 0, 'no goal starts done');
  }, B);
}

test('lesson 1: clicking boxes and POKE lines complete both goals, and it plays', async t => {
  const p = await t.page('lesson1.html');
  for (const s of [0, 4, 8, 12]) await p.click(`#kick .k-cell >> nth=${s}`);
  await p.fill('#poke textarea', 'POKE $1024, 1\nPOKE $102C, 1\nPEEK $102C');
  await p.click('#poke .k-run');
  await p.waitForTimeout(400);
  t.ok(/\$102C = 1/.test(await p.textContent('#poke .k-out')), 'PEEK reads it back');
  t.equal(await p.locator('.k-check.done').count(), 2, 'both goals done');
  await p.click('#play');
  await p.waitForTimeout(1200);
  t.above(await p.evaluate(() => window.__osc), 2, 'the beat plays through the engine');
  t.equal(p.errors, []);
}, B);

test('lesson 2: a byte of switches, hex patterns unpacked into memory, and a bitmask', async t => {
  const p = await t.page('lesson2.html');
  for (const k of [2, 4, 6]) await p.click(`#byte .bit >> nth=${k}`);   // 32 + 8 + 2
  for (const [hex, voice] of [['$8888', '4096'], ['$0808', '4128'], ['$AAAA', '4864']]) {
    await p.fill('#hex-in', hex);
    await p.selectOption('#target', voice);
    await p.click('#load');
  }
  await p.check('#follow input >> nth=0');
  await p.check('#follow input >> nth=2');
  await p.waitForTimeout(500);
  t.equal(await p.evaluate(() => [MEM[0x1000], MEM[0x1004], MEM[0x1001], MEM[0x1084]]), [1, 1, 0, 5]);
  t.equal(await p.locator('.k-check.done').count(), 3, 'all three goals done');
}, B);

test('lesson 3: base plus offset, and one sound on two voices', async t => {
  const p = await t.page('lesson3.html');
  await p.selectOption('#voice', '3');
  t.ok(/\$1060 \+ 3 × 4 \+ 0 = \$106C/.test(await p.textContent('#fields')), 'the bass attack address is worked out');
  await p.evaluate(() => { const i = document.querySelector('#fields input'); i.value = 100; i.dispatchEvent(new Event('input')); });
  await p.selectOption('#target', 'lead'); await p.click('#apply');
  await p.click('#pokes');
  t.ok(/POKE \$1068, 120/.test(await p.textContent('#sound-out')), 'compiles to lead addresses');
  await p.selectOption('#target', 'bass'); await p.click('#apply');
  await p.click('#pokes');
  t.ok(/POKE \$106C, 120/.test(await p.textContent('#sound-out')), 'and to bass addresses');
  await p.waitForTimeout(500);
  t.equal(await p.locator('.k-check.done').count(), 1, 'the shared-envelope goal is done');
  t.equal(p.errors, []);
}, B);
