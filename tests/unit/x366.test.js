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
  const err = (src, o = X.LESSON6) => { const e = X.parse(src, o).errors; return e.length ? `${e[0].line}: ${e[0].message}` : 'none'; };
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

// Lesson 7: labels, jumps, LOOP and branches. Step counts and memory are what
// mtmc.cs.montana.edu gave for the same programs, November 2026.
const P7 = require(path.join(root, 'tests', 'fixtures', 'x366-lesson7.json'));
const row = (mem, a) => Array.from(mem.slice(a, a + 16)).join('');

test('the lesson 7 programs match the real emulator, step for step', t => {
  const want = {
    hats: [27, '0000000000000000', '1010101010101010'],
    four: [15, '1000100010001000', '0000000000000000'],
    tresillo: [50, '1000001000001000', '0000000000000000'],
    five_eight: [54, '1000100010100010', '0000000000000000'],
    four_euclid: [92, '1000100010001000', '0000000000000000'],
  };
  for (const [k, [steps, kick, hat]] of Object.entries(want)) {
    const mem = new Uint8Array(65536);
    const cpu = X.machine(P7[k], mem);
    t.equal(cpu.errors, [], `${k}: no errors`);
    t.equal(cpu.run().length, steps, `${k}: ${steps} instructions, like the MTMC-16`);
    t.equal([row(mem, 0x1000), row(mem, 0x1300)], [kick, hat], `${k}: the same hits`);
  }
  t.equal(row((() => { const m = new Uint8Array(65536); X.machine(P7.tresillo, m).run(); return m; })(), 0x1000), '1000001000001000', 'three numbers and a branch give lesson 2\'s tresillo, $8208');
});

test('LOOP counts CX down and jumps back while it is not 0', t => {
  const mem = new Uint8Array(65536);
  const cpu = X.machine(P7.hats, mem);
  const trace = cpu.run().map(r => r.did);
  t.equal(trace.filter(d => /back to again/.test(d)).length, 7, 'seven jumps back for eight hits');
  t.equal(trace[trace.length - 1], 'CX: 1 → 0, done, carry on', 'the last LOOP falls through');
  t.equal(cpu.regs.BX, 0x1310, 'BX ends past the last hit');
});

test('a branch reports its test', t => {
  const cpu = X.machine(P7.tresillo, new Uint8Array(65536));
  const did = cpu.run().map(r => r.did);
  t.ok(did.includes('8 < 8? no: carry on'), 'a full jar falls through to the hit');
  t.ok(did.includes('6 < 8? yes: jump to skip'), 'a jar that is not full skips the hit');
  t.ok(did.includes('compare DL (8) with 8'), 'CMP shows both sides');
});

test('a loop with no way out is stopped, and a guard keeps stores in bounds', t => {
  const mem = new Uint8Array(65536);
  const guard = a => (a >= 0x1300 && a < 0x1310 ? null : `BX points past the hi-hat's 16 steps.`);
  const cpu = X.machine(P7.forever, mem, { guard });
  cpu.run();
  t.ok(/line 4: BX points past/.test(cpu.stopped), 'the guard stops the store at 0x1310');
  t.equal(mem[0x1310], 0, 'and nothing was written there');
  t.equal(cpu.next(), 0, 'a stopped program has no next line');
  const spin = X.machine('top:\nJMP top', mem, { limit: 500 });
  spin.run();
  t.ok(/^Stopped after 500 instructions/.test(spin.stopped), 'a loop with no stores hits the limit');
  const zero = X.machine('MOV CX, 0\nx:\nINC AX\nLOOP x', mem, { limit: 300 });
  zero.run();
  t.ok(zero.stopped, 'LOOP with CX at 0 wraps to 65535 and keeps going, as on the MTMC-16');
});

test('on the MTMC-16, BL and BX are one register', t => {
  const { cpu } = run('MOV BX, 0x1000\nMOV BL, 5');
  t.equal(cpu.regs.BX, 5, 'writing BL sets BX, as the emulator does');
});

test('jump mistakes get a plain message', t => {
  const err = src => { const e = X.parse(src).errors; return e.length ? `${e[0].line}: ${e[0].message}` : 'none'; };
  t.ok(/^2: There is no label called hit/.test(err('Hit:\nJMP hit')), 'labels match exactly, capitals too');
  t.ok(/^3: The label a is already used/.test(err('a:\nINC AX\na:\nINC AX')), 'a label names one place');
  t.ok(/^2: Put an instruction after the label end/.test(err('JMP end\nend:')), 'a jump has to land on something');
  t.ok(/^1: LOOP needs the label/.test(err('LOOP')), 'LOOP needs a label');
  t.ok(/^1: Store one byte/.test(err('MOV [BX], AX')), 'stores are bytes');
  t.ok(/^1: An address needs two bytes/.test(err('MOV [BL], AL')), 'point with a two-byte register');
  t.ok(/^1: x366 has no "PUSH" on this page/.test(err('PUSH AX')), 'instructions this page does not run');
  t.equal(err('top: MOV AL, 1\nJMP top'), 'none', 'a label can share a line with an instruction');
});

// Lesson 8: AND and OR on the mute byte. Each program was run on
// mtmc.cs.montana.edu from the same four starting bytes, November 2026.
const P8 = require(path.join(root, 'tests', 'fixtures', 'x366-lesson8.json'));

test('the lesson 8 programs match the real emulator from every starting byte', t => {
  const want = {
    mute_lead: ['0->4', '3->7', '6->6', '21->21', 3],
    mute_bass_hats: ['0->24', '3->27', '6->30', '21->29', 3],
    unmute_lead: ['0->0', '3->3', '6->2', '21->17', 3],
    solo_bass: ['0->23', '3->23', '6->23', '21->23', 4],
  };
  for (const [k, w] of Object.entries(want)) {
    const got = [0, 3, 6, 21].map(pre => {
      const mem = new Uint8Array(65536); mem[0x10AA] = pre;
      const cpu = X.machine(P8[k], mem);
      t.equal(cpu.run().length, w[4], `${k} from ${pre}: ${w[4]} instructions`);
      return `${pre}->${mem[0x10AA]}`;
    });
    t.equal(got, w.slice(0, 4), k);
  }
  const toggle = [0, 3, 6, 21].map(pre => { const mem = new Uint8Array(65536); mem[0x10AA] = pre; const n = X.machine(P8.toggle_snare, mem).run().length; return `${pre}->${mem[0x10AA]} (${n})`; });
  t.equal(toggle, ['0->2 (7)', '3->1 (8)', '6->4 (8)', '21->23 (7)'], 'the snare toggle flips bit 1 only, either way');
});

test('AND and OR show their work in binary, and 0b numbers read as binary', t => {
  const mem = new Uint8Array(65536); mem[0x10AA] = 3;
  const did = X.machine(P8.mute_lead, mem).run().map(r => r.did);
  t.equal(did[1], 'AL: 00000011 OR 00000100 = 00000111', 'OR, bit by bit');
  const and = X.machine(P8.unmute_lead, mem).run().map(r => r.did);
  t.equal(and[1], 'AL: 00000111 AND 00011011 = 00000011', 'AND, bit by bit');
  t.ok(/no _ in them: write 0b11/.test(X.parse('MOV AL, 0b1_1').errors[0].message), 'the real assembler misreads 0b1_1, so it is refused');
  t.ok(/^This page runs MOV, ADD and SUB/.test(X.parse('AND AL, 1', X.LESSON6).errors[0].message), 'lesson 6 still stops at three instructions');
});
