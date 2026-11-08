// The compiler and the WASM sequencer core, run in Node with no browser.
const fs = require('fs');
const path = require('path');
const { test } = require('../lib');
const root = path.join(__dirname, '..', '..');
const C = require(path.join(root, 'compiler.js'));

const SONG = `@title "Arranged"
@tempo 120
@pattern four "x...x...x...x..."
@pattern back "....x.......x..."
@pattern hats "x.x.x.x.x.x.x.x."
@pattern line "C3..C3..D#3.G3.."
@scene intro
  kick: four
@scene full
  kick: four
  snare: back
  noise: hats
  bass: line

@at 0
@play intro
@at 2b
@play full
@tempo 130
@loop start
> 2b
@loop end
`;

// Load a compiled HEX song into the core's memory and play `bars` bars.
// Returns one string per bar: K S L B n for each voice that fired.
async function playBars(hex, bars) {
  const bytes = fs.readFileSync(path.join(root, 'runtime.wasm'));
  let cur = '';
  const hit = ch => () => { cur += ch; };
  const { instance } = await WebAssembly.instantiate(bytes, {
    audio: { triggerKick: hit('K'), triggerSnare: hit('S'), triggerLead: hit('L'), triggerBass: hit('B'), triggerNoise: hit('n') }
  });
  const e = instance.exports;
  e.init();
  const m = new Uint8Array(e.memory.buffer);
  for (const l of hex.split('\n')) {
    if (!l.startsWith(':') || l.slice(7, 9) !== '00') continue;
    const n = parseInt(l.slice(1, 3), 16), a = parseInt(l.slice(3, 7), 16);
    for (let k = 0; k < n; k++) m[a + k] = parseInt(l.slice(9 + 2 * k, 11 + 2 * k), 16);
  }
  e.reset(); e.start();
  const out = [];
  for (let bar = 0; bar < bars; bar++) {
    let line = '';
    for (let s = 0; s < 16; s++) { cur = ''; e.tick(); line += (cur || '.') + ' '; }
    out.push({ line, tempo: e.getTempo(), pos: m[0x1760] | (m[0x1761] << 8) });
  }
  return { out, mem: m };
}

test('a song compiles to all five targets', t => {
  for (const target of ['mtmc16', 'wasm', 'c', 'rust', 'hex']) {
    const r = C.compile(SONG, { target });
    t.ok(r.success, `${target}: ${JSON.stringify(r.errors)}`);
    t.ok(String(r.output).length > 50, `${target} has output`);
  }
});

test('POKE lines: the same bytes as @poke, warnings for out of range and read-only', t => {
  const hex = src => C.compile('@tempo 120\n' + src + '\n@play\n', { target: 'hex' });
  t.equal(hex('POKE $1000, 1').output, hex('@poke $1000 1').output, 'POKE and @poke agree');
  t.ok(hex('@poke $2000 1').warnings.some(w => /outside the REGISTER map/.test(w.msg)), 'out of range warns');
  t.ok(hex('@poke $15F0 1').warnings.some(w => /read-only/i.test(w.msg)), 'read-only warns');
});

test('a line the compiler does not understand is reported, not silently dropped', t => {
  const r = C.compile('@tempo 120\nhello world\n@play\n', { target: 'hex' });
  t.ok(r.warnings.some(w => /Line 2 was skipped/.test(w.msg)), JSON.stringify(r.warnings));
});

test('the core declares CORE and XSONG in CAPS', async t => {
  const r = C.compile(SONG, { target: 'hex' });
  const { mem } = await playBars(r.output, 0);
  const caps = (mem[0x15F0] | (mem[0x15F1] << 8) | (mem[0x15F2] << 16) | (mem[0x15F3] << 24)) >>> 0;
  t.equal(caps, 0x20000001, 'CORE | XSONG');
  t.equal(mem[0x15F4], 1, 'SPEC_VERSION');
});

test('arranger: intro, then the full scene at bar 3 with a tempo change, then a loop', async t => {
  const r = C.compile(SONG, { target: 'hex' });
  const { out } = await playBars(r.output, 7);
  t.ok(!/S|B|n/.test(out[0].line) && /K/.test(out[0].line), 'bar 1 is the intro: kick only');
  t.ok(/S/.test(out[2].line) && /B/.test(out[2].line) && /n/.test(out[2].line), 'bar 3 is the full scene');
  t.equal(out[2].tempo, 130, 'tempo changes with the full scene');
  t.equal(out[4].line, out[6].line, 'the loop repeats the same bar');
  t.ok(out[5].pos < out[4].pos || out[6].pos === out[4].pos, 'JUMP rewrites the song position');
});
