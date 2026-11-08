// Debugger: breakpoints stop before a step, watchpoints stop when a byte changes.
const { test } = require('../lib');
const B = { browser: true };

test('a breakpoint stops the chip before it reads that step, and PLAY resumes past it', async t => {
  const p = await t.page('debugger.html');
  await p.evaluate(() => { mem[0x1501] = 200; });       // fast, so the test is quick
  await p.click('#header-4');
  await p.click('#btn-play');
  await p.waitForTimeout(800);
  t.equal(await p.textContent('#current-step'), '4', 'stopped at step 4');
  t.ok(/BREAK at step 4/.test(await p.textContent('#event-log')), 'logged');
  t.ok(await p.isEnabled('#btn-play'), 'can resume');
  await p.click('#btn-play');
  await p.waitForTimeout(300);
  await p.click('#btn-stop');
  t.ok(Number(await p.textContent('#current-step')) !== 4, 'resumed past the breakpoint');
  t.equal(p.errors, []);
}, B);

test('a watchpoint stops the chip when a byte changes, even from a console POKE', async t => {
  const p = await t.page('debugger.html');
  await p.evaluate(() => { mem[0x1501] = 200; });
  await p.click('.mem-byte >> nth=6');                   // KICK gate, step 6: $1006
  await p.click('#btn-play');
  await p.waitForTimeout(200);
  await p.evaluate(() => REGISTER.run('POKE $1006, 1'));
  await p.waitForTimeout(300);
  t.ok(/WATCH \$1006 changed 0 → 1/.test(await p.textContent('#event-log')), await p.textContent('#event-log'));
  t.ok(await p.isEnabled('#btn-play'), 'paused');
  t.equal(p.errors, []);
}, B);

test('clicking a grid cell writes its gate byte', async t => {
  const p = await t.page('debugger.html');
  await p.click('#btn-load');                           // four on the floor
  await p.click('#cell-lead-3');
  await p.click('#cell-kick-0');
  t.equal(await p.evaluate(() => [mem[0x1103], mem[0x1000]]), [60, 0]);
}, B);
