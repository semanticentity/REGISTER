// The lessons load, fit a phone, and their goals can be completed.
const { test } = require('../lib');
const B = { browser: true };

for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
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

test('lesson 3: keys with numbers, transposing by arithmetic, and the bass two octaves down', async t => {
  const p = await t.page('lesson3.html');
  const evens = base => p.evaluate(b => Array.from({ length: 8 }, (_, k) => MEM[b + k * 2]), base);
  const ode = [64, 64, 65, 67, 67, 65, 64, 62];
  t.equal(await evens(0x1100), ode, 'the melody opens as Ode to Joy on every other step');
  t.equal(await p.evaluate(() => MEM[0x1101]), 0, 'with rests between');
  t.equal(await p.evaluate(() => MEM[0x1501]), 90, 'at a slower tempo');
  t.equal(await p.locator('#keys1 .key').count(), 13, 'a keyboard from middle C to the C above');
  t.equal(await p.textContent('#keys2 .key >> nth=0'), 'C60', 'the second keyboard shows note numbers');
  await p.click('#keys1 .key >> nth=0');
  await p.waitForTimeout(300);
  t.above(await p.evaluate(() => window.__osc), 0, 'a key plays a note');
  await p.click('#up');
  t.equal((await evens(0x1100))[0], 66, 'HIGHER moves every note up 2');
  await p.click('#orig');
  t.equal(await evens(0x1100), ode, 'ORIGINAL puts it back');
  await p.fill('#poke textarea', ode.map((n, k) => `POKE $${(0x1100 + k * 2).toString(16).toUpperCase()}, ${n + 12}`).join('\n'));
  await p.click('#poke .k-run');
  await p.waitForTimeout(400);
  t.equal(await evens(0x1100), ode.map(n => n + 12), 'POKE lines transpose it up an octave');
  t.ok(/E5/.test(await p.textContent('#names')), 'the names follow: 76 is E5');
  await p.fill('#poke textarea', 'POKE $1100, 300');
  await p.click('#poke .k-run');
  t.ok(/not a byte/.test(await p.textContent('#poke .k-out')), 'a note past 255 is refused');
  await p.fill('#poke2 textarea', ode.map((n, k) => `POKE $${(0x1200 + k * 2).toString(16).toUpperCase()}, ${n - 24}`).join('\n'));
  await p.click('#poke2 .k-run');
  await p.waitForTimeout(500);
  t.equal(await p.locator('.k-check.done').count(), 2, 'both goals done');
  await p.click('#play');
  await p.waitForTimeout(1200);
  t.equal(p.errors, []);
}, B);

test('lesson 4: an envelope you can see, four fields at base plus offset, and a POKE', async t => {
  const p = await t.page('lesson4.html');
  const env = () => p.evaluate(() => [0, 1, 2, 3].map(k => MEM[0x1068 + k]));
  t.equal(await p.evaluate(() => [MEM[0x1100], MEM[0x1102], MEM[0x1501]]), [64, 64, 90], 'the lesson 3 melody, at the slower tempo');
  await p.click('#pluck');
  t.equal(await env(), [0, 30, 0, 30], 'PLUCKED: no attack, no sustain');
  await p.click('#swell');
  t.equal(await env(), [200, 0, 230, 220], 'SLOW SWELL: long attack and release');
  await p.waitForTimeout(300);   // the drawing redraws on a timer
  t.ok(/1\.\d\d s/.test(await p.textContent('#shape2')), 'the drawing shows the swell\'s length');
  t.ok(/\$1068 \+ 3 = \$106B/.test(await p.textContent('#fields')), 'release is worked out as base plus offset');
  await p.click('#pluck');
  await p.evaluate(() => { const i = document.querySelectorAll('#fields input')[1]; i.value = 220; i.dispatchEvent(new Event('input')); });
  t.equal(await env(), [0, 220, 0, 30], 'the decay slider writes $1069');
  await p.fill('#poke textarea', 'POKE $106B, 200');
  await p.click('#poke .k-run');
  await p.waitForTimeout(500);
  t.equal(await p.locator('.k-check.done').count(), 2, 'both goals done');
  await p.evaluate(() => { for (let k = 0; k < 4; k++) MEM[0x1068 + k] = 0; });
  await p.waitForTimeout(300);
  t.ok(/default/.test(await p.textContent('#shape1')), 'all four 0 is drawn as the default shape');
  await p.click('#play');
  await p.waitForTimeout(1200);
  t.above(await p.evaluate(() => window.__osc), 2, 'the melody plays');
  t.equal(p.errors, []);
}, B);

test('lesson 5: doubling, one formula for any voice, a pointer, a compiler, and the volume array', async t => {
  const p = await t.page('lesson5.html');
  const evens = base => p.evaluate(b => Array.from({ length: 8 }, (_, k) => MEM[b + k * 2]), base);
  const ode = [64, 64, 65, 67, 67, 65, 64, 62];
  t.equal(await evens(0x1100), ode, 'the lead plays the melody');
  t.equal(await evens(0x1200), ode.map(n => n - 24), 'and the bass doubles it two octaves down');
  const env = i => p.evaluate(i => [0, 1, 2, 3].map(k => MEM[0x1060 + i * 4 + k]), i);
  t.equal(await env(2), [0, 30, 0, 30], 'the lead starts plucked');
  await p.click('#match');
  t.equal(await env(2), await env(3), 'MATCH THEM gives both the same envelope');
  await p.click('#unmatch');
  t.equal(await env(2), [0, 30, 0, 30], 'UNMATCH puts the pluck back');
  await p.selectOption('#voice', '3');
  t.ok(/\$1060 \+ 3 × 4 \+ 0 = \$106C/.test(await p.textContent('#fields')), 'the bass attack address is worked out');
  await p.evaluate(() => { const i = document.querySelector('#fields input'); i.value = 100; i.dispatchEvent(new Event('input')); });
  await p.waitForTimeout(400);   // goals are checked every 300 ms
  await p.selectOption('#target', 'lead'); await p.click('#apply');
  await p.click('#pokes');
  t.ok(/POKE \$1068, 120/.test(await p.textContent('#sound-out')), 'compiles to lead addresses');
  await p.selectOption('#target', 'bass'); await p.click('#apply');
  await p.click('#pokes');
  t.ok(/POKE \$106C, 120/.test(await p.textContent('#sound-out')), 'and to bass addresses');
  await p.fill('#poke textarea', 'POKE $10B3, 40');
  await p.click('#poke .k-run');
  await p.waitForTimeout(500);
  t.equal(await p.locator('.k-check.done').count(), 3, 'all three goals done');
  await p.click('#play');
  await p.waitForTimeout(1200);
  t.above(await p.evaluate(() => window.__osc), 2, 'the doubled melody plays');
  t.equal(p.errors, []);
}, B);

test('lesson 6: gaps make a scale, a program builds it one line at a time, and only the program meets the goals', async t => {
  const P = require('../fixtures/x366-lesson6.json');
  const p = await t.page('lesson6.html');
  const evens = () => p.evaluate(() => Array.from({ length: 8 }, (_, k) => MEM[0x1100 + k * 2]));
  t.equal(await evens(), [60, 62, 64, 65, 67, 69, 71, 72], 'the lead starts on C major');
  await p.selectOption('#gaps select >> nth=1', '1');
  await p.selectOption('#gaps select >> nth=2', '2');
  t.equal((await evens()).slice(0, 4), [60, 62, 63, 65], 'changing a gap changes the notes after it');
  await p.click('#major');
  t.equal(await evens(), [60, 62, 64, 65, 67, 69, 71, 72], 'MAJOR puts it back');
  await p.waitForTimeout(400);
  t.equal(await p.locator('.k-check.done').count(), 0, 'the scale in memory alone does not meet a goal');

  await p.click('#clear');
  t.equal(await evens(), [0, 0, 0, 0, 0, 0, 0, 0], 'CLEAR LEAD empties the lead');
  for (let i = 0; i < 3; i++) await p.click('#one');
  t.ok(/AL\s*62 D4/.test(await p.textContent('#regs')), 'AL holds 62 after three lines');
  t.equal(await p.textContent('#status'), 'next: line 4', 'line 4 is next');
  t.ok(/AL: 60 → 62/.test(await p.textContent('#trace')), 'the trace shows what ADD did');
  t.equal(await p.evaluate(() => [MEM[0x1100], MEM[0x1102]]), [60, 0], 'only step 0 is stored so far');

  await p.fill('#prog', 'MOV [$1100], AL');
  t.ok(/line 1: x366 writes hex with 0x/.test(await p.textContent('#status')), 'a mistake gets a plain message');

  const run = async src => { await p.fill('#prog', src); await p.click('#all'); await p.waitForTimeout(400); };
  await run(P.major_c);
  t.equal(await p.locator('.k-check.done').count(), 1, 'C major written by the program');
  await run(P.major_g);
  t.equal(await p.locator('.k-check.done').count(), 2, 'one changed line moves it to G');
  t.ok(/F♯5/.test(await p.textContent('#names')), 'and lands on F sharp');
  await run(P.down);
  t.equal(await p.locator('.k-check.done').count(), 3, 'the transfer task, coming down');
  await run(P.major_c + P.bass);
  t.equal(await p.evaluate(() => MEM[0x1200]), 36, 'BL puts the bass two octaves down');
  t.ok(/AL\s*60 C4BL\s*36 C2/.test(await p.textContent('#regs')), 'AL keeps middle C while BL holds the bass note');
  await p.click('#play');
  await p.waitForTimeout(1200);
  t.above(await p.evaluate(() => window.__osc), 2, 'the scale plays');
  t.equal(p.errors, []);
}, B);

test('lesson 7: spreading hits, a counted loop, a branch, and goals only a program can meet', async t => {
  const P = require('../fixtures/x366-lesson7.json');
  const p = await t.page('lesson7.html');
  const row = a => p.evaluate(a => Array.from({ length: 16 }, (_, i) => MEM[a + i]).join(''), a);
  t.equal([await row(0x1000), await row(0x1300)], ['1000100010001000', '1010101010101010'], 'it opens on four on the floor and eighth-note hats');
  t.equal([await p.inputValue('#prog1'), await p.inputValue('#prog2')], [P.hats, P.tresillo], 'the page starts from the tested programs');
  await p.selectOption('#slots', '8');
  await p.selectOption('#hits', '3');
  t.equal(await row(0x1000), '1000001000001000', '3 over 8 is the tresillo, $8208');
  t.equal(await p.textContent('#pattern'), 'x . . x . . x .', 'and reads x . . x . . x .');
  await p.waitForTimeout(400);
  t.equal(await p.locator('.k-check.done').count(), 0, 'the widget alone meets no goal');

  await p.click('#clear1');
  for (let i = 0; i < 7; i++) await p.click('#one1');
  t.ok(/CX\s*7/.test(await p.textContent('#regs1')), 'after one time round, CX is 7');
  t.ok(/CX: 8 → 7, back to again/.test(await p.textContent('#trace1')), 'LOOP goes back');
  t.equal(await row(0x1300), '1010000000000000', 'two hits so far');
  await p.click('#all1');
  t.equal(await row(0x1300), '1010101010101010', 'RUN ALL finishes the row');

  await p.fill('#prog1', P.forever);
  await p.click('#all1');
  t.ok(/line 4: 0x1310 is not on a step row/.test(await p.textContent('#status1')), 'a runaway loop is stopped before it leaves the hi-hat');
  t.equal(await p.evaluate(() => MEM[0x1310]), 0, 'and wrote nothing past it');
  await p.fill('#prog1', 'top:\nJMP top');
  await p.click('#all1');
  t.ok(/Stopped after 10,000 instructions/.test(await p.textContent('#status1')), 'a loop that never stores hits the limit');
  await p.fill('#prog1', 'Hit:\nJMP hit');
  t.ok(/line 2: There is no label called hit/.test(await p.textContent('#status1')), 'label mistakes get a plain message');

  const run = async (n, src) => { await p.fill(`#prog${n}`, src); await p.click(`#all${n}`); await p.waitForTimeout(400); };
  await run(1, P.four);
  t.equal(await p.locator('.k-check.done').count(), 1, 'goal 1: four on the floor from the loop');
  await run(2, P.tresillo);
  t.equal(await row(0x1000), '1000101010001000', 'the tresillo lands on top of what was there');
  await p.click('#clear2');
  await run(2, P.tresillo);
  t.equal(await row(0x1000), '1000001000001000', 'cleared first, it is the tresillo alone');
  t.ok(/CX: 1 → 0, done, carry on/.test(await p.textContent('#trace2')), 'the trace ends where LOOP falls through');
  await run(2, P.five_eight);
  t.equal(await p.locator('.k-check.done').count(), 2, 'goal 2: five over eight');
  await run(2, P.four);
  t.equal(await p.locator('.k-check.done').count(), 2, 'four on the floor without a branch does not count for goal 3');
  await run(2, P.four_euclid);
  t.equal(await p.locator('.k-check.done').count(), 3, 'goal 3: four on the floor as a Euclidean rhythm');
  await p.click('#play');
  await p.waitForTimeout(1200);
  t.above(await p.evaluate(() => window.__osc), 2, 'it plays');
  t.equal(p.errors, []);
}, B);

test('lesson 8: mute and solo are bits of $10AA, OR and AND change one, and the toggle needs a branch', async t => {
  const P = require('../fixtures/x366-lesson8.json');
  const p = await t.page('lesson8.html');
  const mute = () => p.evaluate(() => MEM[0x10AA]);
  t.equal(await mute(), 0, 'every voice starts playing');
  t.equal([await p.inputValue('#prog1'), await p.inputValue('#prog2')], [P.mute_lead, P.unmute_lead], 'the page starts from the tested programs');
  await p.click('[aria-label="Mute kick"]');
  await p.click('[aria-label="Mute bass"]');
  t.equal(await mute(), 0b01001, 'MUTE buttons set bits 0 and 3');
  t.ok(/0b00001001 = 9: muted: kick, bass/.test(await p.textContent('#byte')), 'the byte reads out in binary');
  await p.click('[aria-label="Solo bass"]');
  t.equal(await mute(), 0b10111, 'SOLO mutes everyone else');
  await p.waitForTimeout(300);
  t.equal(await p.getAttribute('[aria-label="Solo bass"]', 'aria-pressed'), 'true', 'and shows as pressed');
  await p.click('[aria-label="Solo bass"]');
  t.equal(await mute(), 0, 'pressing SOLO again brings everyone back');

  await p.click('[aria-label="Mute kick"]');
  for (let i = 0; i < 2; i++) await p.click('#one1');
  t.ok(/AL 00000001\n\s+OR 00000100\n\s+= 00000101/.test(await p.textContent('#trace1')), 'the OR is stacked bit over bit');
  await p.click('#one1');
  t.equal(await mute(), 0b00101, 'the lead is muted and the kick still is');

  const run = async (n, src) => { await p.fill(`#prog${n}`, src); await p.click(`#all${n}`); await p.waitForTimeout(400); };
  await run(1, P.mute_bass_hats);
  t.equal(await mute(), 0b11101, 'bass and hi-hat added, nothing else moved');
  t.equal(await p.locator('.k-check.done').count(), 1, 'goal 1');
  await run(2, P.unmute_lead);
  t.equal(await mute(), 0b11001, 'only the lead came back');
  t.equal(await p.locator('.k-check.done').count(), 2, 'goal 2');

  await run(1, 'MOV AL, 2\nMOV [0x10AA], AL');
  await run(1, 'MOV AL, 0\nMOV [0x10AA], AL');
  t.equal(await p.locator('.k-check.done').count(), 2, 'two different programs that write the byte do not count as a toggle');
  await run(1, 'MOV AL, 1\nMOV [0x10AB], AL');
  t.ok(/only|nowhere else/.test(await p.textContent('#status1')), 'stores outside the mute byte are refused');
  await run(2, P.toggle_snare);
  t.equal(await mute(), 0b00010, 'the toggle mutes a playing snare');
  await run(2, P.toggle_snare);
  t.equal(await mute(), 0, 'and unmutes it the second time');
  t.equal(await p.locator('.k-check.done').count(), 3, 'goal 3, the transfer task');
  await p.click('#play');
  await p.waitForTimeout(1200);
  t.above(await p.evaluate(() => window.__osc), 2, 'it plays');
  t.equal(p.errors, []);
}, B);
