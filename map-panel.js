// map-panel.js: controls generated from a typed REGISTER memory map.
//
//   const panel = MapPanel.mount(container, {
//     map,                  // a typed map (memory-map.json, pixel-map.json, ...)
//     mem,                  // the Uint8Array the chip reads
//     title: 'MEMORY MAP',
//     onWrite(addr) {},     // after a control writes a byte
//     onPaste(writes) {},   // after PASTE writes [[addr, value], ...]
//     engineOptions(voice) {},  // choices for "engine" fields
//     status(message) {}
//   });
//
// Only packs whose bit is set in the map's CAPS register get controls.
// Every control reads and writes memory directly, so the panel stays in step
// with anything else that touches the same bytes.
(function (global) {
  'use strict';

  const STYLE_ID = 'map-panel-style';
  const CSS = `
    .map-panel { background: #0a0a0f; border: 1px solid var(--gb-2, #306230); border-radius: 4px; padding: 8px; margin-top: 8px; font: 0.6rem/1.4 'IBM Plex Mono', ui-monospace, monospace; color: #999; }
    .map-panel button { cursor: pointer; }
    .map-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .map-title { color: var(--gb-0, #9bbc0f); font-size: 0.7rem; }
    .map-caps { color: #666; font-size: 0.55rem; }
    .map-paste { display: flex; gap: 6px; margin: 6px 0; align-items: stretch; }
    .map-paste textarea { flex: 1; min-width: 0; height: 52px; background: #050505; color: var(--gb-0, #9bbc0f); border: 1px solid #333; border-radius: 3px; font: 0.55rem monospace; padding: 4px; resize: vertical; }
    .map-paste-btns { display: flex; flex-direction: column; gap: 4px; min-width: 64px; }
    .map-paste-btns span { color: #666; font-size: 0.5rem; }
    .map-pack { border-top: 1px solid #1a1a1a; padding: 4px 0; }
    .map-pack > summary { cursor: pointer; color: var(--gb-1, #8bac0f); list-style: none; display: flex; gap: 8px; align-items: center; }
    .map-pack > summary::-webkit-details-marker { display: none; }
    .map-pack > summary .map-addr { color: #555; }
    .map-pack > summary button { margin-left: auto; font-size: 0.5rem; padding: 1px 5px; }
    .map-row { display: grid; grid-template-columns: 44px minmax(80px, 140px) 1fr 40px; gap: 6px; align-items: center; margin: 2px 0 2px 8px; }
    .map-row .map-addr { color: #555; }
    .map-row .map-name { color: #999; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .map-row .map-val { color: #666; text-align: right; }
    .map-row input[type=range] { width: 100%; }
    .map-row select, .map-row input[type=number] { background: #111; color: var(--gb-0, #9bbc0f); border: 1px solid #333; font-size: 0.55rem; }
    .map-steps { display: flex; gap: 2px; flex-wrap: nowrap; }
    .map-steps span { width: 13px; text-align: center; color: #444; font-size: 0.45rem; }
    .map-steps span.on { color: var(--gb-0, #9bbc0f); }
    .map-bits label { margin-right: 8px; color: #888; }
    @media (max-width: 600px) {
      /* Phone: address and name on one line, then the control full width with its value */
      .map-row { grid-template-columns: 44px 1fr 48px; grid-template-areas: "addr name name" "ctl ctl val"; row-gap: 2px; margin: 6px 0 6px 4px; }
      .map-row > :nth-child(1) { grid-area: addr; }
      .map-row > :nth-child(2) { grid-area: name; }
      .map-row > :nth-child(3) { grid-area: ctl; min-width: 0; }
      .map-row > :nth-child(4) { grid-area: val; }
      .map-row input[type=range] { height: 28px; }
      .map-row select, .map-row input[type=number] { font-size: 16px; min-height: 32px; width: 100%; }
      .map-paste textarea { font-size: 16px; }
      .map-steps span { width: auto; flex: 1; }
    }
  `;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const hexAddr = a => '$' + a.toString(16).toUpperCase();

  function fieldSize(f) {
    if (f.type === 'u16') return 2;
    if (f.type === 'steps') return 16;
    if (f.type === 'readonly' || f.type === 'table') return f.size || 1;
    return 1;
  }

  // Every field with its absolute address
  function eachField(map, fn) {
    for (const r of map.regions) {
      if (!r.fields) continue;
      let addr = parseInt(r.start, 16);
      for (const f of r.fields) {
        fn(f, addr, r);
        addr += fieldSize(f);
      }
    }
  }

  function readOnlyBytes(map) {
    const set = new Set();
    eachField(map, (f, addr) => {
      if (f.type === 'readonly') for (let i = 0; i < fieldSize(f); i++) set.add(addr + i);
    });
    return set;
  }

  // CAPS is two 32-bit words: caps_addr holds bits 0-31, caps_ext_addr 32-63
  function capsOf(map, mem) {
    const word = a => (mem[a] | (mem[a + 1] << 8) | (mem[a + 2] << 16) | (mem[a + 3] << 24)) >>> 0;
    return [word(parseInt(map.caps_addr, 16)), map.caps_ext_addr ? word(parseInt(map.caps_ext_addr, 16)) : 0];
  }
  const capsHas = (caps, bit) => !!((caps[bit >> 5] >>> (bit & 31)) & 1);
  const capsText = caps => `CAPS 0x${caps[0].toString(16).toUpperCase()}` + (caps[1] ? ` CAPS_EXT 0x${caps[1].toString(16).toUpperCase()}` : '');

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => copyFallback(text));
    }
    copyFallback(text);
    return Promise.resolve();
  }

  function copyFallback(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
  }

  // Lines for every writable byte of a pack, ready for PASTE
  function packAsPokes(map, mem, pack) {
    const chip = map.name || map.spec;
    const lines = [pack === chip ? `; ${chip} settings` : `; ${chip} ${pack} settings`];
    eachField(map, (f, addr, r) => {
      if (r.pack !== pack || ['steps', 'readonly', 'table'].includes(f.type)) return;
      const size = fieldSize(f);
      for (let i = 0; i < size; i++) {
        const name = size === 2 ? `${f.name}_${i ? 'HI' : 'LO'}` : f.name;
        lines.push(`POKE ${hexAddr(addr + i)}, ${mem[addr + i]}`.padEnd(18) + `; ${name}`);
      }
    });
    return lines.join('\n');
  }

  // POKE $105C, 12 / @poke $105C 12 / $105C: 12 / $105C = 12
  // $ or 0x means hex, plain numbers are decimal.
  function parsePokeText(map, text) {
    const lo = parseInt(map.space[0], 16), hi = parseInt(map.space[1], 16);
    const ro = readOnlyBytes(map);
    const writes = [], skipped = [];
    const num = (prefix, digits) => parseInt(digits, prefix ? 16 : 10);
    for (const raw of text.split('\n')) {
      const line = raw.replace(/(;|#|\/\/).*$/, '').trim();
      if (!line) continue;
      const m = line.match(/^@?poke\s+(\$|0x)?([0-9a-f]+)\s*[, ]\s*(\$|0x)?([0-9a-f]+)$/i) ||
                line.match(/^(\$|0x)([0-9a-f]+)\s*[:=]\s*(\$|0x)?([0-9a-f]+)$/i);
      if (!m) { skipped.push(raw.trim()); continue; }
      const addr = num(m[1], m[2]), value = num(m[3], m[4]);
      if (!(addr >= lo && addr <= hi) || !(value >= 0 && value <= 255) || ro.has(addr)) {
        skipped.push(raw.trim());
        continue;
      }
      writes.push([addr, value]);
    }
    return { writes, skipped };
  }

  function mount(container, opts) {
    injectStyle();
    const { map } = opts;
    const memOf = () => (typeof opts.mem === 'function' ? opts.mem() : opts.mem);
    const say = msg => { if (opts.status) opts.status(msg); };
    const onWrite = addr => { if (opts.onWrite) opts.onWrite(addr); };
    const controls = [];
    let timer = null;

    container.classList.add('map-panel');
    container.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'map-head';
    const title = Object.assign(document.createElement('span'), { className: 'map-title', textContent: opts.title || 'MEMORY MAP' });
    const capsEl = Object.assign(document.createElement('span'), { className: 'map-caps' });
    head.append(title, capsEl);

    const pasteBox = document.createElement('div');
    pasteBox.className = 'map-paste';
    const pasteInput = Object.assign(document.createElement('textarea'), {
      spellcheck: false,
      placeholder: 'Paste POKE lines here, then LOAD'
    });
    const pasteBtns = document.createElement('div');
    pasteBtns.className = 'map-paste-btns';
    const loadBtn = Object.assign(document.createElement('button'), { textContent: 'LOAD', title: 'Write the pasted bytes into memory' });
    const pasteStatus = document.createElement('span');
    pasteBtns.append(loadBtn, pasteStatus);
    pasteBox.append(pasteInput, pasteBtns);

    const packsEl = document.createElement('div');
    container.append(head, pasteBox, packsEl);

    function makeControl(f, addr) {
      const mem = memOf;
      const row = document.createElement('div');
      row.className = 'map-row';
      const addrEl = Object.assign(document.createElement('span'), { className: 'map-addr', textContent: hexAddr(addr) });
      const nameEl = Object.assign(document.createElement('span'), { className: 'map-name', textContent: f.name });
      nameEl.title = [f.name, f.note, f.unit].filter(Boolean).join(' · ');
      const valEl = Object.assign(document.createElement('span'), { className: 'map-val' });
      row.append(addrEl, nameEl);
      const c = { addr, f, row, valEl, input: null, render: () => {} };
      const unit = f.unit ? (f.unit === 'cents' ? '¢' : ' ' + f.unit) : '';
      const write = (a, v) => { mem()[a] = v; onWrite(a); };

      if (['u8', 's8', 'cents128'].includes(f.type)) {
        const read = () => {
          const b = mem()[addr];
          if (f.type === 's8') return b > 127 ? b - 256 : b;
          if (f.type === 'cents128') return b ? b - 128 : 0;
          return b;
        };
        const input = Object.assign(document.createElement('input'), { type: 'range', min: f.min ?? 0, max: f.max ?? 255 });
        input.oninput = () => {
          const v = parseInt(input.value, 10);
          write(addr, f.type === 's8' ? (v + 256) & 255 : f.type === 'cents128' ? Math.max(0, Math.min(255, v + 128)) : v);
          c.render();
        };
        c.input = input;
        c.render = () => {
          const v = read();
          if (document.activeElement !== input) input.value = v;
          valEl.textContent = v + unit;
        };
        row.append(input, valEl);
      } else if (f.type === 'u16') {
        const input = Object.assign(document.createElement('input'), { type: 'number', min: f.min ?? 0, max: f.max ?? 65535 });
        input.onchange = () => {
          const v = Math.max(f.min ?? 0, Math.min(f.max ?? 65535, parseInt(input.value, 10) || 0));
          write(addr, v & 255);
          write(addr + 1, v >> 8);
          c.render();
        };
        c.input = input;
        c.render = () => {
          const v = mem()[addr] | (mem()[addr + 1] << 8);
          if (document.activeElement !== input) input.value = v;
          valEl.textContent = v === 0 && f.zero ? f.zero + unit : v + unit;
        };
        row.append(input, valEl);
      } else if (f.type === 'enum' || f.type === 'engine') {
        const options = f.type === 'engine'
          ? ((opts.engineOptions && opts.engineOptions(f.voice)) || ['0'])
          : f.options;
        const select = document.createElement('select');
        options.forEach((o, i) => select.add(new Option(o, i)));
        select.onchange = () => { write(addr, parseInt(select.value, 10)); c.render(); };
        c.input = select;
        c.render = () => {
          const v = mem()[addr];
          if (document.activeElement !== select) select.value = v < options.length ? v : 0;
          valEl.textContent = v;
        };
        row.append(select, valEl);
      } else if (f.type === 'bits') {
        const box = Object.assign(document.createElement('span'), { className: 'map-bits' });
        const checks = f.bits.map((label, bit) => {
          const l = document.createElement('label');
          const cb = Object.assign(document.createElement('input'), { type: 'checkbox' });
          cb.onchange = () => {
            const m = mem();
            write(addr, cb.checked ? m[addr] | (1 << bit) : m[addr] & ~(1 << bit));
            c.render();
          };
          l.append(cb, ' ' + label);
          box.append(l);
          return cb;
        });
        c.input = checks;
        c.render = () => {
          checks.forEach((cb, bit) => { cb.checked = !!(mem()[addr] & (1 << bit)); });
          valEl.textContent = mem()[addr];
        };
        row.append(box, valEl);
      } else if (f.type === 'steps') {
        const box = Object.assign(document.createElement('span'), { className: 'map-steps' });
        const cells = Array.from({ length: 16 }, () => box.appendChild(document.createElement('span')));
        c.render = () => {
          cells.forEach((cell, i) => {
            const v = mem()[addr + i];
            cell.textContent = f.of === 'gate' ? (v ? (v > 1 ? '▲' : '■') : '·') : v.toString(16).toUpperCase().padStart(2, '0');
            cell.classList.toggle('on', v > 0);
          });
        };
        valEl.textContent = '16';
        row.append(box, valEl);
      } else {
        // readonly and table: shown, never written
        const size = fieldSize(f);
        const text = document.createElement('span');
        text.style.color = '#666';
        c.render = () => {
          const m = mem();
          if (f.type === 'table') {
            let used = 0;
            for (let i = 0; i < size; i++) if (m[addr + i]) used++;
            text.textContent = `${size} bytes, ${used} set`;
          } else {
            let v = 0;
            for (let i = size - 1; i >= 0; i--) v = v * 256 + m[addr + i];
            text.textContent = '0x' + v.toString(16).toUpperCase().padStart(size * 2, '0') + ' (read-only)';
          }
        };
        row.append(text, valEl);
      }
      return c;
    }

    function rebuild() {
      packsEl.innerHTML = '';
      controls.length = 0;
      const caps = capsOf(map, memOf());
      const packs = Object.entries(map.caps_bits)
        .filter(([bit]) => capsHas(caps, Number(bit)))
        .map(([, name]) => name);
      capsEl.textContent = `${capsText(caps)}: ${packs.join(', ') || 'none reported'}`;

      packs.forEach((pack, i) => {
        const regions = map.regions.filter(r => r.pack === pack && r.fields);
        if (!regions.length) return;
        const details = document.createElement('details');
        details.className = 'map-pack';
        if (i < (opts.openPacks ?? 2)) details.open = true;
        details.addEventListener('toggle', render);
        const summary = document.createElement('summary');
        summary.innerHTML = `<span>${pack}</span><span class="map-addr">${hexAddr(parseInt(regions[0].start, 16))}-${hexAddr(parseInt(regions[regions.length - 1].end, 16))}</span>`;
        const copyBtn = Object.assign(document.createElement('button'), { textContent: 'COPY', title: `Copy ${pack} as POKE lines` });
        copyBtn.onclick = e => {
          e.preventDefault();
          copyText(packAsPokes(map, memOf(), pack)).then(() => say(`COPIED ${pack}`));
        };
        summary.append(copyBtn);
        details.append(summary);
        for (const r of regions) {
          let addr = parseInt(r.start, 16);
          for (const f of r.fields) {
            const c = makeControl(f, addr);
            details.append(c.row);
            controls.push(c);
            addr += fieldSize(f);
          }
        }
        packsEl.append(details);
      });
      render();
    }

    function render() {
      for (const c of controls) {
        const d = c.row.closest('details');
        if (d && !d.open) continue;
        c.render();
      }
    }

    function paste(text) {
      const { writes, skipped } = parsePokeText(map, text);
      const mem = memOf();
      writes.forEach(([a, v]) => { mem[a] = v; });
      if (opts.onPaste) opts.onPaste(writes);
      render();
      pasteStatus.textContent = `${writes.length} bytes loaded` + (skipped.length ? `, ${skipped.length} lines skipped` : '');
      pasteStatus.title = skipped.length ? 'Skipped: ' + skipped.slice(0, 5).join(' | ') : '';
      say(`PASTED ${writes.length} BYTES`);
      return { writes, skipped };
    }

    loadBtn.onclick = () => paste(pasteInput.value);

    const panel = {
      controls,
      rebuild,
      render,
      paste,
      packAsPokes: pack => packAsPokes(map, memOf(), pack),
      start() { clearInterval(timer); rebuild(); timer = setInterval(render, 300); },
      stop() { clearInterval(timer); timer = null; },
      destroy() { panel.stop(); container.innerHTML = ''; }
    };
    panel.start();
    return panel;
  }

  global.MapPanel = { mount, parsePokeText, packAsPokes, fieldSize };
})(typeof window !== 'undefined' ? window : globalThis);
