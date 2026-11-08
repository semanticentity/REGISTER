// Downloads: MIDI export writes a valid file with the pattern's notes.
const fs = require('fs');
const { test } = require('../lib');
const B = { browser: true };

function parseMidi(buf) {
  const str = (o, n) => buf.toString('latin1', o, o + n);
  if (str(0, 4) !== 'MThd') throw new Error('no MThd header');
  const tracks = buf.readUInt16BE(10);
  let o = 8 + buf.readUInt32BE(4);
  const notesOn = [];
  for (let k = 0; k < tracks; k++) {
    if (str(o, 4) !== 'MTrk') throw new Error(`track ${k} has no MTrk`);
    const len = buf.readUInt32BE(o + 4);
    const end = o + 8 + len;
    let p = o + 8, status = 0;
    while (p < end) {
      while (buf[p] & 0x80) p++; p++;                      // delta time (variable length)
      let b = buf[p];
      if (b === 0xFF) { const l = buf[p + 2]; p += 3 + l; continue; }
      if (b & 0x80) { status = b; p++; }
      const type = status & 0xF0;
      if (type === 0x90 && buf[p + 1] > 0) notesOn.push({ ch: status & 15, note: buf[p] });
      p += (type === 0xC0 || type === 0xD0) ? 1 : 2;
    }
    o = end;
  }
  return { tracks, notesOn };
}

test('MIDI export: a valid file with one note-on per gate', async t => {
  const p = await t.page('sequencer.html', { wait: 2500 });
  await p.evaluate(() => {
    tempo = 120;
    for (const a of [0x1000, 0x1020, 0x1100, 0x1200, 0x1300]) MEM.fill(0, a, a + 16);
    [0, 4, 8, 12].forEach(i => { MEM[0x1000 + i] = 1; });     // kick
    MEM[0x1100] = 60; MEM[0x1104] = 64;                       // lead C4, E4
  });
  const [download] = await Promise.all([p.waitForEvent('download'), p.evaluate(() => exportMIDI(1))]);
  t.ok(/^register_120bpm_1bars\.mid$/.test(download.suggestedFilename()), download.suggestedFilename());
  const midi = parseMidi(fs.readFileSync(await download.path()));
  const kicks = midi.notesOn.filter(n => n.ch === 9);
  const lead = midi.notesOn.filter(n => n.ch !== 9).map(n => n.note);
  t.equal(kicks.length, 4, 'four kicks on the drum channel');
  t.ok(lead.includes(60) && lead.includes(64), `lead notes ${lead}`);
  t.equal(p.errors, []);
}, B);
