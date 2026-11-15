/*
 * Tiny x366: a few instructions of the MTMC-16's assembly language, run one
 * line at a time against the chip's memory, for the lessons.
 *
 *   const cpu = TinyX366.machine(source, MEM)
 *   cpu.errors      problems found before running: [{ line, message }]
 *   cpu.step()      run the next instruction: { line, text, did } or null at the end
 *   cpu.run()       run to the end
 *   cpu.regs        { AL, BL, CL, DL }
 *   cpu.next()      the line number that runs next, or 0 at the end
 *   cpu.writes      Map of address -> value this run has stored
 *
 * It knows MOV, ADD and SUB on the one-byte registers AL, BL, CL and DL.
 * Every program it accepts also assembles and runs on the real MTMC-16
 * emulator with the same result (mtmc.cs.montana.edu, November 2026).
 */
(function (root) {
  const REGS = ['AL', 'BL', 'CL', 'DL'];
  const OPS = ['MOV', 'ADD', 'SUB'];
  const LO = 0x1000, HI = 0x1FFF;
  const hex = n => '0x' + n.toString(16).toUpperCase().padStart(4, '0');

  function number(s) {
    if (/^\$[0-9a-f]+$/i.test(s)) throw new Error(`x366 writes hex with 0x, so ${s} is 0x${s.slice(1)}.`);
    if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    return null;
  }

  // A register, [address], or a number
  function operand(s) {
    const u = s.trim().toUpperCase();
    if (REGS.includes(u)) return { reg: u };
    const m = /^\[(.*)\]$/.exec(s.trim());
    if (m) {
      const a = number(m[1].trim());
      if (a === null) throw new Error(`Inside [ ] goes an address, like [0x1100].`);
      if (a < LO || a > HI) throw new Error(`${hex(a)} is outside the chip. REGISTER lives at 0x1000 to 0x1FFF.`);
      return { mem: a };
    }
    const n = number(s.trim());
    if (n === null) throw new Error(`"${s.trim()}" is not a register (AL, BL, CL, DL), an address in [ ], or a number.`);
    if (n > 255) throw new Error(`${n} does not fit: a one-byte register holds 0 to 255.`);
    return { imm: n };
  }

  function parse(source) {
    const program = [], errors = [];
    source.split('\n').forEach((raw, i) => {
      const line = i + 1;
      const text = raw.replace(/;.*$/, '').trim();
      if (!text || /^\.MEMORY\b/i.test(text)) return;
      try {
        if (/^[A-Za-z_]\w*:/.test(text)) throw new Error('Labels go with jumps, which come in a later lesson. This page runs straight down.');
        const m = /^([A-Za-z]+)\s*(.*)$/.exec(text);
        const op = m[1].toUpperCase();
        if (!OPS.includes(op)) throw new Error(`This page runs MOV, ADD and SUB. x366 has more instructions, but not here yet.`);
        const parts = m[2].split(',');
        if (parts.length !== 2 || !parts[1].trim()) throw new Error(`${op} needs two things after it, split by a comma: where to, then what.`);
        const dst = operand(parts[0]), src = operand(parts[1]);
        if (dst.imm !== undefined) throw new Error(`The first thing after ${op} is where the result goes, so it can't be a number.`);
        if (op === 'MOV' && dst.mem !== undefined && src.reg === undefined) {
          throw new Error(`Store to memory from a register: MOV AL, ${src.imm ?? 'a number'} first, then MOV [${hex(dst.mem)}], AL.`);
        }
        if (op !== 'MOV' && dst.reg === undefined) throw new Error(`${op} works on a register here: ${op} AL, 2.`);
        if (op !== 'MOV' && src.mem !== undefined) throw new Error(`${op} adds a number or a register here, not memory.`);
        program.push({ line, text: raw.trim(), op, dst, src });
      } catch (e) {
        errors.push({ line, message: e.message });
      }
    });
    return { program, errors };
  }

  function machine(source, mem) {
    const { program, errors } = parse(source);
    const cpu = { errors, program, regs: {}, writes: new Map(), pc: 0 };
    cpu.reset = () => { REGS.forEach(r => { cpu.regs[r] = 0; }); cpu.writes = new Map(); cpu.pc = 0; };
    cpu.next = () => (cpu.pc < program.length ? program[cpu.pc].line : 0);
    cpu.step = () => {
      if (errors.length || cpu.pc >= program.length) return null;
      const ins = program[cpu.pc++];
      const value = ins.src.reg ? cpu.regs[ins.src.reg] : ins.src.mem !== undefined ? mem[ins.src.mem] : ins.src.imm;
      let did;
      if (ins.dst.mem !== undefined) {
        mem[ins.dst.mem] = value;
        cpu.writes.set(ins.dst.mem, value);
        did = `memory ${hex(ins.dst.mem)} = ${value}`;
      } else {
        const r = ins.dst.reg, was = cpu.regs[r];
        cpu.regs[r] = ins.op === 'ADD' ? (was + value) & 255 : ins.op === 'SUB' ? (was - value) & 255 : value;
        did = ins.op === 'MOV' ? `${r} = ${cpu.regs[r]}` : `${r}: ${was} → ${cpu.regs[r]}`;
      }
      return { line: ins.line, text: ins.text, did };
    };
    cpu.run = () => { const out = []; let r; while ((r = cpu.step())) out.push(r); return out; };
    cpu.reset();
    return cpu;
  }

  const api = { machine, parse, REGS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TinyX366 = api;
})(typeof window !== 'undefined' ? window : globalThis);
