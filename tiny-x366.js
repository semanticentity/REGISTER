/*
 * Tiny x366: part of the MTMC-16's assembly language, run one line at a time
 * against the chip's memory, for the lessons.
 *
 *   const cpu = TinyX366.machine(source, MEM, options)
 *   cpu.errors      problems found before running: [{ line, message }]
 *   cpu.step()      run the next instruction: { line, text, did, reg } or null at the end
 *   cpu.run()       run to the end (or stop after options.limit instructions)
 *   cpu.stopped     why run() gave up, if it did
 *   cpu.regs        AX, BX, CX, DX, and AL, BL, CL, DL
 *   cpu.next()      the line number that runs next, or 0 at the end
 *   cpu.writes      Map of address -> value this run has stored
 *
 * options.ops limits which instructions a lesson allows, and options.labels:
 * false turns labels off, so an early lesson can say what is not there yet.
 * TinyX366.LESSON6 is the set lesson 6 uses. options.guard(address) can
 * return a reason to refuse a store, so a runaway loop can't scribble over
 * settings the page needs.
 *
 * On the MTMC-16, AL is another name for AX (and BL for BX, and so on): the
 * same register. Using the L name says "one byte" when storing to memory.
 * This copies that. Every lesson program was assembled and run on the real
 * emulator with the same result (mtmc.cs.montana.edu, November 2026).
 */
(function (root) {
  const WIDE = ['AX', 'BX', 'CX', 'DX'], BYTE = ['AL', 'BL', 'CL', 'DL'];
  const REG_OF = { AX: 'AX', BX: 'BX', CX: 'CX', DX: 'DX', AL: 'AX', BL: 'BX', CL: 'CX', DL: 'DX' };
  const JUMPS = { JMP: () => true, JE: c => c === 0, JNE: c => c !== 0, JL: c => c < 0, JLE: c => c <= 0, JG: c => c > 0, JGE: c => c >= 0 };
  const ALL = ['MOV', 'ADD', 'SUB', 'INC', 'DEC', 'CMP', 'LOOP', ...Object.keys(JUMPS)];
  const LO = 0x1000, HI = 0x1FFF;
  const hex = n => '0x' + n.toString(16).toUpperCase().padStart(4, '0');
  const signed = v => (v & 0x8000 ? v - 0x10000 : v);
  // Two-byte values that look like addresses read better in hex
  const show = (name, v) => (WIDE.includes(name) && v >= LO ? hex(v) : String(v));
  const inChip = a => `${hex(a)} is outside the chip. REGISTER lives at 0x1000 to 0x1FFF.`;

  function number(s) {
    if (/^\$[0-9a-f]+$/i.test(s)) throw new Error(`x366 writes hex with 0x, so ${s} is 0x${s.slice(1)}.`);
    if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    return null;
  }

  // A register, [address], [register], or a number
  function operand(s) {
    const t = s.trim(), u = t.toUpperCase();
    if (REG_OF[u]) return { reg: u };
    const m = /^\[(.*)\]$/.exec(t);
    if (m) {
      const inner = m[1].trim();
      if (REG_OF[inner.toUpperCase()]) {
        if (!WIDE.includes(inner.toUpperCase())) throw new Error(`An address needs two bytes, so point with BX, not ${inner.toUpperCase()}: [BX].`);
        return { ptr: inner.toUpperCase() };
      }
      const a = number(inner);
      if (a === null) throw new Error(`Inside [ ] goes an address, like [0x1100], or a register holding one, like [BX].`);
      if (a < LO || a > HI) throw new Error(inChip(a));
      return { mem: a };
    }
    const n = number(t);
    if (n === null) throw new Error(`"${t}" is not a register (like AL or BX), an address in [ ], or a number.`);
    return { imm: n };
  }

  function parse(source, options = {}) {
    const ops = options.ops || ALL, labelsOn = options.labels !== false;
    const program = [], errors = [], labels = {}, wanted = [];
    source.split('\n').forEach((raw, i) => {
      const line = i + 1;
      let text = raw.replace(/;.*$/, '').trim();
      if (!text || /^\.MEMORY\b/i.test(text)) return;
      try {
        const lab = /^([A-Za-z_]\w*):\s*(.*)$/.exec(text);
        if (lab) {
          if (!labelsOn) throw new Error('Labels go with jumps, which come in a later lesson. This page runs straight down.');
          if (labels[lab[1]] !== undefined) throw new Error(`The label ${lab[1]} is already used. Each label names one place.`);
          labels[lab[1]] = { at: program.length, line };
          text = lab[2];
          if (!text) return;
        }
        const m = /^([A-Za-z]+)\s*(.*)$/.exec(text);
        const op = m ? m[1].toUpperCase() : '';
        if (!ops.includes(op)) {
          throw new Error(ops === ALL ? `x366 has no "${m ? m[1] : text}" on this page. It knows ${ALL.join(', ')}.`
            : `This page runs ${ops.slice(0, -1).join(', ')} and ${ops[ops.length - 1]}. x366 has more instructions, but not here yet.`);
        }
        const args = m[2].trim();
        const ins = { line, text: raw.trim(), op };
        if (op === 'LOOP' || JUMPS[op]) {
          if (!/^[A-Za-z_]\w*$/.test(args)) throw new Error(`${op} needs the label to jump to: ${op} top.`);
          ins.target = args;
          wanted.push(ins);
        } else if (op === 'INC' || op === 'DEC') {
          const d = operand(args);
          if (!d.reg) throw new Error(`${op} works on a register: ${op} BX.`);
          ins.dst = d;
        } else {
          const parts = args.split(',');
          if (parts.length !== 2 || !parts[1].trim()) throw new Error(`${op} needs two things after it, split by a comma: where to, then what.`);
          const dst = operand(parts[0]), src = operand(parts[1]);
          if (dst.imm !== undefined) throw new Error(`The first thing after ${op} is ${op === 'CMP' ? 'the register to compare' : 'where the result goes'}, so it can't be a number.`);
          const isMem = o => o.mem !== undefined || o.ptr !== undefined;
          if (op === 'MOV' && isMem(dst)) {
            if (!src.reg) throw new Error(`Store to memory from a register: MOV AL, ${src.imm ?? 'a number'} first, then MOV [${dst.ptr || hex(dst.mem)}], AL.`);
            if (!BYTE.includes(src.reg)) throw new Error(`Store one byte with AL, BL, CL or DL. ${src.reg} would store two bytes.`);
          }
          if (op !== 'MOV' && !dst.reg) throw new Error(`${op} works on a register here: ${op} AL, 2.`);
          if (op !== 'MOV' && isMem(src)) throw new Error(`${op} takes a number or a register here, not memory.`);
          const max = dst.reg && BYTE.includes(dst.reg) ? 255 : 65535;
          if (src.imm > max) throw new Error(max === 255 ? `${src.imm} does not fit: ${dst.reg} works with one byte, 0 to 255.` : `${src.imm} does not fit in two bytes.`);
          Object.assign(ins, { dst, src });
        }
        program.push(ins);
      } catch (e) {
        errors.push({ line, message: e.message });
      }
    });
    for (const ins of wanted) {
      const l = labels[ins.target];
      if (!l) errors.push({ line: ins.line, message: `There is no label called ${ins.target}. Labels must match exactly, capitals too.` });
      else if (l.at >= program.length) errors.push({ line: l.line, message: `Put an instruction after the label ${ins.target}. A jump has to land on something.` });
      else ins.to = l.at;
    }
    errors.sort((a, b) => a.line - b.line);
    return { program, errors };
  }

  function machine(source, mem, options = {}) {
    const { program, errors } = parse(source, options);
    const limit = options.limit || 10000;
    const R = {};
    const cpu = { errors, program, writes: new Map(), pc: 0, count: 0, stopped: '' };
    const get = name => (BYTE.includes(name) ? R[REG_OF[name]] & 255 : R[REG_OF[name]]);
    const set = (name, v) => { R[REG_OF[name]] = v & 0xFFFF; };
    cpu.regs = {};
    Object.keys(REG_OF).forEach(n => Object.defineProperty(cpu.regs, n, { get: () => get(n), enumerable: true }));
    let cmp = null;
    cpu.reset = () => { WIDE.forEach(r => { R[r] = 0; }); cpu.writes = new Map(); cpu.pc = 0; cpu.count = 0; cpu.stopped = ''; cmp = null; };
    cpu.next = () => (cpu.pc < program.length && !cpu.stopped ? program[cpu.pc].line : 0);
    const where = o => (o.ptr ? R[o.ptr] : o.mem);
    cpu.step = () => {
      if (errors.length || cpu.stopped || cpu.pc >= program.length) return null;
      const ins = program[cpu.pc++];
      cpu.count++;
      let did, reg = '';
      if (ins.target) {
        const label = ins.target;
        if (ins.op === 'LOOP') {
          const was = R.CX;
          set('CX', was - 1);
          const go = R.CX !== 0;
          did = `CX: ${was} → ${R.CX}, ${go ? `back to ${label}` : 'done, carry on'}`;
          reg = 'CX';
          if (go) cpu.pc = ins.to;
        } else {
          const go = JUMPS[ins.op](cmp === null ? 0 : Math.sign(cmp.a - cmp.b));
          const test = { JE: '=', JNE: '≠', JL: '<', JLE: '≤', JG: '>', JGE: '≥' }[ins.op];
          did = ins.op === 'JMP' ? `jump to ${label}` : `${cmp ? `${cmp.a} ${test} ${cmp.b}` : 'nothing compared yet'}? ${go ? `yes: jump to ${label}` : 'no: carry on'}`;
          if (go) cpu.pc = ins.to;
        }
      } else if (ins.op === 'INC' || ins.op === 'DEC') {
        const r = ins.dst.reg, was = get(r);
        set(r, R[REG_OF[r]] + (ins.op === 'INC' ? 1 : -1));
        did = `${r}: ${show(r, was)} → ${show(r, get(r))}`; reg = REG_OF[r];
      } else {
        const s = ins.src;
        let value;
        if (s.reg) value = get(s.reg);
        else if (s.imm !== undefined) value = s.imm;
        else {
          const a = where(s);
          if (a < LO || a > HI) { cpu.stopped = `line ${ins.line}: ${s.ptr} holds ${hex(a)}. ${inChip(a)}`; return { line: ins.line, text: ins.text, did: 'stopped', reg }; }
          value = mem[a];
        }
        if (ins.dst.reg === undefined) {
          const a = where(ins.dst);
          if (a < LO || a > HI) { cpu.stopped = `line ${ins.line}: ${ins.dst.ptr} holds ${hex(a)}. ${inChip(a)}`; return { line: ins.line, text: ins.text, did: 'stopped', reg }; }
          const no = options.guard && options.guard(a);
          if (no) { cpu.stopped = `line ${ins.line}: ${no}`; return { line: ins.line, text: ins.text, did: 'stopped', reg }; }
          mem[a] = value & 255;
          cpu.writes.set(a, value & 255);
          did = `memory ${hex(a)} = ${value & 255}`;
        } else if (ins.op === 'CMP') {
          const a = get(ins.dst.reg);
          cmp = { a: BYTE.includes(ins.dst.reg) ? a : signed(a), b: s.reg && !BYTE.includes(s.reg) ? signed(value) : value };
          did = `compare ${ins.dst.reg} (${a}) with ${value}`;
        } else {
          const r = ins.dst.reg, was = get(r);
          set(r, ins.op === 'ADD' ? R[REG_OF[r]] + value : ins.op === 'SUB' ? R[REG_OF[r]] - value : value);
          did = ins.op === 'MOV' ? `${r} = ${show(r, get(r))}` : `${r}: ${show(r, was)} → ${show(r, get(r))}`;
          reg = REG_OF[r];
        }
      }
      return { line: ins.line, text: ins.text, did, reg };
    };
    cpu.run = () => {
      const out = [];
      let r;
      while ((r = cpu.step())) {
        out.push(r);
        if (cpu.count >= limit && cpu.next()) {
          cpu.stopped = `Stopped after ${limit.toLocaleString('en-US')} instructions. A jump may be sending the program around forever.`;
          break;
        }
      }
      return out;
    };
    cpu.reset();
    return cpu;
  }

  const api = { machine, parse, REGS: BYTE, WIDE, LESSON6: { ops: ['MOV', 'ADD', 'SUB'], labels: false } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TinyX366 = api;
})(typeof window !== 'undefined' ? window : globalThis);
