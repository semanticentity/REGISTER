// Tiny x366 (tiny-x366.js): the lesson 6 programs give the same memory the
// real MTMC-16 emulator gave for them, and mistakes get a plain message.
const path = require('path');
const { test } = require('../lib');
const root = path.join(__dirname, '..', '..');
const X = require(path.join(root, 'tiny-x366.js'));
const P = require(path.join(root, 'tests', 'fixtures', 'x366-lesson6.json'));

const lead = mem => Array.from({ length: 8 }, (_, i) => mem[0x1100 + 2 * i]);
function run(src) {
  const mem = new Uint8Array(65536);
  const cpu = X.machine(src, mem);
  cpu.run();
  return { mem, cpu };
}

// What mtmc.cs.montana.edu produced for each fixture, November 2026
test('the lesson programs match the real emulator', t => {
  t.equal(lead(run(P.start).mem).join(), '60,62,64,0,0,0,0,0', 'the starting program writes three notes');
  t.equal(lead(run(P.major_c).mem).join(), '60,62,64,65,67,69,71,72', 'C major');
  t.equal(lead(run(P.major_g).mem).join(), '67,69,71,72,74,76,78,79', 'G major: one changed number moves it all');
  t.equal(lead(run(P.down).mem).join(), '72,71,69,67,65,64,62,60', 'down the scale with SUB');
  const b = run(P.bass);
  t.equal(b.mem[0x1200], 36, 'BL copies AL, then drops two octaves');
  t.equal(b.cpu.regs.AL, 60, 'AL is untouched');
  for (const k of Object.keys(P)) t.equal(run(P[k]).mem.slice(0x1101, 0x1110).filter((v, i) => i % 2 === 0).join(''), '00000000', `${k}: byte stores touch nothing next door`);
});

test('one line at a time', t => {
  const mem = new Uint8Array(65536);
  const cpu = X.machine(P.start, mem);
  t.equal(cpu.next(), 1, 'starts on line 1');
  t.equal(cpu.step().did, 'AL = 60', 'MOV loads a register');
  t.equal(cpu.step().did, 'memory 0x1100 = 60', 'MOV stores it');
  t.equal(cpu.step().did, 'AL: 60 → 62', 'ADD changes the register');
  t.equal(cpu.next(), 4, 'line 4 is next');
  cpu.run();
  t.equal(cpu.next(), 0, 'then the end');
  t.equal(cpu.step(), null, 'nothing past the end');
  t.equal([...cpu.writes].map(([a, v]) => `${a.toString(16)}=${v}`).join(' '), '1100=60 1102=62 1104=64', 'it records what it stored');
  cpu.reset();
  t.equal(cpu.regs.AL, 0, 'reset clears the registers');
  t.equal(cpu.writes.size, 0, 'and the record');
});

test('mistakes get a plain message on the right line', t => {
  const err = src => { const e = X.parse(src).errors; return e.length ? `${e[0].line}: ${e[0].message}` : 'none'; };
  t.ok(/^1: .*0x1100/.test(err('MOV [$1100], AL')), 'a $ address says to write 0x');
  t.ok(/^1: Store to memory from a register/.test(err('MOV [0x1100], 60')), 'no storing a number straight to memory');
  t.ok(/^2: This page runs MOV, ADD and SUB/.test(err('MOV AL, 1\nJMP 0')), 'unknown instruction');
  t.ok(/^1: Labels/.test(err('top: MOV AL, 1')), 'labels wait for a later lesson');
  t.ok(/^1: 300 does not fit/.test(err('MOV AL, 300')), 'one byte holds 0 to 255');
  t.ok(/^1: 0x2000 is outside the chip/.test(err('MOV [0x2000], AL')), 'only the chip');
  t.ok(/^1: MOV needs two things/.test(err('MOV AL')), 'missing comma');
  t.ok(/^1: "XL" is not a register/.test(err('MOV XL, 1')), 'not a register');
  t.equal(err('.MEMORY 16K\n; a comment\n\nmov al, 0x3c\nmov [0x1100], al'), 'none', 'the real header, comments, lowercase and hex are fine');
  t.equal(X.machine('MOV AL, 1\nMOV [0x2000], AL', new Uint8Array(65536)).step(), null, 'a program with errors does not run');
});

test('a byte wraps around, like the stored byte on the MTMC-16', t => {
  const { mem } = run('MOV AL, 250\nADD AL, 10\nMOV [0x1100], AL\nMOV BL, 3\nSUB BL, 5\nMOV [0x1101], BL');
  t.equal(mem[0x1100], 4, '250 + 10 stores 4');
  t.equal(mem[0x1101], 254, '3 - 5 stores 254');
});
