// Every example in llms.txt runs on the real chip and is heard, and the engine
// lists it gives are the ones the engine builds.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { test } = require('../lib');
const B = { browser: true };
const root = path.join(__dirname, '..', '..');
const { engineLists } = require(path.join(root, 'tools/build-llms.js'));
const { probe } = require(path.join(root, 'tools/render.js'));

// ```register hear=lead,bass  and  ```sound hear=lead
function examples() {
  const text = fs.readFileSync(path.join(root, 'llms.txt'), 'utf8');
  return [...text.matchAll(/```(register|sound) hear=([\w,]+)\n([\s\S]*?)```/g)].map(m => ({ kind: m[1], hear: m[2].split(','), body: m[3] }));
}

test('the engine lists in llms.txt are the ones the engine builds', async t => {
  const p = await t.page('sequencer.html', { wait: 2500 });
  t.equal(await p.evaluate(() => SYNTH_IDS), engineLists());
}, B);

test('every example in llms.txt runs, is heard, and plays the notes it wrote', async t => {
  const list = examples();
  t.ok(list.length >= 4, `${list.length} examples`);
  const p = await t.page('sequencer.html', { wait: 2500 });
  const GATE = { kick: '$1000', snare: '$1020', lead: '$1100', bass: '$1200', noise: '$1300' };
  for (const [n, ex] of list.entries()) {
    // A sound sets a voice up; give it a note to play
    const text = ex.kind === 'sound' ? ex.hear.map(v => `POKE ${GATE[v]}, 60`).join('\n') + '\n' + ex.body : ex.body;
    const r = await probe(p, text, { clear: true });
    const label = `example ${n + 1} (${ex.kind} hear=${ex.hear.join(',')})`;
    t.equal(r.ran.filter(x => x.error || (x.skipped && x.skipped.length)), [], `${label}: every line ran`);
    t.equal(r.fault, null, `${label}: no fault`);
    for (const v of ex.hear) {
      t.above(r.voices[v].rms || 0, 0.002, `${label}: ${v} is heard`);
      if (r.voices[v].pitchHz) t.near(r.voices[v].centsOff, 0, 40, `${label}: ${v} at its note or an octave of it (${r.voices[v].pitchHz} Hz for ${r.voices[v].expectHz})`);
    }
    t.ok(!r.mix.clipped, `${label}: no clipping`);
  }
  t.equal(p.errors, []);
}, B);

test('render.js from the command line: JSON a program can check', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
  const song = path.join(dir, 'song.txt');
  fs.writeFileSync(song, 'POKE $1200, 45 ; bass A2\nPOKE BASS_ENGINE pokey\nPOKE POKEY_CLOCK 1.79 MHz\nPOKE LEAD_ENGINE nope\n');
  const out = JSON.parse(execFileSync('node', [path.join(root, 'tools/render.js'), song, '--clear'], { encoding: 'utf8', timeout: 90000 }));
  t.equal(out.voices.bass.engine, 'pokey');
  t.near(out.voices.bass.pitchHz, 110, 3, 'A2 on POKEY at 1.79 MHz is in tune');
  t.ok(/LEAD_ENGINE takes lead, fm/.test(out.ran[3].error), 'a bad value says what the field takes');
  t.ok(out.caps.includes('XPOKEY') && out.fault === null);
}, B);
