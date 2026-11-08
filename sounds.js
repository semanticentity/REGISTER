/*
 * REGISTER sounds: portable, by field name.
 *
 * A sound is text. Each line sets one field by name, not by address:
 *
 *   SOUND Warm Pad
 *   FROM lead
 *   A = 120
 *   UNISON_SPREAD = 18
 *
 * The voice you load it onto supplies the base address, the way a pointer
 * supplies the base of a struct. LEAD_A and BASS_A are both "A", so the same
 * sound lands on either voice.
 *
 * Fields come in three blocks, all worked out from memory-map.json:
 *   1. every voice has these   (engine, envelope, tune, volume, pan, velocity)
 *   2. only some voices have these   (unison, drum character)
 *   3. a chip's settings       (FM, SID, speech: one patch for the whole chip;
 *                                POKEY: a channel per voice). These apply only
 *                                when the voice is on that engine.
 *
 * Loading a sound writes what the voice and the machine support and skips the
 * rest with a reason. That is design rule 2: unknown regions are ignored, not
 * errors. Nothing here plays audio; it only reads and writes bytes.
 */
(function (global) {
  'use strict';

  const VOICES = ['kick', 'snare', 'lead', 'bass', 'noise'];
  const SKIP_TYPES = ['steps', 'readonly', 'table'];
  const STORE_KEY = 'register.sounds.v1';

  const hex = a => '$' + a.toString(16).toUpperCase();

  function fieldSize(f) {
    if (f.type === 'u16') return 2;
    if (f.type === 'steps') return 16;
    if (f.type === 'readonly' || f.type === 'table') return f.size || 1;
    return 1;
  }

  // ============ INDEX: what the map says a voice has ============
  function buildIndex(map) {
    const voiceFields = {};
    VOICES.forEach(v => { voiceFields[v] = {}; });
    const banks = {};       // pack -> { NAME: {f, addr} }
    const byAddr = {};      // addr -> { voice, generic } or { pack, name }
    const engineBanks = {};
    Object.entries(map.engine_banks || {}).forEach(([k, v]) => { if (k[0] !== '_') engineBanks[k] = v; });
    const bankPacks = new Set(Object.values(engineBanks));

    for (const r of map.regions) {
      if (!r.fields) continue;
      let addr = parseInt(r.start, 16);
      for (const f of r.fields) {
        const size = fieldSize(f);
        // A table in a chip bank (a wavetable, say) travels with the sound as hex bytes
        const bankTable = f.type === 'table' && bankPacks.has(r.pack) && !/RESERVED/.test(f.name);
        if (!SKIP_TYPES.includes(f.type) || bankTable) {
          const voice = VOICES.find(v => f.name.startsWith(v.toUpperCase() + '_'));
          if (voice) {
            const generic = f.name.slice(voice.length + 1);
            voiceFields[voice][generic] = { f, addr, pack: r.pack };
            for (let i = 0; i < size; i++) byAddr[addr + i] = { voice, generic };
          } else if (bankPacks.has(r.pack)) {
            (banks[r.pack] = banks[r.pack] || {})[f.name] = { f, addr, pack: r.pack };
            for (let i = 0; i < size; i++) byAddr[addr + i] = { pack: r.pack, name: f.name };
          }
        }
        addr += size;
      }
    }
    // Block 1 is what all five voices share; block 2 is the rest
    const counts = {};
    VOICES.forEach(v => Object.entries(voiceFields[v]).forEach(([g, slot]) => { if (!bankPacks.has(slot.pack)) counts[g] = (counts[g] || 0) + 1; }));
    const everyVoice = new Set(Object.keys(counts).filter(g => counts[g] === VOICES.length));
    return { map, voiceFields, banks, byAddr, engineBanks, everyVoice };
  }

  // ============ VALUES: bytes <-> readable text ============
  function readValue(f, mem, addr, voice, engineOptions) {
    const raw = mem[addr];
    switch (f.type) {
      case 's8': return String(raw > 127 ? raw - 256 : raw);
      case 'u16': return String(raw | (mem[addr + 1] << 8));
      case 'cents128': return raw === 0 ? 'none' : String(raw - 128);
      case 'enum': return f.options[raw] !== undefined ? f.options[raw] : String(raw);
      case 'engine': {
        const opts = engineOptions ? engineOptions(voice) || [] : [];
        return opts[raw] !== undefined ? opts[raw] : String(raw);
      }
      case 'table': return Array.from(mem.subarray(addr, addr + (f.size || 1)), b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
      default: return String(raw);
    }
  }

  // Returns { bytes: [..] } or { why: '...' }
  function encodeValue(f, text, voice, engineOptions) {
    const s = text.trim();
    const int = () => (/^[-+]?\d+$/.test(s) ? parseInt(s, 10) : NaN);
    const range = (n, lo, hi) => (n >= lo && n <= hi ? null : `${s} is outside ${lo} to ${hi}`);
    let n, why;
    switch (f.type) {
      case 'u8': case 'bits':
        n = int(); if (isNaN(n)) return { why: `"${s}" is not a number` };
        why = range(n, f.min !== undefined ? f.min : 0, f.max !== undefined ? f.max : 255);
        return why ? { why } : { bytes: [n] };
      case 's8':
        n = int(); if (isNaN(n)) return { why: `"${s}" is not a number` };
        why = range(n, f.min !== undefined ? f.min : -128, f.max !== undefined ? f.max : 127);
        return why ? { why } : { bytes: [n & 255] };
      case 'u16':
        n = int(); if (isNaN(n)) return { why: `"${s}" is not a number` };
        why = range(n, 0, 65535);
        return why ? { why } : { bytes: [n & 255, (n >> 8) & 255] };
      case 'cents128':
        if (/^none$/i.test(s)) return { bytes: [0] };
        n = int(); if (isNaN(n)) return { why: `"${s}" is not a number of cents` };
        why = range(n, f.min !== undefined ? f.min : -128, f.max !== undefined ? f.max : 127);
        return why ? { why } : { bytes: [(n + 128) & 255] };
      case 'enum': {
        const i = f.options.findIndex(o => o.toLowerCase() === s.toLowerCase());
        if (i >= 0) return { bytes: [i] };
        n = int();
        if (!isNaN(n) && n >= 0 && n < f.options.length) return { bytes: [n] };
        return { why: `"${s}" is not one of: ${f.options.join(', ')}` };
      }
      case 'engine': {
        const opts = engineOptions ? engineOptions(voice) || [] : [];
        const i = opts.findIndex(o => o.toLowerCase() === s.toLowerCase());
        if (i >= 0) return { bytes: [i] };
        return { why: `${voice} has no ${s} engine; it has ${opts.join(', ') || 'none listed'}` };
      }
      case 'table': {
        const hexes = s.replace(/\$/g, '').split(/[\s,]+/).filter(Boolean);
        if (hexes.length !== (f.size || 1) || !hexes.every(h => /^[0-9a-f]{1,2}$/i.test(h))) {
          return { why: `needs ${f.size} hex bytes, like 00 7F 80 ...` };
        }
        return { bytes: hexes.map(h => parseInt(h, 16)) };
      }
      default:
        return { why: `${f.type} fields are not part of a sound` };
    }
  }

  // ============ PARSE ============
  function parse(text) {
    const out = { name: '', from: '', entries: [], bad: [] };
    for (const raw of String(text || '').split('\n')) {
      const line = raw.replace(/;.*$/, '').trim();
      if (!line) continue;
      let m;
      if ((m = line.match(/^SOUND\s+(.+)$/i))) { out.name = m[1].trim(); continue; }
      if ((m = line.match(/^FROM\s+(\w+)$/i))) { out.from = m[1].toLowerCase(); continue; }
      if ((m = line.match(/^([A-Z][A-Z0-9_]*)\s*[=:]\s*(.+)$/i))) {
        out.entries.push({ field: m[1].toUpperCase(), value: m[2].trim(), line: raw.trim() });
        continue;
      }
      out.bad.push(raw.trim());
    }
    return out;
  }

  // CAPS is two words: bits 0-31 at caps_addr, bits 32-63 at caps_ext_addr.
  // caps may be given as one number (bits 0-31) or as [low, high].
  function capsOf(map, mem) {
    const a = parseInt(map.caps_addr, 16);
    if (!mem || isNaN(a)) return null;
    const word = at => (mem[at] | (mem[at + 1] << 8) | (mem[at + 2] << 16) | (mem[at + 3] << 24)) >>> 0;
    const lo = word(a), hi = map.caps_ext_addr ? word(parseInt(map.caps_ext_addr, 16)) : 0;
    return lo || hi ? [lo, hi] : null;   // 0 means the machine did not say, so do not filter
  }

  function hasPack(index, caps, pack) {
    if (caps === null || caps === undefined) return true;
    const words = Array.isArray(caps) ? caps : [caps >>> 0, 0];
    const bits = index.map.caps_bits || {};
    const bit = Object.keys(bits).find(k => bits[k] === pack);
    if (bit === undefined) return true;
    const n = Number(bit);
    return !!((words[n >> 5] >>> (n & 31)) & 1);
  }

  // ============ RESOLVE: field names -> bytes for one voice ============
  // opts: { engineOptions(voice) -> [names], mem (for CAPS and current engine), caps }
  function resolve(index, text, voice, opts = {}) {
    const sound = typeof text === 'string' ? parse(text) : text;
    const fields = index.voiceFields[voice];
    if (!fields) return { name: sound.name, writes: [], applied: [], skipped: [{ field: voice, why: 'not a voice' }], shared: [] };
    const caps = opts.caps !== undefined ? opts.caps : capsOf(index.map, opts.mem);
    const writes = [], applied = [], skipped = [], shared = new Set();
    const bankLines = [];
    let engineName = null;

    // ENGINE first: which shared bank applies depends on it
    const ordered = sound.entries.slice().sort((a, b) => (b.field === 'ENGINE') - (a.field === 'ENGINE'));
    for (const e of ordered) {
      const slot = fields[e.field];
      // A voice's own setting for one chip (POKEY_POLY) waits until the engine is known
      if (slot && index.engineBanks && Object.values(index.engineBanks).includes(slot.pack)) { bankLines.push({ e, pack: slot.pack, slot }); continue; }
      if (slot) {
        if (!hasPack(index, caps, slot.pack)) { skipped.push({ field: e.field, why: `this machine has no ${slot.pack} pack` }); continue; }
        const enc = encodeValue(slot.f, e.value, voice, opts.engineOptions);
        if (enc.why) { skipped.push({ field: e.field, why: enc.why }); continue; }
        enc.bytes.forEach((b, i) => writes.push([slot.addr + i, b]));
        applied.push({ field: e.field, name: slot.f.name, addr: slot.addr, value: e.value, bytes: enc.bytes });
        if (e.field === 'ENGINE') engineName = e.value.toLowerCase();
        continue;
      }
      const bankPack = Object.keys(index.banks).find(p => index.banks[p][e.field]);
      if (bankPack) { bankLines.push({ e, pack: bankPack }); continue; }
      const elsewhere = VOICES.filter(v => index.voiceFields[v][e.field]);
      skipped.push({
        field: e.field,
        why: elsewhere.length ? `${voice} does not have it; ${elsewhere.join(', ')} do` : 'not in this machine\'s map'
      });
    }

    // Shared banks apply only when this voice ends up on that engine. Otherwise
    // they would change the patch some other voice is using.
    if (!engineName && opts.mem && fields.ENGINE) {
      engineName = readValue(fields.ENGINE.f, opts.mem, fields.ENGINE.addr, voice, opts.engineOptions).toLowerCase();
    }
    const activeBank = engineName ? index.engineBanks[engineName] : null;
    for (const { e, pack, slot: own } of bankLines) {
      const engineFor = Object.keys(index.engineBanks).find(k => index.engineBanks[k] === pack) || pack;
      if (pack !== activeBank) { skipped.push({ field: e.field, why: `${engineFor} chip setting, and ${voice} is not on ${engineFor}` }); continue; }
      if (!hasPack(index, caps, pack)) { skipped.push({ field: e.field, why: `this machine has no ${pack} pack` }); continue; }
      const slot = own || index.banks[pack][e.field];
      const enc = encodeValue(slot.f, e.value, voice, opts.engineOptions);
      if (enc.why) { skipped.push({ field: e.field, why: enc.why }); continue; }
      enc.bytes.forEach((b, i) => writes.push([slot.addr + i, b]));
      applied.push({ field: e.field, name: slot.f.name, addr: slot.addr, value: e.value, bytes: enc.bytes, shared: pack });
      shared.add(engineFor);
    }
    sound.bad.forEach(line => skipped.push({ field: line, why: 'not a SOUND, FROM or NAME = value line' }));
    return { name: sound.name, from: sound.from, writes, applied, skipped, shared: [...shared] };
  }

  function apply(index, mem, text, voice, opts = {}) {
    const r = resolve(index, text, voice, Object.assign({ mem }, opts));
    r.writes.forEach(([a, b]) => { mem[a] = b; });
    return r;
  }

  // ============ CAPTURE: a voice's bytes -> sound text ============
  function capture(index, mem, voice, opts = {}) {
    const fields = index.voiceFields[voice];
    const lines = [`SOUND ${opts.name || voice + ' sound'}`, `FROM ${voice}`];
    const block1 = [], block2 = [];
    const chipPacks = new Set(Object.values(index.engineBanks));
    const order = Object.keys(fields).sort((a, b) => (b === 'ENGINE') - (a === 'ENGINE'));
    order.forEach(g => {
      const slot = fields[g];
      if (chipPacks.has(slot.pack)) return;   // with the chip's settings below
      const line = `${g} = ${readValue(slot.f, mem, slot.addr, voice, opts.engineOptions)}`;
      (index.everyVoice.has(g) ? block1 : block2).push(line);
    });
    lines.push('; every voice has these', ...block1);
    if (block2.length) lines.push('; only some voices have these (skipped where missing)', ...block2);
    const engine = fields.ENGINE ? readValue(fields.ENGINE.f, mem, fields.ENGINE.addr, voice, opts.engineOptions).toLowerCase() : null;
    const pack = engine && index.engineBanks[engine];
    const own = pack ? Object.entries(fields).filter(([, slot]) => slot.pack === pack) : [];
    if (own.length) {
      lines.push(`; ${engine} settings for this voice`);
      own.forEach(([g, slot]) => lines.push(`${g} = ${readValue(slot.f, mem, slot.addr, voice, opts.engineOptions)}`));
    }
    if (pack && index.banks[pack]) {
      lines.push(`; ${engine} chip settings, shared by every voice on ${engine}`);
      Object.entries(index.banks[pack]).forEach(([name, slot]) => {
        lines.push(`${name} = ${readValue(slot.f, mem, slot.addr, voice, opts.engineOptions)}`);
      });
    }
    return lines.join('\n');
  }

  // ============ COMPILE: sound text -> POKE lines for one voice ============
  function toPokes(index, text, voice, opts = {}) {
    const r = resolve(index, text, voice, opts);
    const lines = [`; ${r.name || 'sound'} on ${voice}, compiled from field names`];
    r.applied.forEach(a => a.bytes.forEach((b, i) => {
      const label = a.bytes.length === 2 ? `${a.name}_${i ? 'HI' : 'LO'}` : a.name;
      lines.push(`POKE ${hex(a.addr + i)}, ${b}`.padEnd(18) + `; ${label}`);
    }));
    r.skipped.forEach(s => lines.push(`; skipped ${s.field}: ${s.why}`));
    return lines.join('\n');
  }

  // ============ IMPORT: POKE lines -> sound text ============
  // Turns absolute addresses back into field names, so old COPY output and
  // preset pokes become portable sounds.
  function fromPokes(index, pairs, opts = {}) {
    const perVoice = {};
    const bankBytes = {};
    for (const [addr, value] of pairs) {
      const hit = index.byAddr[addr];
      if (!hit) continue;
      if (hit.voice) (perVoice[hit.voice] = perVoice[hit.voice] || new Map()).set(addr, value);
      else (bankBytes[hit.pack] = bankBytes[hit.pack] || new Map()).set(addr, value);
    }
    const out = [];
    for (const voice of VOICES) {
      const bytes = perVoice[voice];
      if (!bytes) continue;
      const mem = new Uint8Array(65536);
      bytes.forEach((v, a) => { mem[a] = v; });
      const fields = index.voiceFields[voice];
      const lines = [`SOUND ${opts.name ? opts.name + ' ' + voice : voice + ' sound'}`, `FROM ${voice}`];
      let engine = null;
      Object.entries(fields).forEach(([g, slot]) => {
        if (!bytes.has(slot.addr)) return;
        const v = readValue(slot.f, mem, slot.addr, voice, opts.engineOptions);
        lines.push(`${g} = ${v}`);
        if (g === 'ENGINE') engine = v.toLowerCase();
      });
      const pack = engine && index.engineBanks[engine];
      if (pack && bankBytes[pack]) {
        bankBytes[pack].forEach((v, a) => { mem[a] = v; });
        lines.push(`; ${engine} chip settings, shared by every voice on ${engine}`);
        Object.entries(index.banks[pack]).forEach(([name, slot]) => {
          if (bankBytes[pack].has(slot.addr)) lines.push(`${name} = ${readValue(slot.f, mem, slot.addr, voice, opts.engineOptions)}`);
        });
      }
      out.push({ voice, count: lines.length - 2, hasEngine: !!engine, text: lines.join('\n') });
    }
    return out;
  }

  // ============ TEMPLATES ============
  // Starters leave ENGINE out unless they need one, so they fit any voice.
  const STARTERS = [
    `SOUND Soft Pluck
; short and round, fits any voice
A = 0
D = 40
S = 0
R = 30
VOL = 110`,
    `SOUND Slow Pad
; fades in, holds, fades out; wide on lead and bass
A = 140
D = 90
S = 200
R = 200
VOL = 90
UNISON_SPREAD = 18
UNISON_COUNT = 5`,
    `SOUND Sub
; long and steady, dead center
A = 3
D = 60
S = 220
R = 40
VOL = 127
PAN = 0`,
    `SOUND Off to the Left
; quieter and panned, good for hats and answers
VOL = 80
PAN = -32
VEL = 100`,
    `SOUND Fat Saw
; SID engine: two saws a little apart, one an octave down
ENGINE = sid
A = 2
D = 50
S = 160
R = 60
OSC1_WAVE = saw
OSC2_WAVE = saw
OSC2_DETUNE = 7
OSC2_OCTAVE = -1
SID_FILTER_ROUTE = 3
SID_FILTER_TYPE = LP
SID_FILTER_CUTOFF = 150
SID_FILTER_RESO = 60`,
    `SOUND Chip Wave
; wave engine: a square with a notch, the kind of shape a WSG or SCC played
ENGINE = wave
A = 2
D = 60
S = 170
R = 50
WAVE_TABLE = 7F 7F 7F 7F 7F 7F 7F 7F 7F 7F 7F 7F 20 20 20 20 80 80 80 80 80 80 80 80 80 80 80 80 E0 E0 E0 E0`,
    `SOUND Talking Lead
; speech engine: the note picks the vowel
ENGINE = lpc
VOL = 110
LPC_PHONEME = from note
LPC_PITCH = 128
LPC_VOICING = auto
LPC_RESONANCE = 200
LPC_FORMANT = 128`,
    `SOUND OPM Arcade Lead
; bright two-stack lead, the classic arcade algorithm. YM2151 style, algorithm 4
ENGINE = fm
FM_ALGORITHM = 4
FM_GLOBAL_FB = 0
OP1_RATIO = 32
OP1_LEVEL = 172
OP1_FEEDBACK = 0
OP1_WAVE = sine
OP1_DT1 = +2
OP1_A = 1
OP1_D = 240
OP1_S = 107
OP1_R = 135
OP2_RATIO = 48
OP2_LEVEL = 40
OP2_FEEDBACK = 0
OP2_WAVE = sine
OP2_DT1 = -1
OP2_A = 1
OP2_D = 219
OP2_S = 103
OP2_R = 135
OP3_RATIO = 16
OP3_LEVEL = 230
OP3_FEEDBACK = 0
OP3_WAVE = sine
OP3_DT1 = 0
OP3_A = 1
OP3_D = 255
OP3_S = 116
OP3_R = 122
OP4_RATIO = 16
OP4_LEVEL = 141
OP4_FEEDBACK = 0
OP4_WAVE = sine
OP4_DT1 = +3
OP4_A = 1
OP4_D = 255
OP4_S = 111
OP4_R = 108`,
    `SOUND OPM Slap Bass
; one modulator hits three carriers: punchy, with overtones. YM2151 style, algorithm 5
ENGINE = fm
FM_ALGORITHM = 5
FM_GLOBAL_FB = 0
OP1_RATIO = 64
OP1_LEVEL = 23
OP1_FEEDBACK = 0
OP1_WAVE = sine
OP1_DT1 = +3
OP1_A = 1
OP1_D = 117
OP1_S = 70
OP1_R = 122
OP2_RATIO = 16
OP2_LEVEL = 31
OP2_FEEDBACK = 0
OP2_WAVE = sine
OP2_DT1 = 0
OP2_A = 1
OP2_D = 138
OP2_S = 78
OP2_R = 108
OP3_RATIO = 16
OP3_LEVEL = 230
OP3_FEEDBACK = 0
OP3_WAVE = sine
OP3_DT1 = 0
OP3_A = 1
OP3_D = 199
OP3_S = 95
OP3_R = 94
OP4_RATIO = 32
OP4_LEVEL = 67
OP4_FEEDBACK = 0
OP4_WAVE = sine
OP4_DT1 = 0
OP4_A = 1
OP4_D = 158
OP4_S = 87
OP4_R = 81`,
    `SOUND OPM Brass
; synth brass: a short stack and one more modulator into OP1. YM2151 style, algorithm 3
ENGINE = fm
FM_ALGORITHM = 3
FM_GLOBAL_FB = 0
OP1_RATIO = 48
OP1_LEVEL = 230
OP1_FEEDBACK = 0
OP1_WAVE = sine
OP1_DT1 = +3
OP1_A = 1
OP1_D = 240
OP1_S = 107
OP1_R = 149
OP2_RATIO = 32
OP2_LEVEL = 67
OP2_FEEDBACK = 0
OP2_WAVE = sine
OP2_DT1 = -2
OP2_A = 1
OP2_D = 255
OP2_S = 111
OP2_R = 149
OP3_RATIO = 16
OP3_LEVEL = 158
OP3_FEEDBACK = 0
OP3_WAVE = sine
OP3_DT1 = 0
OP3_A = 1
OP3_D = 255
OP3_S = 120
OP3_R = 122
OP4_RATIO = 16
OP4_LEVEL = 148
OP4_FEEDBACK = 0
OP4_WAVE = sine
OP4_DT1 = -0
OP4_A = 1
OP4_D = 255
OP4_S = 116
OP4_R = 135`,
    `SOUND OPM Strings
; slow, detuned, a little mysterious. YM2151 style, algorithm 2
ENGINE = fm
FM_ALGORITHM = 2
FM_GLOBAL_FB = 0
OP1_RATIO = 16
OP1_LEVEL = 230
OP1_FEEDBACK = 0
OP1_WAVE = sine
OP1_DT1 = -3
OP1_A = 37
OP1_D = 255
OP1_S = 124
OP1_R = 149
OP2_RATIO = 32
OP2_LEVEL = 56
OP2_FEEDBACK = 0
OP2_WAVE = sine
OP2_DT1 = -1
OP2_A = 27
OP2_D = 255
OP2_S = 120
OP2_R = 162
OP3_RATIO = 16
OP3_LEVEL = 152
OP3_FEEDBACK = 0
OP3_WAVE = sine
OP3_DT1 = 0
OP3_A = 37
OP3_D = 255
OP3_S = 124
OP3_R = 149
OP4_RATIO = 16
OP4_LEVEL = 126
OP4_FEEDBACK = 0
OP4_WAVE = sine
OP4_DT1 = +2
OP4_A = 16
OP4_D = 255
OP4_S = 120
OP4_R = 162`,
    `SOUND OPM E.Piano
; electric piano: a 14x tine over three carriers. YM2151 style, algorithm 5
ENGINE = fm
FM_ALGORITHM = 5
FM_GLOBAL_FB = 0
OP1_RATIO = 16
OP1_LEVEL = 129
OP1_FEEDBACK = 0
OP1_WAVE = sine
OP1_DT1 = +3
OP1_A = 1
OP1_D = 199
OP1_S = 103
OP1_R = 122
OP2_RATIO = 16
OP2_LEVEL = 73
OP2_FEEDBACK = 0
OP2_WAVE = sine
OP2_DT1 = 0
OP2_A = 1
OP2_D = 179
OP2_S = 103
OP2_R = 135
OP3_RATIO = 16
OP3_LEVEL = 230
OP3_FEEDBACK = 0
OP3_WAVE = sine
OP3_DT1 = 0
OP3_A = 1
OP3_D = 219
OP3_S = 107
OP3_R = 108
OP4_RATIO = 224
OP4_LEVEL = 40
OP4_FEEDBACK = 0
OP4_WAVE = sine
OP4_DT1 = 0
OP4_A = 1
OP4_D = 138
OP4_S = 95
OP4_R = 122`,
    `SOUND WSG Round Lead
; wave engine in WSG 4-bit mode: a round 16-level shape, the Namco arcade sound
ENGINE = wave
A = 1
D = 70
S = 150
R = 40
WAVE_MODE = WSG 4-bit
WAVE_TABLE = F7 19 3B 5D 6E 6E 5D 3B 19 F7 D5 B3 91 80 80 91 B3 D5 F7 19 3B 5D 6E 6E 5D 3B 19 F7 D5 B3 91 80`,
    `SOUND SCC Brass
; wave engine in SCC 8-bit mode: three harmonics, the Konami MSX sound
ENGINE = wave
A = 6
D = 90
S = 190
R = 60
WAVE_MODE = SCC 8-bit
WAVE_TABLE = 00 26 46 5A 61 5B 4C 3A 28 1B 13 11 11 10 0D 08 00 F8 F3 F0 EF EF ED E5 D8 C6 B4 A5 9F A6 BA DA`,
    `SOUND POKEY Buzz Bass
; pokey engine: the 4-bit counter, the Atari's famous buzzy bass
ENGINE = pokey
A = 0
D = 60
S = 170
R = 30
POKEY_POLY = 4-bit
POKEY_VOL = 15
POKEY_CLOCK = 64 kHz`,
    `SOUND POKEY Square Lead
; pokey engine: a pure square at 64 kHz, so high notes land a little out of tune, as on the Atari
ENGINE = pokey
A = 0
D = 80
S = 120
R = 50
POKEY_POLY = pure
POKEY_VOL = 13
POKEY_CLOCK = 64 kHz`,
    `SOUND POKEY Hiss
; pokey engine on a drum or the noise voice: the 17-bit counter is near-white noise
ENGINE = pokey
POKEY_POLY = 17-bit
POKEY_DIV = 2
POKEY_VOL = 12`,
    `SOUND POKEY Thump
; pokey engine on the kick: a square whose pitch drops one video frame at a time
ENGINE = pokey
POKEY_POLY = pure
POKEY_VOL = 15`
  ];

  function templates(index, packs, opts = {}) {
    const list = STARTERS.map(text => ({ name: parse(text).name, text, kind: 'starter' }));
    Object.entries(packs || {}).forEach(([key, pack]) => {
      if (!pack || typeof pack.init !== 'function') return;
      let pairs;
      try { pairs = pack.init(); } catch (e) { return; }
      fromPokes(index, pairs, { name: key, engineOptions: opts.engineOptions }).forEach(s => {
        if (s.count >= 2 || s.hasEngine) list.push({ name: `${key} ${s.voice}`, text: s.text, kind: 'preset', voice: s.voice });
      });
    });
    return list;
  }

  // ============ LIBRARY: your sounds, kept in this browser ============
  let memoryStore = [];
  function loadLibrary() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : memoryStore;
    } catch (e) { return memoryStore; }
  }
  function saveLibrary(list) {
    memoryStore = list;
    try { global.localStorage.setItem(STORE_KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
  }
  function renameSound(text, name) {
    return /^\s*SOUND\s+.*$/im.test(text) ? text.replace(/^\s*SOUND\s+.*$/im, `SOUND ${name}`) : `SOUND ${name}\n${text}`;
  }

  // ============ SHARING ============
  function encodeShare(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeShare(code) {
    const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }
  function sharedFromHash(hash) {
    const m = String(hash || '').match(/[#&]sound=([A-Za-z0-9_-]+)/);
    if (!m) return null;
    try { return decodeShare(m[1]).slice(0, 8000); } catch (e) { return null; }
  }

  function summary(r, voice) {
    const parts = [`${r.applied.length} set on ${voice}`];
    if (r.shared.length) parts.push(`shared ${r.shared.join(', ')} chip changed for every voice on it`);
    if (r.skipped.length) {
      // Group fields skipped for the same reason, so a whole chip bank is one line
      const groups = new Map();
      r.skipped.forEach(s => groups.set(s.why, (groups.get(s.why) || []).concat(s.field)));
      const text = [...groups].map(([why, fields]) =>
        (fields.length > 2 ? `${fields[0]} and ${fields.length - 1} more` : fields.join(', ')) + ` (${why})`);
      parts.push(`skipped ${r.skipped.length}: ` + text.join('; '));
    }
    return parts.join('. ') + '.';
  }

  // ============ DRAWER UI ============
  const STYLE_ID = 'register-sounds-style';
  const CSS = `
.snd-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(420px, 100vw); z-index: 10000;
  background: #0b0f0b; border-left: 1px solid var(--gb-2, #306230); color: #cfd8c0;
  font: 12px/1.45 'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace;
  display: flex; flex-direction: column; box-shadow: -8px 0 30px rgba(0,0,0,.6); }
.snd-drawer[hidden] { display: none; }
.snd-drawer, .snd-drawer * { text-shadow: none; }
.snd-drawer button { text-transform: none; letter-spacing: 0; box-shadow: none; }
.snd-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #1d261d; }
.snd-head b { color: var(--gb-0, #9bbc0f); letter-spacing: 1px; flex: 1; }
.snd-body { overflow-y: auto; padding: 10px 12px 24px; flex: 1; }
.snd-drawer button, .snd-drawer select { background: #111; color: #cfd8c0; border: 1px solid #2b352b; border-radius: 3px;
  font: inherit; font-size: 11px; padding: 5px 8px; cursor: pointer; }
.snd-drawer button:hover, .snd-drawer button:focus-visible { border-color: var(--gb-0, #9bbc0f); color: var(--gb-0, #9bbc0f); outline: none; }
.snd-drawer button.primary { border-color: var(--gb-1, #8bac0f); color: var(--gb-0, #9bbc0f); }
.snd-drawer textarea { width: 100%; height: 220px; resize: vertical; background: #050805; color: #b8e08a;
  border: 1px solid #1d261d; border-radius: 3px; padding: 8px; font: 12px/1.5 'IBM Plex Mono', ui-monospace, monospace; }
.snd-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; align-items: center; }
.snd-label { color: #6b7a63; font-size: 10px; letter-spacing: 1px; text-transform: uppercase; margin: 14px 0 6px; }
.snd-report { color: #8fa07f; min-height: 1.5em; margin: 6px 0; text-wrap: pretty; }
.snd-report.err { color: #d0876b; }
.snd-list { display: flex; flex-direction: column; gap: 4px; }
.snd-item { display: flex; gap: 6px; align-items: center; }
.snd-item .nm { flex: 1; min-width: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.snd-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.snd-empty { color: #55624d; }
.snd-help { color: #6b7a63; font-size: 11px; margin: 4px 0 0; text-wrap: pretty; }
@media (max-width: 600px) {
  .snd-drawer textarea, .snd-drawer select { font-size: 16px; }
  .snd-drawer button { padding: 7px 10px; }
}`;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(() => fallback());
    fallback();
    return Promise.resolve();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } finally { ta.remove(); }
    }
  }

  // opts: { map, mem, voices, engineOptions, packs, onApplied(writes, voice), status(msg) }
  function mountDrawer(opts) {
    injectStyle();
    const index = buildIndex(opts.map);
    const memOf = () => (typeof opts.mem === 'function' ? opts.mem() : opts.mem);
    const voices = opts.voices || VOICES;
    const el = document.createElement('aside');
    el.className = 'snd-drawer';
    el.hidden = true;
    el.setAttribute('aria-label', 'Sounds');
    el.innerHTML = `
      <div class="snd-head"><b>SOUNDS</b>
        <label>voice <select class="snd-voice">${voices.map(v => `<option>${v}</option>`).join('')}</select></label>
        <button class="snd-close" title="Close">&times;</button></div>
      <div class="snd-body">
        <textarea class="snd-text" spellcheck="false" aria-label="Sound text"></textarea>
        <div class="snd-row">
          <button class="primary snd-apply" title="Write this sound onto the voice">APPLY</button>
          <button class="snd-save" title="Keep it in My sounds, under the SOUND name">SAVE</button>
          <button class="snd-grab" title="Start from what the voice sounds like right now">FROM VOICE</button>
        </div>
        <div class="snd-row">
          <button class="snd-copy" title="Copy the sound text">COPY</button>
          <button class="snd-pokes" title="Copy it compiled to POKE lines for this voice">AS POKES</button>
          <button class="snd-file" title="Download as a text file">FILE</button>
          <button class="snd-link" title="Copy a link that carries this sound">LINK</button>
        </div>
        <div class="snd-report" role="status"></div>
        <p class="snd-help">Lines set fields by name, so a sound fits any voice. What a voice lacks is skipped and listed here.</p>
        <div class="snd-label">My sounds</div>
        <div class="snd-list snd-mine"></div>
        <div class="snd-label">Starters</div>
        <div class="snd-chips snd-starters"></div>
        <div class="snd-label">From the presets</div>
        <div class="snd-chips snd-presets"></div>
      </div>`;
    document.body.appendChild(el);
    const $ = sel => el.querySelector(sel);
    const text = $('.snd-text'), voiceSel = $('.snd-voice'), report = $('.snd-report');
    const say = (msg, err) => { report.textContent = msg; report.classList.toggle('err', !!err); };
    const ropts = () => ({ engineOptions: opts.engineOptions, mem: memOf() });

    const temps = templates(index, opts.packs, { engineOptions: opts.engineOptions });
    const tempNames = new Set(temps.map(t => t.name.toLowerCase()));
    function chip(t, box) {
      const b = Object.assign(document.createElement('button'), { textContent: t.name, title: 'Load into the editor. Your edits make your own copy.' });
      b.onclick = () => {
        text.value = t.text;
        if (t.voice && voices.includes(t.voice)) voiceSel.value = t.voice;
        say(`Loaded ${t.name}. Edit it, then APPLY or SAVE your own copy.`);
      };
      box.append(b);
    }
    temps.filter(t => t.kind === 'starter').forEach(t => chip(t, $('.snd-starters')));
    const presetBox = $('.snd-presets');
    temps.filter(t => t.kind === 'preset').forEach(t => chip(t, presetBox));
    if (!presetBox.children.length) presetBox.innerHTML = '<span class="snd-empty">none</span>';

    function renderMine() {
      const box = $('.snd-mine');
      const list = loadLibrary();
      box.innerHTML = list.length ? '' : '<span class="snd-empty">Nothing saved yet. SAVE keeps the editor\'s sound here.</span>';
      list.forEach((s, i) => {
        const row = document.createElement('div');
        row.className = 'snd-item';
        const load = Object.assign(document.createElement('button'), { className: 'nm', textContent: s.name, title: 'Load into the editor' });
        load.onclick = () => { text.value = s.text; say(`Loaded ${s.name}.`); };
        const dup = Object.assign(document.createElement('button'), { textContent: 'DUP', title: 'Make a copy to change' });
        dup.onclick = () => {
          const name = uniqueName(s.name + ' copy');
          const copy = { name, text: renameSound(s.text, name), saved: new Date().toISOString() };
          const all = loadLibrary(); all.splice(i + 1, 0, copy); persist(all);
          text.value = copy.text;
          say(`Made ${name}. Edit it, then SAVE.`);
        };
        const del = Object.assign(document.createElement('button'), { textContent: 'DEL', title: 'Remove from My sounds' });
        del.onclick = () => {
          if (del.dataset.armed !== '1') {
            del.dataset.armed = '1'; del.textContent = 'SURE?';
            setTimeout(() => { del.dataset.armed = ''; del.textContent = 'DEL'; }, 2500);
            return;
          }
          const all = loadLibrary(); all.splice(i, 1); persist(all);
          say(`Removed ${s.name}.`);
        };
        row.append(load, dup, del);
        box.append(row);
      });
    }
    function persist(list) {
      if (!saveLibrary(list)) say('This browser is not keeping saved data, so My sounds lasts until you close the page. Use FILE to keep a copy.', true);
      renderMine();
    }
    function uniqueName(name) {
      const taken = new Set(loadLibrary().map(s => s.name.toLowerCase()));
      let n = name, k = 2;
      while (taken.has(n.toLowerCase())) n = `${name} ${k++}`;
      return n;
    }

    $('.snd-close').onclick = () => close();
    el.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    $('.snd-grab').onclick = () => {
      text.value = capture(index, memOf(), voiceSel.value, { engineOptions: opts.engineOptions });
      say(`This is ${voiceSel.value} as it sounds now.`);
    };
    $('.snd-apply').onclick = () => {
      const voice = voiceSel.value;
      const r = apply(index, memOf(), text.value, voice, { engineOptions: opts.engineOptions });
      if (opts.onApplied) opts.onApplied(r.writes, voice);
      say(summary(r, voice), r.applied.length === 0);
      if (opts.status) opts.status(`SOUND ${r.name || ''} ON ${voice.toUpperCase()}`.replace(/\s+/g, ' '));
    };
    $('.snd-save').onclick = () => {
      let name = parse(text.value).name || `${voiceSel.value} sound`;
      if (tempNames.has(name.toLowerCase())) name = `${name} (mine)`;
      const all = loadLibrary();
      const at = all.findIndex(s => s.name.toLowerCase() === name.toLowerCase());
      const entry = { name, text: renameSound(text.value, name), saved: new Date().toISOString() };
      if (at >= 0) all[at] = entry; else all.unshift(entry);
      text.value = entry.text;
      persist(all);
      say(at >= 0 ? `Updated ${name}.` : `Saved ${name} to My sounds.`);
    };
    $('.snd-copy').onclick = () => copyText(text.value).then(() => say('Copied the sound text.'));
    $('.snd-pokes').onclick = () => {
      copyText(toPokes(index, text.value, voiceSel.value, ropts())).then(() => say(`Copied as POKE lines for ${voiceSel.value}. PASTE them in MAP or the console.`));
    };
    $('.snd-file').onclick = () => {
      const name = (parse(text.value).name || 'sound').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sound';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text.value + '\n'], { type: 'text/plain' }));
      a.download = `${name}.sound.txt`;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      say(`Downloaded ${a.download}.`);
    };
    $('.snd-link').onclick = () => {
      const url = location.href.split('#')[0] + '#sound=' + encodeShare(text.value);
      copyText(url).then(() => say('Copied a link. Whoever opens it gets this sound in their editor.'));
    };

    let lastFocus = null;
    function open(voice, startText) {
      lastFocus = document.activeElement;
      if (voice && voices.includes(voice)) voiceSel.value = voice;
      text.value = startText || capture(index, memOf(), voiceSel.value, { engineOptions: opts.engineOptions });
      say(startText ? 'Pick a voice, then APPLY.' : `This is ${voiceSel.value} as it sounds now. Change a line, APPLY, SAVE.`);
      renderMine();
      el.hidden = false;
      text.focus();
    }
    function close() {
      el.hidden = true;
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    return { open, close, el, index };
  }

  global.RegisterSounds = {
    VOICES, buildIndex, parse, resolve, apply, capture, toPokes, fromPokes, templates,
    encodeShare, decodeShare, sharedFromHash, summary, mountDrawer, STARTERS
  };
})(typeof window !== 'undefined' ? window : globalThis);
