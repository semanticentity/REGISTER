/*
 * dom-bridge.js: make any HTML instrument a REGISTER machine.
 *
 * A map field with a "control" is bound to one of the instrument's own
 * controls (a range input, a select, checkboxes) or to an array (a step
 * sequence). The bridge keeps memory and the instrument in step both ways:
 *
 *   POKE a byte   -> the control moves, and fires the same input event a
 *                    person's hand would, so the instrument reacts normally
 *   move a control -> the byte is rewritten
 *
 * Nothing inside the instrument changes. Its controls are its registers.
 *
 *   const bridge = RegisterBridge.attach({ map, afterArrayWrite, custom });
 *
 * "custom" is for state that is not a control, such as a list of patch
 * cables: { kindName: { read(binding, mem), write(binding, mem) } }, used by
 * fields whose control is { "custom": "kindName", ... }.
 *   RegisterBridge.dock({ map, bridge, title: 'WHITE DWARF' });
 */
(function (global) {
  'use strict';

  const fieldSize = f => (f.type === 'u16' ? 2 : f.type === 'steps' ? 16 : (f.type === 'readonly' || f.type === 'table') ? (f.size || 1) : 1);
  const decimals = step => { const s = String(step); return s.includes('.') ? s.length - s.indexOf('.') - 1 : 0; };

  // A byte (0-255) to the control's own value, and back
  // A range that crosses zero keeps zero exact at byte 128 (like a signed byte):
  // 0-128 covers min to 0, 128-255 covers 0 to max. "Off" stays exactly off.
  const centered = c => !c.raw && c.curve !== 'log' && c.min < 0 && c.max > 0;
  function toValue(c, b) {
    if (c.raw) return Math.max(c.min, Math.min(c.max, b));
    let v = c.curve === 'log' ? c.min * Math.pow(c.max / c.min, b / 255)
      : centered(c) ? (b < 128 ? c.min * (128 - b) / 128 : c.max * (b - 128) / 127)
      : c.min + (b / 255) * (c.max - c.min);
    if (c.step) v = c.min + Math.round((v - c.min) / c.step) * c.step;
    return +Math.max(c.min, Math.min(c.max, v)).toFixed(decimals(c.step || 1) + (c.curve === 'log' ? 3 : 0));
  }
  function toByte(c, v) {
    v = Number(v);
    if (!isFinite(v)) return 0;
    if (c.raw) return Math.max(0, Math.min(255, Math.round(v)));
    if (centered(c)) return Math.max(0, Math.min(255, Math.round(v < 0 ? 128 - (v / c.min) * 128 : 128 + (v / c.max) * 127)));
    const t = c.curve === 'log' ? Math.log(Math.max(c.min, v) / c.min) / Math.log(c.max / c.min) : (v - c.min) / (c.max - c.min);
    return Math.max(0, Math.min(255, Math.round(t * 255)));
  }

  function attach(opts) {
    const map = opts.map;
    const root = opts.root || document;
    const mem = opts.mem || new Uint8Array(65536);
    const resolve = opts.resolve || (path => {
      const parts = path.split('.');
      const key = parts.pop();
      const owner = parts.reduce((o, k) => (o == null ? o : o[k]), global);
      return owner ? { owner, key } : null;
    });
    const bindings = [];
    const byAddr = new Map();
    for (const r of map.regions) {
      if (!r.fields) continue;
      let addr = parseInt(r.start, 16);
      for (const f of r.fields) {
        if (f.control) {
          const b = { f, c: f.control, addr, size: fieldSize(f) };
          bindings.push(b);
          for (let i = 0; i < b.size; i++) byAddr.set(addr + i, b);
        }
        addr += fieldSize(f);
      }
    }
    const el = c => (c.id ? root.getElementById ? root.getElementById(c.id) : root.querySelector('#' + c.id) : c.selector ? root.querySelector(c.selector) : null);
    const fire = node => {
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // Instrument -> memory
    function read(b) {
      const { f, c } = b;
      if (c.custom) {
        // State that is not a control (objects, lists): an adapter reads it
        const kind = opts.custom && opts.custom[c.custom];
        if (kind) kind.read(b, mem);
        return;
      }
      if (c.array) {
        const ref = resolve(c.array), arr = ref && ref.owner[ref.key];
        if (!Array.isArray(arr)) return;
        for (let i = 0; i < 16; i++) mem[b.addr + i] = arr[c.offset + i] ? 1 : 0;
        return;
      }
      if (c.buttons) {
        // Toggle buttons: a bit is on when the button shows its active class
        let v = 0;
        c.buttons.forEach((sel, i) => { const btn = root.querySelector(sel); if (btn && btn.classList.contains(c.activeClass || 'active')) v |= 1 << i; });
        mem[b.addr] = v;
        return;
      }
      if (c.checkboxes) {
        let v = 0;
        c.checkboxes.forEach((sel, i) => { const box = root.querySelector(sel); if (box && box.checked) v |= 1 << i; });
        mem[b.addr] = v;
        return;
      }
      const node = el(c);
      if (!node) return;
      if (f.type === 'enum') { const i = f.options.indexOf(node.value); mem[b.addr] = i < 0 ? 0 : i; return; }
      if (f.type === 'bits') { mem[b.addr] = node.checked ? 1 : 0; return; }
      mem[b.addr] = toByte(c, node.value);
    }
    let pushing = false;   // our own events must not overwrite the byte being applied
    function sync() { if (!pushing) bindings.forEach(read); }

    // Memory -> instrument
    function push(addr) {
      const b = byAddr.get(addr);
      if (!b) return false;
      pushing = true;
      // A custom write can move other bytes too (a list shifts), so re-read all
      try { return apply(b); } finally { pushing = false; if (b.c.custom) sync(); else read(b); }
    }

    function apply(b) {
      const { f, c } = b;
      const byte = b.size === 1 ? mem[b.addr] : null;
      if (c.custom) {
        const kind = opts.custom && opts.custom[c.custom];
        return kind ? kind.write(b, mem) !== false : false;
      }
      if (c.array) {
        const ref = resolve(c.array), arr = ref && ref.owner[ref.key];
        if (!Array.isArray(arr)) return false;
        for (let i = 0; i < 16; i++) arr[c.offset + i] = !!mem[b.addr + i];
        if (opts.afterArrayWrite) opts.afterArrayWrite(c.array);
        return true;
      }
      if (c.buttons) {
        // Click only the buttons whose state differs, so the instrument's own handler runs
        c.buttons.forEach((sel, i) => {
          const btn = root.querySelector(sel);
          if (btn && btn.classList.contains(c.activeClass || 'active') !== !!(byte & (1 << i))) btn.click();
        });
        return true;
      }
      if (c.checkboxes) {
        c.checkboxes.forEach((sel, i) => {
          const box = root.querySelector(sel);
          if (box && box.checked !== !!(byte & (1 << i))) { box.checked = !box.checked; fire(box); }
        });
        return true;
      }
      const node = el(c);
      if (!node) return false;
      if (f.type === 'enum') {
        const v = f.options[byte];
        if (v === undefined) return false;   // not an option: the byte snaps back
        node.value = v;
      } else if (f.type === 'bits') {
        node.checked = !!(byte & 1);
      } else {
        node.value = toValue(c, byte);
      }
      fire(node);
      return true;   // then read(b): the control's own resolution decides the final byte
    }

    // CAPS: this machine implements every pack in its map
    // Bits 0-31 go to caps_addr, bits 32-63 to caps_ext_addr
    const capsAddr = parseInt(map.caps_addr, 16);
    const words = [0, 0];
    Object.keys(map.caps_bits).forEach(bit => { const n = Number(bit); words[n >> 5] |= 1 << (n & 31); });
    const le = w => [w & 255, (w >> 8) & 255, (w >> 16) & 255, (w >>> 24) & 255];
    mem.set([...le(words[0] >>> 0), 1], capsAddr);
    if (map.caps_ext_addr) mem.set(le(words[1] >>> 0), parseInt(map.caps_ext_addr, 16));

    sync();
    root.addEventListener('input', () => sync(), true);
    root.addEventListener('change', () => sync(), true);
    const timer = setInterval(sync, opts.interval || 300);
    // Write a whole memory snapshot back: every binding is applied once, in
    // address order, then memory is re-read from the instrument.
    function restore(bytes, start) {
      mem.set(bytes, start);
      pushing = true;
      try {
        for (const b of bindings) {
          if (b.addr < start || b.addr >= start + bytes.length) continue;
          mem.set(bytes.subarray(b.addr - start, b.addr - start + b.size), b.addr);
          try { apply(b); } catch (e) { /* one binding failing must not stop the rest */ }
        }
      } finally { pushing = false; }
      sync();
    }

    return { mem, sync, push, restore, bindings, toValue, toByte, stop: () => clearInterval(timer) };
  }

  // A small dock: MAP opens the memory map panel; ` opens the console
  function dock(opts) {
    const { map, bridge } = opts;
    const style = document.createElement('style');
    style.textContent = `
.reg-dock-btn { position: fixed; left: 10px; bottom: 10px; z-index: 9998; background: #111; color: #9bbc0f; border: 1px solid #3a4a1a;
  border-radius: 4px; font: 11px ui-monospace, Menlo, monospace; padding: 6px 9px; cursor: pointer; opacity: .75; letter-spacing: 1px; }
.reg-dock-btn:hover, .reg-dock-btn:focus-visible { opacity: 1; outline: none; border-color: #9bbc0f; }
.reg-dock { position: fixed; top: 0; right: 0; bottom: 0; width: min(440px, 100vw); z-index: 9999; background: #0b0d0a; border-left: 1px solid #2a3a1a;
  overflow-y: auto; padding: 10px 12px 40px; box-shadow: -8px 0 30px rgba(0,0,0,.6); font: 12px ui-monospace, Menlo, monospace; color: #bbb; }
.reg-dock[hidden] { display: none; }
.reg-dock-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; color: #9bbc0f; letter-spacing: 1px; }
.reg-dock-head b { flex: 1; }
.reg-dock-head button { background: #111; color: #ccc; border: 1px solid #333; border-radius: 3px; font: inherit; padding: 3px 8px; cursor: pointer; }
.reg-dock p { color: #777; margin: 0 0 8px; }
.reg-dock button, .reg-dock select, .reg-dock textarea, .reg-dock input { font: 11px/1.3 ui-monospace, Menlo, monospace !important;
  text-transform: none !important; letter-spacing: 0 !important; width: auto; min-height: 0; height: auto; margin: 0; }
.reg-dock button { flex: none !important; padding: 3px 8px !important; background: #111 !important; color: #ccc !important; border: 1px solid #333 !important; border-radius: 3px !important; box-shadow: none !important; }
.reg-dock textarea { width: 100% !important; }
.reg-dock input[type=range] { accent-color: #9bbc0f; width: 100%; }`;
    document.head.appendChild(style);
    const btn = Object.assign(document.createElement('button'), { className: 'reg-dock-btn', textContent: 'MAP', title: `${map.name} memory map: every setting as a byte. Press \` for the console.` });
    const panel = document.createElement('aside');
    panel.className = 'reg-dock';
    panel.hidden = true;
    panel.innerHTML = `<div class="reg-dock-head"><b>${map.name} ${map.space[0].replace('0x', '$')}-${map.space[1].replace('0x', '$')}</b><button aria-label="Close">×</button></div>
      <p>Every control is a byte. Move a slider or POKE a byte: they stay in step. Press \` for the console.</p><div class="reg-dock-map"></div>`;
    document.body.append(btn, panel);
    let mounted = null;
    btn.onclick = () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden && !mounted && global.MapPanel) {
        mounted = MapPanel.mount(panel.querySelector('.reg-dock-map'), {
          map, mem: bridge.mem, title: map.name, openPacks: 2,
          onWrite: addr => bridge.push(addr),
          onPaste: writes => writes.forEach(([a]) => bridge.push(a))
        });
      }
    };
    panel.querySelector('button').onclick = () => { panel.hidden = true; };
    if (global.REGISTER && REGISTER.attach) {
      REGISTER.attach(bridge.mem, { maps: [map], onWrite: addr => bridge.push(addr) });
    }
    return { button: btn, panel };
  }

  global.RegisterBridge = { attach, dock, toValue, toByte };
})(typeof window !== 'undefined' ? window : globalThis);
