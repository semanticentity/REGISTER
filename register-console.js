// register-console.js: POKE / PEEK for people and agents, on any REGISTER page.
//
//   REGISTER.attach(mem, { maps: [window.REGISTER_MAP], onWrite(addr) {} });
//
// Then, from the browser console or the in-page console (press ` to open):
//
//   POKE $105C, 12            write a byte (also: POKE LEAD_UNISON_SPREAD 12)
//   PEEK $1501                read a byte  (also: PEEK SEQ_TEMPO, or just $1501)
//   DUMP $1000 32             hex dump
//   FIND unison               search the maps by name
//   CAPS                      what each chip says it implements
//
// Addresses are checked against the typed maps: writes outside a map's space
// or to read-only bytes are refused with a reason. The same calls work in
// JavaScript: REGISTER.POKE('$105C', 12), REGISTER.PEEK('SEQ_TEMPO').
(function (global) {
  'use strict';

  const state = { mem: null, maps: [], onWrite: null, fields: new Map(), readOnly: new Set() };

  const hex = (n, w = 4) => '$' + n.toString(16).toUpperCase().padStart(w, '0');

  function fieldSize(f) {
    if (f.type === 'u16') return 2;
    if (f.type === 'steps') return 16;
    if (f.type === 'readonly' || f.type === 'table') return f.size || 1;
    return 1;
  }

  function index() {
    state.fields.clear();
    state.readOnly.clear();
    for (const map of state.maps) {
      for (const r of map.regions) {
        state.fields.set(r.name.toUpperCase(), { addr: parseInt(r.start, 16), size: parseInt(r.end, 16) - parseInt(r.start, 16) + 1, map, region: r });
        if (!r.fields) continue;
        let addr = parseInt(r.start, 16);
        for (const f of r.fields) {
          const size = fieldSize(f);
          state.fields.set(f.name.toUpperCase(), { addr, size, map, region: r, field: f });
          if (f.type === 'readonly') for (let i = 0; i < size; i++) state.readOnly.add(addr + i);
          addr += size;
        }
      }
    }
  }

  // The field a name or address refers to, when it starts one
  function fieldAt(a) {
    if (typeof a === 'string' && state.fields.has(a.trim().toUpperCase())) return state.fields.get(a.trim().toUpperCase()).field || null;
    const n = typeof a === 'number' ? a : (() => { try { return toAddr(a); } catch (e) { return -1; } })();
    for (const e of state.fields.values()) if (e.field && e.addr === n && e.size === fieldSize(e.field)) return e.field;
    return null;
  }

  function mapFor(addr) {
    return state.maps.find(m => addr >= parseInt(m.space[0], 16) && addr <= parseInt(m.space[1], 16));
  }

  function nameAt(addr) {
    let best = null;
    for (const [name, e] of state.fields) {
      if (addr >= e.addr && addr < e.addr + e.size && (!best || e.size < best.size)) best = { name, ...e };
    }
    return best ? best.name : null;
  }

  // "$105C", "0x105C", "4188", "LEAD_UNISON_SPREAD" → number
  function toAddr(a) {
    if (typeof a === 'number') return a;
    const s = String(a).trim();
    if (/^\$|^0x/i.test(s)) return parseInt(s.replace(/^\$|^0x/i, ''), 16);
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const f = state.fields.get(s.toUpperCase());
    if (!f) throw new Error(`No address or field named "${s}". Try FIND.`);
    return f.addr;
  }

  // A value can also be a field's own word: an option ("4-bit", "WSG 4-bit")
  // or, for an engine byte, the engine's name ("pokey")
  function namedValue(f, s) {
    if (!f) return null;
    let opts = f.options;
    if (f.type === 'engine' && f.voice && typeof SYNTH_IDS !== 'undefined') opts = SYNTH_IDS[f.voice];
    if (!opts) return null;
    const i = opts.findIndex(o => String(o).toLowerCase() === s.toLowerCase());
    return i < 0 ? null : i;
  }

  function toByte(v, f) {
    const s = String(v).trim();
    const named = /^[-+$0-9]/.test(s) && !/[a-z]/i.test(s.replace(/^0x|^\$/i, '')) ? null : namedValue(f, s);
    if (named !== null) return named;
    const n = /^\$|^0x/i.test(s) ? parseInt(s.replace(/^\$|^0x/i, ''), 16) : parseInt(s, 10);
    if (!(n >= 0 && n <= 255)) {
      let opts = f && f.options;
      if (f && f.type === 'engine' && f.voice && typeof SYNTH_IDS !== 'undefined') opts = SYNTH_IDS[f.voice];
      throw new Error(`Value ${s} is not a byte (0-255)${opts ? `; ${f.name} takes ${opts.join(', ')}` : ''}`);
    }
    return n;
  }

  function need() {
    if (!state.mem) throw new Error('No chip memory attached on this page yet');
  }

  const api = {
    attach(mem, opts = {}) {
      state.mem = mem;
      state.maps = (opts.maps || []).filter(Boolean);
      state.onWrite = opts.onWrite || null;
      index();
      return api;
    },

    POKE(addr, value) {
      need();
      const a = toAddr(addr), v = toByte(value, fieldAt(addr));
      if (!mapFor(a)) throw new Error(`${hex(a)} is outside every chip's map`);
      if (state.readOnly.has(a)) throw new Error(`${hex(a)} (${nameAt(a)}) is read-only: the chip sets it`);
      state.mem[a] = v;
      if (state.onWrite) state.onWrite(a, v);
      return v;
    },

    PEEK(addr) {
      need();
      return state.mem[toAddr(addr)];
    },

    DUMP(addr, length = 16) {
      need();
      const start = toAddr(addr), n = Math.max(1, Math.min(256, parseInt(length, 10) || 16));
      const lines = [];
      for (let row = start; row < start + n; row += 16) {
        const bytes = [];
        for (let i = row; i < Math.min(row + 16, start + n); i++) bytes.push(state.mem[i].toString(16).toUpperCase().padStart(2, '0'));
        lines.push(`${hex(row)}  ${bytes.join(' ')}`);
      }
      return lines.join('\n');
    },

    // Every word must appear in the name, its labels or its description
    FIND(text) {
      const words = String(text || '').trim().toUpperCase().split(/[\s_]+/).filter(Boolean);
      const hits = [];
      for (const [name, e] of state.fields) {
        const f = e.field || {};
        const hay = [name, name.replace(/_/g, ' '), f.note, f.unit, (f.bits || []).join(' '), (f.options || []).join(' '), e.region.about]
          .filter(Boolean).join(' ').toUpperCase();
        if (words.length && words.every(w => hay.includes(w))) {
          if (e.region.pack === 'RESERVED') continue;
          hits.push(`${hex(e.addr)}${e.size > 1 ? '-' + hex(e.addr + e.size - 1) : ''}  ${name}  (${e.map.name} ${e.region.pack})`);
        }
      }
      return hits.length ? [...new Set(hits)].slice(0, 40).join('\n') : `Nothing matches "${text}"`;
    },

    CAPS() {
      need();
      return state.maps.map(m => {
        const word = a => (state.mem[a] | (state.mem[a + 1] << 8) | (state.mem[a + 2] << 16) | (state.mem[a + 3] << 24)) >>> 0;
        const caps = [word(parseInt(m.caps_addr, 16)), m.caps_ext_addr ? word(parseInt(m.caps_ext_addr, 16)) : 0];
        const packs = Object.entries(m.caps_bits).filter(([b]) => (caps[b >> 5] >>> (b & 31)) & 1).map(([, n]) => n);
        const ext = caps[1] ? ` EXT 0x${caps[1].toString(16).toUpperCase()}` : '';
        return `${m.name}: 0x${caps[0].toString(16).toUpperCase()}${ext} ${packs.join(', ') || '(none)'}`;
      }).join('\n');
    },

    help() {
      return [
        'POKE $105C, 12     write a byte (names work too: POKE LEAD_UNISON_SPREAD 12)',
        'POKE BASS_ENGINE pokey   a field\'s own words work as values: options, engine names',
        'PEEK $1501         read a byte (or just type $1501, or a name)',
        'DUMP $1000 32      hex dump, up to 256 bytes',
        'FIND unison        search the memory maps',
        'CAPS               what each chip implements',
        'CLEAR              clear this console',
        '$ or 0x means hex; plain numbers are decimal.'
      ].join('\n');
    },

    // One line of console input → text output
    run(line) {
      const s = line.trim();
      if (!s) return '';
      const [cmd, ...rest] = s.split(/[\s,]+/).filter(Boolean);
      const C = cmd.toUpperCase();
      if (C === 'POKE' || C === '@POKE') {
        if (rest.length < 2) throw new Error('POKE needs an address and a value');
        // Values can have spaces ("WSG 4-bit"): everything after the address
        const v = api.POKE(rest[0], rest.slice(1).join(' '));
        const a = toAddr(rest[0]);
        return `${hex(a)} = ${v}${nameAt(a) ? '  ' + nameAt(a) : ''}`;
      }
      if (C === 'PEEK') {
        const a = toAddr(rest[0]);
        return `${hex(a)} = ${api.PEEK(a)}${nameAt(a) ? '  ' + nameAt(a) : ''}`;
      }
      if (C === 'DUMP') return api.DUMP(rest[0] || '$1000', rest[1]);
      if (C === 'FIND') return api.FIND(rest.join(' '));
      if (C === 'CAPS') return api.CAPS();
      if (C === 'HELP' || C === '?') return api.help();
      // A bare address or name reads it
      if (rest.length === 0) {
        const a = toAddr(cmd);
        return `${hex(a)} = ${api.PEEK(a)}${nameAt(a) ? '  ' + nameAt(a) : ''}`;
      }
      throw new Error(`Unknown command "${cmd}". Type HELP.`);
    }
  };

  // ============ CONSOLE DRAWER ============
  const CSS = `
    .reg-console { position: fixed; left: 0; right: 0; bottom: 0; z-index: 9999; max-height: 45vh; display: none; flex-direction: column;
      background: rgba(5, 8, 5, 0.97); border-top: 1px solid #306230; font: 12px/1.5 'IBM Plex Mono', ui-monospace, monospace; color: #9bbc0f; }
    .reg-console.open { display: flex; }
    .reg-console-log { flex: 1; overflow: auto; padding: 8px 12px; white-space: pre-wrap; word-break: break-all; }
    .reg-console-log .in { color: #888; }
    .reg-console-log .err { color: #e07a5f; }
    .reg-console-row { display: flex; gap: 8px; align-items: center; border-top: 1px solid #1a1a1a; padding: 6px 12px; }
    .reg-console-row label { color: #555; }
    .reg-console-row input { flex: 1; min-width: 0; background: transparent; border: none; outline: none; color: #9bbc0f; font: inherit; }
    .reg-console-toggle { position: fixed; right: 12px; bottom: 12px; z-index: 9998; background: #0a0a0a; color: #9bbc0f; border: 1px solid #306230;
      border-radius: 4px; padding: 4px 8px; font: 12px 'IBM Plex Mono', ui-monospace, monospace; cursor: pointer; opacity: 0.7; }
    .reg-console-toggle:hover, .reg-console-toggle:focus-visible { opacity: 1; outline: none; border-color: #9bbc0f; }
    @media (max-width: 600px) {
      .reg-console-toggle { right: 8px; bottom: 8px; padding: 2px 6px; opacity: 0.45; }
      .reg-console-row input { font-size: 16px; }  /* 16px stops iOS zooming in on focus */
    }
  `;

  function mountConsole() {
    if (document.querySelector('.reg-console')) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const box = document.createElement('section');
    box.className = 'reg-console';
    box.setAttribute('aria-label', 'REGISTER console');
    const log = document.createElement('div');
    log.className = 'reg-console-log';
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');
    const row = document.createElement('div');
    row.className = 'reg-console-row';
    const label = document.createElement('label');
    label.textContent = '>';
    label.htmlFor = 'reg-console-input';
    const input = document.createElement('input');
    input.id = 'reg-console-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'POKE $105C, 12   ·   PEEK SEQ_TEMPO   ·   FIND kick   ·   HELP';
    row.append(label, input);
    box.append(log, row);
    document.body.appendChild(box);

    const toggle = document.createElement('button');
    toggle.className = 'reg-console-toggle';
    toggle.textContent = '>_';
    toggle.title = 'Console: POKE and PEEK chip memory (key: `)';
    toggle.setAttribute('aria-label', 'Open the REGISTER console');
    document.body.appendChild(toggle);

    const print = (text, cls) => {
      const line = document.createElement('div');
      if (cls) line.className = cls;
      line.textContent = text;
      log.appendChild(line);
      log.scrollTop = log.scrollHeight;
    };

    const history = [];
    let hi = 0;
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const line = input.value;
        input.value = '';
        if (!line.trim()) return;
        history.push(line);
        hi = history.length;
        print('> ' + line, 'in');
        if (line.trim().toUpperCase() === 'CLEAR') { log.innerHTML = ''; return; }
        try { const out = api.run(line); if (out) print(out); }
        catch (err) { print(err.message, 'err'); }
      } else if (e.key === 'ArrowUp') {
        if (hi > 0) { hi--; input.value = history[hi]; e.preventDefault(); }
      } else if (e.key === 'ArrowDown') {
        if (hi < history.length) { hi++; input.value = history[hi] || ''; e.preventDefault(); }
      } else if (e.key === 'Escape' || e.key === '`') {
        e.preventDefault();
        close();
      }
    });

    function open() {
      box.classList.add('open');
      toggle.setAttribute('aria-expanded', 'true');
      if (!log.childElementCount) print('REGISTER console. Type HELP.');
      input.focus();
    }
    function close() {
      box.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.focus();
    }

    toggle.onclick = () => (box.classList.contains('open') ? close() : open());
    document.addEventListener('keydown', e => {
      if (e.key !== '`' || e.target === input) return;
      const t = e.target.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return;
      e.preventDefault();
      box.classList.contains('open') ? close() : open();
    });
  }

  // Merge with anything already on window.REGISTER (packs.js puts the pack library there)
  global.REGISTER = Object.assign(global.REGISTER || {}, api);
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountConsole);
    else mountConsole();
  }
})(typeof window !== 'undefined' ? window : globalThis);
