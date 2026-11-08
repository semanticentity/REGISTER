// The sounds drawer on every page that has one.
const { test } = require('../lib');
const B = { browser: true };

test('sequencer: starter, apply with preview, save, duplicate, retarget, delete, share link', async t => {
  const p = await t.page('sequencer.html', { device: 'iPhone 13', wait: 2500 });
  await p.evaluate(() => { const s = document.getElementById('boot-screen'); if (s) s.remove(); });
  await p.evaluate(() => openSounds('lead'));
  await p.waitForTimeout(500);
  t.ok(/^SOUND lead sound/.test(await p.inputValue('.snd-text')), 'opens on the voice as it sounds now');

  await p.click('.snd-starters button:has-text("Slow Pad")');
  const osc0 = await p.evaluate(() => window.__osc);
  await p.click('.snd-apply');
  await p.waitForTimeout(300);
  t.equal(await p.textContent('.snd-report'), '7 set on lead.');
  t.equal(await p.evaluate(() => [MEM[0x1068], MEM[0x10B2], MEM[0x105C], MEM[0x105D]]), [140, 90, 18, 5]);
  t.equal(await p.inputValue('#adsr-lead-a'), '140', 'the slider follows memory');
  t.above(await p.evaluate(() => window.__osc) - osc0, 0, 'APPLY plays a preview');

  await p.click('.snd-save');
  await p.click('.snd-mine button:has-text("DUP")');
  const names = () => p.evaluate(() => [...document.querySelectorAll('.snd-mine .nm')].map(b => b.textContent));
  t.equal(await names(), ['Slow Pad (mine)', 'Slow Pad (mine) copy'], 'a template saves as your own copy');

  await p.selectOption('.snd-voice', 'kick');
  await p.click('.snd-apply');
  t.ok(/5 set on kick\. skipped 2: UNISON_SPREAD, UNISON_COUNT/.test(await p.textContent('.snd-report')), 'kick skips unison');

  await p.click('.snd-mine button:has-text("DEL") >> nth=0');
  await p.click('.snd-mine button:has-text("SURE?") >> nth=0');
  t.equal(await names(), ['Slow Pad (mine) copy'], 'delete takes two taps');
  t.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('register.sounds.v1')).map(s => s.name)), ['Slow Pad (mine) copy'], 'kept in the browser');

  const shared = await p.evaluate(() => location.href.split('#')[0] + '#sound=' + RegisterSounds.encodeShare('SOUND Linked\nA = 7'));
  const q = await t.page(shared.replace(/^http:\/\/[^/]+\//, ''), { wait: 2500 });
  t.equal(await q.evaluate(() => document.querySelector('.snd-text').value), 'SOUND Linked\nA = 7', 'a share link opens the sound');
  t.equal(await p.evaluate(() => document.documentElement.scrollWidth), 390, 'fits a phone');
  t.equal(p.errors, []);
}, B);

for (const page of ['tweet', 'pixel']) {
  test(`${page}: the drawer applies a SID sound on the shared engine`, async t => {
    const p = await t.page(`${page}.html`, { device: 'iPhone 13', wait: 1200 });
    await p.click('#btn-sounds');
    await p.waitForTimeout(300);
    await p.click('.snd-starters button:has-text("Fat Saw")');
    const osc0 = await p.evaluate(() => window.__osc);
    await p.click('.snd-apply');
    await p.waitForTimeout(300);
    t.equal(await p.textContent('.snd-report'), '13 set on lead. shared sid chip changed for every voice on it.');
    t.equal(await p.evaluate(() => [MEM[0x115A], MEM[0x1A00]]), [2, 1], 'lead on SID, osc 1 a saw');
    t.above(await p.evaluate(() => window.__osc) - osc0, 0, 'preview played');
    t.equal(await p.evaluate(() => document.documentElement.scrollWidth), 390, 'fits a phone');
    t.equal(p.errors, []);
  }, B);
}
