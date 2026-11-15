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

test('lesson 1: clicking boxes and POKE lines complete all three goals, and it plays', async t => {
  const p = await t.page('lesson1.html');
  t.equal(await p.evaluate(() => [MEM[0x1100], MEM[0x1104], MEM[0x1101]]), [84, 72, 0], 'the click track starts on the beats');
  t.equal(await p.textContent('#clicks .k-grid-label'), 'CLICKS', 'the opening grid shows no addresses yet');
  await p.click('#clicks .k-cell >> nth=2');
  t.equal(await p.evaluate(() => MEM[0x1102]), 67, 'clicking the & adds a click');
  for (const s of [0, 4, 8, 12]) await p.click(`#kick .k-cell >> nth=${s}`);
  await p.fill('#poke textarea', 'POKE $1024, 1\nPOKE $102C, 1\nPEEK $102C');
  await p.click('#poke .k-run');
  await p.waitForTimeout(400);
  t.ok(/\$102C = 1/.test(await p.textContent('#poke .k-out')), 'PEEK reads it back');
  t.equal(await p.locator('.k-check.done').count(), 2, 'four on the floor and the backbeat are done');
  await p.fill('#poke2 textarea', 'POKE $100E, 1');
  await p.click('#poke2 .k-run');
  await p.waitForTimeout(400);
  t.equal(await p.locator('.k-check.done').count(), 3, 'the transfer task is done');
  await p.click('#play');
  await p.waitForTimeout(1200);
  t.above(await p.evaluate(() => window.__osc), 2, 'the beat plays through the engine');
  t.equal(p.errors, []);
}, B);

test('lesson 2: a groove of bits, the tresillo, a byte of switches, and hex one beat per digit', async t => {
  const p = await t.page('lesson2.html');
  const word = base => p.evaluate(b => Array.from({ length: 16 }, (_, s) => MEM[b + s] ? 1 : 0).join(''), base);
  t.equal(await word(0x1300), '1010101010101010', 'the hi-hat opens on eighth notes');
  await p.click('#tresillo');
  t.equal(await word(0x1000), '1000001000001000', 'the tresillo is 1, the & of 2, and 4');
  await p.click('#four');
  t.equal(await word(0x1000), '1000100010001000', 'and back to four on the floor');
  for (const k of [2, 4, 6]) await p.click(`#byte .bit >> nth=${k}`);   // 32 + 8 + 2
  t.ok(/value 42/.test(await p.textContent('#byte-out')), 'the byte reads 42');
  await p.click('#word .bit >> nth=14');
  t.equal(await p.inputValue('#hex-in'), '$080A', 'clicking a step changes that beat\'s hex digit');
  t.equal(await p.textContent('#word .nib-hex >> nth=3'), 'beat 4: A');
  await p.fill('#hex-in', '$080A');
  await p.selectOption('#target', '4128');
  await p.click('#load');
  await p.fill('#hex-in', '$2222');
  await p.selectOption('#target', '4864');
  await p.click('#load');
  await p.waitForTimeout(500);
  t.equal(await word(0x1020), '0000100000001010');
  t.equal(await word(0x1300), '0010001000100010');
  t.equal(await p.locator('.k-check.done').count(), 3, 'all three goals done');
  await p.click('#play');
  await p.waitForTimeout(1200);
  t.above(await p.evaluate(() => window.__osc), 2, 'the groove plays');
  t.equal(p.errors, []);
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
