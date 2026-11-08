/*
 * Two small editors for chip memory, usable on any page with a MEM array.
 *
 *   WaveEditor.mount(el, { mem, addr, onChange })
 *     Draw the 32 signed samples of the XWAVE table ($1A20-$1A3F).
 *
 *   LockEditor.mount(el, { map, mem, onChange })
 *     Parameter locks (XSEQ $1E00-$1E40): on one step, one byte takes a
 *     different value, then goes back.
 *
 *   BusEditor.mount(el, { mem, events, onChange })
 *     The bus budget (XBUS $1508-$150C): how many automation writes fit in
 *     a step, and what happens to the rest. events() lists this step's misses.
 *     Also the fault register (XFAULT $1510-$1513) and its halt switch.
 *
 *   Panic.show({ mem, code, addr, message, onReset })
 *     The screen a machine shows when it halts on a fault.
 *
 *   MixEditor.mount(el, { mem, onChange })
 *     "11 to 9": every voice up to the top, then pull them back one at a
 *     time until one is left. That one is your lead. Writes VOICE_VOL.
 */
(function (global) {
  'use strict';
  const hex = (n, w = 4) => '$' + n.toString(16).toUpperCase().padStart(w, '0');
  const STYLE_ID = 'chip-editors-style';
  const CSS = `
.ce { font: 11px/1.4 'IBM Plex Mono', ui-monospace, Menlo, monospace; color: #aab89a; }
.ce, .ce * { text-shadow: none; }
.ce canvas { width: 100%; height: 140px; display: block; background: #050805; border: 1px solid #1d261d; border-radius: 3px; touch-action: none; cursor: crosshair; }
.ce .ce-row { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; align-items: center; }
.ce button, .ce select, .ce input { background: #111; color: #cfd8c0; border: 1px solid #2b352b; border-radius: 3px; font: inherit; padding: 4px 7px; text-transform: none; letter-spacing: 0; box-shadow: none; }
.ce button:hover, .ce button:focus-visible { border-color: #9bbc0f; color: #9bbc0f; outline: none; }
.ce input[type=number] { width: 4.5em; }
.ce input[type=range], .ce input[type=checkbox] { accent-color: #9bbc0f; padding: 0; }
.ce .ce-note { color: #6b7a63; margin: 4px 0; }
.ce table { width: 100%; border-collapse: collapse; }
.ce td { padding: 2px 3px; border-bottom: 1px solid #172017; }
.ce td.addr { color: #6b7a63; }
.ce-panic { position: fixed; z-index: 10000; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(460px, calc(100vw - 32px));
  background: #f4f4f0; color: #000; border: 3px solid #000; box-shadow: 0 0 0 4px #f4f4f0, 0 10px 60px rgba(0,0,0,.8); padding: 16px 18px; }
.ce-panic * { color: #000; }
.ce-panic h2 { font: 700 15px/1.3 inherit; margin: 0 0 10px; letter-spacing: 2px; animation: ce-blink 1s steps(1) infinite; }
.ce-panic p { margin: 4px 0; word-break: break-word; }
.ce-panic .ce-dump b { background: #000; color: #f4f4f0; padding: 0 2px; }
.ce-panic button { background: #000; color: #f4f4f0; border-color: #000; margin-top: 10px; padding: 6px 14px; }
.ce-panic button:focus-visible { outline: 3px solid #e05050; }
@keyframes ce-blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .ce-panic h2 { animation: none; } }
.ce .ce-on-top { color: #9bbc0f; font-weight: 700; }
.ce pre { white-space: pre-wrap; color: #6b7a63; margin: 6px 0 0; font: inherit; }
@media (max-width: 600px) { .ce select, .ce input { font-size: 16px; } }`;
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  const signed = b => (b > 127 ? b - 256 : b);

  // ============ WAVE ============
  const SHAPES = {
    sine: i => Math.sin(2 * Math.PI * i / 32) * 127,
    saw: i => -128 + i * 8,
    square: i => (i < 16 ? 127 : -128),
    triangle: i => (i < 8 ? i * 16 : i < 24 ? 128 - (i - 8) * 16 : -128 + (i - 24) * 16),
    random: () => Math.random() * 255 - 128
  };
  // Shapes in the style of the two wavetable chips. WSG shapes are 4-bit
  // (0-15, as the Namco PROMs stored them); SCC shapes are signed bytes.
  const from4 = list => i => Math.round(list[i] / 15 * 255 - 128);
  const harm = (...amps) => i => amps.reduce((v, a, k) => v + a * Math.sin(2 * Math.PI * (k + 1) * i / 32), 0);
  const CHIP_SHAPES = {
    'wsg round': from4([7, 9, 11, 13, 14, 14, 13, 11, 9, 7, 5, 3, 1, 0, 0, 1, 3, 5, 7, 9, 11, 13, 14, 14, 13, 11, 9, 7, 5, 3, 1, 0]),
    'wsg hollow': from4([7, 11, 14, 15, 15, 14, 11, 7, 3, 0, 0, 0, 0, 0, 3, 7, 11, 14, 15, 15, 14, 11, 7, 3, 0, 0, 0, 0, 0, 3, 7, 11]),
    'wsg buzz': from4([0, 4, 8, 12, 15, 12, 8, 4, 0, 4, 8, 12, 15, 12, 8, 4, 0, 4, 8, 12, 15, 12, 8, 4, 0, 4, 8, 12, 15, 12, 8, 4]),
    'wsg bounce': from4([7, 9, 11, 13, 15, 13, 11, 9, 7, 5, 3, 1, 0, 1, 3, 5, 7, 9, 11, 13, 15, 13, 11, 9, 7, 5, 3, 1, 0, 1, 3, 5]),
    'scc organ': harm(80, 40),
    'scc brass': harm(60, 40, 20),
    'scc pulse': i => (i < 8 ? -127 : 127)
  };

  function mountWave(el, opts) {
    injectStyle();
    const memOf = () => (typeof opts.mem === 'function' ? opts.mem() : opts.mem);
    const addr = opts.addr || 0x1A20;
    el.classList.add('ce');
    const modeAddr = opts.modeAddr || 0x1A40;
    el.innerHTML = `<div class="ce-note">WAVE_TABLE ${hex(addr)}-${hex(addr + 31)}: one cycle as 32 signed bytes. Draw on it. Pick the wave engine on any voice to hear it; drums play it fast and bent, as the chips did.</div>
      <canvas width="320" height="140" aria-label="Waveform, 32 samples. Drag to draw."></canvas>
      <div class="ce-row">${Object.keys(SHAPES).map(k => `<button data-shape="${k}">${k}</button>`).join('')}</div>
      <div class="ce-row">${Object.keys(CHIP_SHAPES).map(k => `<button data-chip="${k}">${k}</button>`).join('')}</div>
      <div class="ce-row"><label>WAVE_MODE ${hex(modeAddr)} <select class="ce-mode"><option value="0">SCC 8-bit</option><option value="1">WSG 4-bit</option></select></label></div>`;
    const modeSel = el.querySelector('.ce-mode');
    modeSel.onchange = () => { memOf()[modeAddr] = Number(modeSel.value); draw(); if (opts.onChange) opts.onChange(modeAddr); };
    const canvas = el.querySelector('canvas'), g = canvas.getContext('2d');
    function draw() {
      const mem = memOf(), w = canvas.width, h = canvas.height, bw = w / 32;
      const wsg = (mem[modeAddr] & 1) === 1;
      if (document.activeElement !== modeSel) modeSel.value = wsg ? '1' : '0';
      g.fillStyle = '#050805'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#1d261d'; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
      g.fillStyle = '#9bbc0f';
      for (let i = 0; i < 32; i++) {
        // In WSG mode, show the 16 levels the chip will actually play
        let v = signed(mem[addr + i]);
        if (wsg) v = (Math.round((v + 128) / 255 * 15) / 7.5 - 1) * 128;
        const y = h / 2 - (v / 128) * (h / 2 - 4);
        g.fillRect(i * bw + 1, Math.min(y, h / 2), bw - 2, Math.max(1, Math.abs(y - h / 2)));
      }
    }
    function setAt(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      const i = Math.max(0, Math.min(31, Math.floor((clientX - r.left) / r.width * 32)));
      const v = Math.max(-128, Math.min(127, Math.round(-((clientY - r.top) / r.height - 0.5) * 2 * 128)));
      memOf()[addr + i] = v & 255;
      draw();
      if (opts.onChange) opts.onChange(addr + i);
    }
    let down = false;
    canvas.addEventListener('pointerdown', e => { down = true; canvas.setPointerCapture(e.pointerId); setAt(e.clientX, e.clientY); });
    canvas.addEventListener('pointermove', e => { if (down) setAt(e.clientX, e.clientY); });
    canvas.addEventListener('pointerup', () => { down = false; });
    el.querySelectorAll('[data-shape], [data-chip]').forEach(b => {
      b.onclick = () => {
        const f = SHAPES[b.dataset.shape] || CHIP_SHAPES[b.dataset.chip], mem = memOf();
        // A WSG shape switches to WSG mode; an SCC shape to SCC mode
        if (b.dataset.chip) mem[modeAddr] = b.dataset.chip.startsWith('wsg') ? 1 : 0;
        for (let i = 0; i < 32; i++) mem[addr + i] = Math.max(-128, Math.min(127, Math.round(f(i)))) & 255;
        draw();
        if (opts.onChange) opts.onChange(addr);
      };
    });
    const timer = setInterval(draw, 400);
    draw();
    return { draw, stop: () => clearInterval(timer) };
  }

  // ============ LOCKS ============
  const COUNT = 0x1E00, TABLE = 0x1E01, MAX = 16;
  const LOCKABLE = ['u8', 's8', 'enum', 'engine', 'cents128', 'bits'];

  // Every one-byte setting in the map that a lock can change
  function lockableFields(map) {
    const out = [];
    for (const r of map.regions) {
      if (!r.fields || ['CORE', 'XSEQ', 'XSONG'].includes(r.pack)) continue;
      let a = parseInt(r.start, 16);
      for (const f of r.fields) {
        const size = f.type === 'u16' ? 2 : f.type === 'steps' ? 16 : (f.type === 'table' || f.type === 'readonly') ? (f.size || 1) : 1;
        if (LOCKABLE.includes(f.type)) out.push({ name: f.name, addr: a, f });
        a += size;
      }
    }
    return out;
  }

  function readLocks(mem) {
    const n = Math.min(MAX, mem[COUNT] || 0), list = [];
    for (let i = 0; i < n; i++) {
      const e = TABLE + i * 4;
      list.push({ step: mem[e] & 15, addr: mem[e + 1] | (mem[e + 2] << 8), value: mem[e + 3] });
    }
    return list;
  }

  function writeLocks(mem, list) {
    const n = Math.min(MAX, list.length);
    mem.fill(0, TABLE, TABLE + MAX * 4);
    list.slice(0, n).forEach((l, i) => mem.set([l.step & 15, l.addr & 255, (l.addr >> 8) & 255, l.value & 255], TABLE + i * 4));
    mem[COUNT] = n;
  }

  function mountLocks(el, opts) {
    injectStyle();
    const memOf = () => (typeof opts.mem === 'function' ? opts.mem() : opts.mem);
    const fields = lockableFields(opts.map);
    const byAddr = new Map(fields.map(x => [x.addr, x]));
    el.classList.add('ce');
    el.innerHTML = `<div class="ce-note">A parameter lock changes one setting on one step only, then puts it back. ${hex(COUNT)} counts them; each is 4 bytes from ${hex(TABLE)}: step, address low, address high, value.</div>
      <div class="ce-row">
        <label>step <select class="ce-step">${Array.from({ length: 16 }, (_, i) => `<option>${i}</option>`).join('')}</select></label>
        <select class="ce-field" aria-label="Setting">${fields.map(x => `<option value="${x.addr}">${x.name}</option>`).join('')}</select>
        <input class="ce-value" type="number" min="0" max="255" value="200" aria-label="Byte value">
        <button class="ce-add">ADD LOCK</button>
      </div>
      <table class="ce-list"></table>`;
    const list = el.querySelector('.ce-list');
    function render() {
      const locks = readLocks(memOf());
      list.innerHTML = locks.length ? '' : '<tr><td class="addr">No locks yet. Example: the snare\'s noise level at 230 on step 12 only.</td></tr>';
      locks.forEach((l, i) => {
        const tr = document.createElement('tr');
        const name = byAddr.has(l.addr) ? byAddr.get(l.addr).name : 'byte';
        tr.innerHTML = `<td>step ${l.step}</td><td>${name}</td><td class="addr">${hex(l.addr)}</td><td>= ${l.value}</td><td><button aria-label="Remove lock">×</button></td>`;
        tr.querySelector('button').onclick = () => {
          const all = readLocks(memOf()); all.splice(i, 1); writeLocks(memOf(), all); render();
          if (opts.onChange) opts.onChange();
        };
        list.append(tr);
      });
      el.querySelector('.ce-add').disabled = locks.length >= MAX;
    }
    el.querySelector('.ce-add').onclick = () => {
      const all = readLocks(memOf());
      if (all.length >= MAX) return;
      const value = Math.max(0, Math.min(255, Number(el.querySelector('.ce-value').value) || 0));
      all.push({ step: Number(el.querySelector('.ce-step').value), addr: Number(el.querySelector('.ce-field').value), value });
      writeLocks(memOf(), all);
      render();
      if (opts.onChange) opts.onChange();
    };
    const timer = setInterval(render, 800);
    render();
    return { render, stop: () => clearInterval(timer) };
  }

  // ============ BUS ============
  const BUS = { CTRL: 0x1508, SPEED: 0x1509, MODE: 0x150A, OVERFLOWS: 0x150B, LOAD: 0x150C };
  const FAULT = { CTRL: 0x1510, CODE: 0x1511, ADDR: 0x1512 };
  const FAULT_TEXT = { 1: 'lock outside sound settings', 2: 'bus overrun, a late write was lost', 3: 'no such engine, played the first' };
  const MODES = [
    ['drop', 'the write is lost, as when the CPU runs out of time'],
    ['corrupt', 'it lands with some bits flipped, as in a register conflict'],
    ['late', 'it lands next step, as when DMA takes the bus first'],
    ['alias', 'it lands one address line away, as in a bus glitch']
  ];
  function mountBus(el, opts) {
    injectStyle();
    const memOf = () => (typeof opts.mem === 'function' ? opts.mem() : opts.mem);
    el.classList.add('ce');
    el.innerHTML = `<div class="ce-note">Old chips took only so many register writes per frame. With the bus on, automation (locks, LFO, evolve) gets BUS_SPEED writes per step; the rest fail as BUS_MODE says. What you click, type or POKE is never budgeted.</div>
      <div class="ce-row">
        <label><input type="checkbox" class="ce-on"> BUS_CTRL ${hex(BUS.CTRL)} on</label>
        <label>BUS_SPEED ${hex(BUS.SPEED)} <input type="range" class="ce-speed" min="1" max="32" step="1" style="width:9em"> <b class="ce-speed-v"></b> writes per step</label>
      </div>
      <div class="ce-row"><label>BUS_MODE ${hex(BUS.MODE)} <select class="ce-busmode">${MODES.map(([m], i) => `<option value="${i}">${m}</option>`).join('')}</select></label> <span class="ce-note ce-mode-note"></span></div>
      <div class="ce-row" style="flex-wrap:nowrap"><span>load</span><div class="ce-meter" style="flex:1;height:10px;background:#050805;border:1px solid #1d261d;border-radius:2px;overflow:hidden"><div class="ce-fill" style="height:100%;width:0;background:#9bbc0f"></div></div><span class="ce-load"></span></div>
      <div class="ce-note ce-over"></div>
      <table class="ce-log"></table>
      <div class="ce-row"><label><input type="checkbox" class="ce-halt"> FAULT_CTRL ${hex(FAULT.CTRL)} halt on fault</label> <span class="ce-note ce-fault"></span></div>`;
    const $ = sel => el.querySelector(sel);
    const changed = a => { if (opts.onChange) opts.onChange(a); render(); };
    $('.ce-on').onchange = e => { memOf()[BUS.CTRL] = e.target.checked ? 1 : 0; changed(BUS.CTRL); };
    $('.ce-speed').oninput = e => { memOf()[BUS.SPEED] = Number(e.target.value); changed(BUS.SPEED); };
    $('.ce-busmode').onchange = e => { memOf()[BUS.MODE] = Number(e.target.value); changed(BUS.MODE); };
    $('.ce-halt').onchange = e => { const m = memOf(); m[FAULT.CTRL] = (m[FAULT.CTRL] & ~1) | (e.target.checked ? 1 : 0); changed(FAULT.CTRL); };
    const log = [];
    function render() {
      const mem = memOf(), speed = mem[BUS.SPEED] || 8, load = mem[BUS.LOAD], on = (mem[BUS.CTRL] & 1) === 1;
      if (document.activeElement !== $('.ce-on')) $('.ce-on').checked = on;
      if (document.activeElement !== $('.ce-speed')) $('.ce-speed').value = Math.min(32, speed);
      if (document.activeElement !== $('.ce-busmode')) $('.ce-busmode').value = String(mem[BUS.MODE] & 3);
      $('.ce-speed-v').textContent = speed;
      $('.ce-mode-note').textContent = (MODES[mem[BUS.MODE]] || MODES[0])[1];
      const pct = Math.min(100, load / speed * 100);
      $('.ce-fill').style.width = (on ? pct : 0) + '%';
      $('.ce-fill').style.background = !on ? '#333' : load > speed ? '#e05050' : pct >= 75 ? '#e0b030' : '#9bbc0f';
      $('.ce-load').textContent = on ? `${load} / ${speed}` : 'off';
      $('.ce-over').textContent = `BUS_OVERFLOWS ${hex(BUS.OVERFLOWS)} = ${mem[BUS.OVERFLOWS]}`;
      if (document.activeElement !== $('.ce-halt')) $('.ce-halt').checked = (mem[FAULT.CTRL] & 1) === 1;
      const code = mem[FAULT.CODE];
      $('.ce-fault').textContent = code ? `FAULT_CODE ${hex(FAULT.CODE)} = ${code}: ${FAULT_TEXT[code] || 'unknown'} at ${hex(mem[FAULT.ADDR] | (mem[FAULT.ADDR + 1] << 8))}` : 'no fault';
      const evs = opts.events ? opts.events() : [];
      evs.forEach(e => { if (!log.includes(e)) log.unshift(e); });
      log.length = Math.min(log.length, 6);
      $('.ce-log').innerHTML = log.map(e => `<tr><td>step ${e.step}</td><td>${e.source}</td><td class="addr">${hex(e.addr)}${e.to !== undefined ? ' → ' + hex(e.to) : ''}</td><td>${e.mode}</td></tr>`).join('');
    }
    const timer = setInterval(render, 120);
    render();
    return { render, stop: () => clearInterval(timer) };
  }

  // ============ PANIC ============
  function showPanic(opts) {
    injectStyle();
    const old = document.querySelector('.ce-panic');
    if (old) old.remove();
    const mem = opts.mem, addr = opts.addr & 0xFFFF;
    const from = Math.max(0, addr - 8), to = Math.min(65535, addr + 7);
    const dump = [];
    for (let a = from; a <= to; a++) {
      const b = mem[a].toString(16).toUpperCase().padStart(2, '0');
      dump.push(a === addr ? `<b>${b}</b>` : b);
    }
    const el = document.createElement('div');
    el.className = 'ce ce-panic';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-label', 'System panic');
    el.innerHTML = `<h2>*** SYSTEM PANIC ***</h2>
      <p>FAULT ${hex(opts.code, 2)}: ${opts.message || FAULT_TEXT[opts.code] || 'unknown'}</p>
      <p>ADDR ${hex(addr)}</p>
      <p class="ce-dump">${hex(from)}: ${dump.join(' ')}</p>
      <p>The chip stopped because FAULT_CTRL (${hex(FAULT.CTRL)}) says halt on fault. Without it, the chip skips what it cannot do and keeps playing. RST clears FAULT_CODE (${hex(FAULT.CODE)}).</p>
      <button type="button">RST</button>`;
    const reset = () => {
      mem[FAULT.CODE] = 0;
      el.remove();
      document.removeEventListener('keydown', onKey);
      if (opts.onReset) opts.onReset();
    };
    const onKey = e => { if (e.key === 'Escape') reset(); };
    el.querySelector('button').onclick = reset;
    document.addEventListener('keydown', onKey);
    document.body.appendChild(el);
    el.querySelector('button').focus();
    return { el, reset };
  }

  // ============ 11 TO 9 ============
  // A mix exercise: on a dial that stops at 11, 9 is about 82%. Everything
  // goes to the top, then each voice comes back to 9 until one is left.
  const MIX_VOICES = ['kick', 'snare', 'lead', 'bass', 'noise'];
  const VOL = 0x10B0, TOP = 127, NINE = Math.round(127 * 9 / 11);
  function mountMix(el, opts) {
    injectStyle();
    const memOf = () => (typeof opts.mem === 'function' ? opts.mem() : opts.mem);
    let saved = null;
    const pokes = [];
    el.classList.add('ce');
    el.innerHTML = `<div class="ce-note">11 TO 9: turn every voice up to 11, then pull each one back to 9 until one is left on top. The one you could not pull back is your lead. It writes VOICE_VOL (${hex(VOL)}-${hex(VOL + 4)}): 11 is ${TOP}, 9 is ${NINE}.</div>
      <div class="ce-row"><button class="ce-eleven">ALL TO 11</button><button class="ce-keep" disabled>KEEP</button><button class="ce-undo" disabled>UNDO</button></div>
      <div class="ce-row ce-voices">${MIX_VOICES.map((v, i) => `<button data-v="${i}" disabled>${v.toUpperCase()}</button>`).join('')}</div>
      <div class="ce-note ce-say">Start with ALL TO 11 while the song plays.</div>
      <pre class="ce-pokes"></pre>`;
    const $ = sel => el.querySelector(sel);
    const level = (mem, i) => mem[VOL + i] || TOP;   // 0 means not set: full
    function write(i, v) {
      memOf()[VOL + i] = v;
      pokes.push(`POKE ${hex(VOL + i)}, ${v}`.padEnd(16) + `; ${MIX_VOICES[i].toUpperCase()}_VOL`);
      if (opts.onChange) opts.onChange(VOL + i);
    }
    function render() {
      const mem = memOf();
      const top = MIX_VOICES.filter((v, i) => level(mem, i) === TOP);
      el.querySelectorAll('[data-v]').forEach(b => {
        const i = Number(b.dataset.v);
        b.disabled = !saved || level(mem, i) !== TOP || top.length <= 1;
        b.textContent = `${MIX_VOICES[i].toUpperCase()} ${level(mem, i) === TOP ? '11' : level(mem, i) === NINE ? '9' : level(mem, i)}`;
      });
      $('.ce-keep').disabled = $('.ce-undo').disabled = !saved;
      if (saved) {
        $('.ce-say').innerHTML = top.length === 1
          ? `<span class="ce-on-top">${top[0].toUpperCase()} is on top: that is your lead.</span> KEEP this mix or UNDO.`
          : top.length ? `${top.length} voices at 11. Pull back the one you would miss least.` : 'Everything is at 9. UNDO and try again.';
      }
      $('.ce-pokes').textContent = pokes.slice(-6).join('\n');
    }
    $('.ce-eleven').onclick = () => {
      const mem = memOf();
      if (!saved) saved = MIX_VOICES.map((v, i) => mem[VOL + i]);
      MIX_VOICES.forEach((v, i) => write(i, TOP));
      render();
    };
    el.querySelectorAll('[data-v]').forEach(b => { b.onclick = () => { write(Number(b.dataset.v), NINE); render(); }; });
    $('.ce-keep').onclick = () => { saved = null; $('.ce-say').textContent = 'Kept. The volumes are ordinary bytes now; change them any time.'; render(); };
    $('.ce-undo').onclick = () => {
      if (saved) saved.forEach((v, i) => write(i, v));
      saved = null;
      $('.ce-say').textContent = 'Back to the mix you had.';
      render();
    };
    render();
    return { render };
  }

  global.WaveEditor = { mount: mountWave, SHAPES, CHIP_SHAPES };
  global.Panic = { show: showPanic, FAULT_TEXT };
  global.MixEditor = { mount: mountMix, TOP, NINE };
  global.BusEditor = { mount: mountBus, MODES };
  global.LockEditor = { mount: mountLocks, readLocks, writeLocks, lockableFields };
})(typeof window !== 'undefined' ? window : globalThis);
