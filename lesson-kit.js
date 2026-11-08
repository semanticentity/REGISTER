/*
 * Lesson kit: the small pieces every lesson page shares.
 *
 *   MEM                  the chip's memory (engine.js plays from it)
 *   Kit.play() / stop()  a step clock: every step, every voice reads memory
 *   Kit.grid(el, opts)   16 boxes bound to 16 bytes of memory
 *   Kit.pokeBox(el)      type POKE and PEEK lines, see what each one did
 *   Kit.check(el, opts)  a goal that ticks itself off when memory matches
 *
 * Load after engine.js, memory-map.js and register-console.js.
 */
const MEM = new Uint8Array(65536);

const Kit = (() => {
  const hex = (n, w = 4) => '$' + n.toString(16).toUpperCase().padStart(w, '0');
  const listeners = [];
  let timer = null, step = 0, next = 0, playing = false;

  // Defaults a lesson starts from: 120 BPM, neutral drum envelopes
  MEM[0x1501] = 120;
  [0x1060, 0x1064, 0x1070].forEach(a => MEM.set([0, 0, 255, 255], a));
  MEM.set([5, 60, 140, 80], 0x1068);   // lead
  MEM.set([5, 60, 180, 60], 0x106C);   // bass
  MEM[0x15F0] = 1;                     // CORE
  MEM[0x15F4] = 1;

  function boot() {
    writeEngineCaps();
    if (window.REGISTER && REGISTER.attach && window.REGISTER_MAP) {
      REGISTER.attach(MEM, { maps: [window.REGISTER_MAP], onWrite: () => listeners.forEach(f => f(step, false)) });
    }
  }

  // Look ahead 100 ms and schedule each step on the audio clock, so timing
  // stays steady even when the page is busy.
  function schedule() {
    while (next < audioCtx.currentTime + 0.1) {
      const base = 60 / (MEM[0x1501] || 120) / 4;
      MEM[0x1502] = step;
      triggerStep(step, next, base);
      const s = step, delay = Math.max(0, (next - audioCtx.currentTime) * 1000);
      setTimeout(() => listeners.forEach(f => f(s, true)), delay);
      step = (step + 1) & 15;
      next += base;
    }
  }

  function play() {
    if (playing) return;
    initAudio();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    playing = true;
    step = 0;
    next = audioCtx.currentTime + 0.05;
    MEM[0x1500] = 3;
    timer = setInterval(schedule, 25);
    schedule();
  }

  function stop() {
    playing = false;
    clearInterval(timer);
    MEM[0x1500] = 0;
    listeners.forEach(f => f(-1, false));
  }

  function playButton(btn) {
    btn.onclick = () => {
      if (playing) { stop(); btn.textContent = 'PLAY'; btn.classList.remove('on'); }
      else { play(); btn.textContent = 'STOP'; btn.classList.add('on'); }
    };
  }

  // 16 boxes for 16 bytes starting at addr. Click to toggle between 0 and
  // onValue (1 for a drum, a note number for a melody).
  function grid(el, opts) {
    const { addr, label, onValue = 1 } = opts;
    el.classList.add('k-grid');
    el.innerHTML = `<div class="k-grid-label">${label} <span>${hex(addr)}-${hex(addr + 15)}</span></div><div class="k-cells"></div>`;
    const cells = el.querySelector('.k-cells');
    const boxes = [];
    for (let i = 0; i < 16; i++) {
      const b = document.createElement('button');
      b.className = 'k-cell';
      b.setAttribute('aria-label', `${label} step ${i}, address ${hex(addr + i)}`);
      b.onclick = () => {
        MEM[addr + i] = MEM[addr + i] ? 0 : (typeof onValue === 'function' ? onValue(i) : onValue);
        if (opts.onPoke) opts.onPoke(addr + i, MEM[addr + i]);
        draw();
      };
      cells.append(b);
      boxes.push(b);
    }
    let lit = -1;
    function draw() {
      boxes.forEach((b, i) => {
        const v = MEM[addr + i];
        b.textContent = opts.show ? opts.show(v, i) : v;
        b.classList.toggle('set', !!v);
        b.classList.toggle('now', i === lit);
        b.title = `${hex(addr + i)} = ${v}`;
      });
    }
    listeners.push(s => { lit = s; draw(); });
    setInterval(draw, 250);
    draw();
    return { draw };
  }

  // A box for POKE and PEEK lines, run through the same console as every page
  function pokeBox(el, opts = {}) {
    el.classList.add('k-poke');
    el.innerHTML = `<textarea spellcheck="false" aria-label="POKE lines">${opts.start || ''}</textarea>
      <div class="k-row"><button class="k-run">RUN</button><span class="k-hint">one command per line: POKE $1000, 1 or PEEK $1000</span></div>
      <pre class="k-out" aria-live="polite"></pre>`;
    const ta = el.querySelector('textarea'), out = el.querySelector('.k-out');
    el.querySelector('.k-run').onclick = () => {
      const lines = [];
      for (const line of ta.value.split('\n')) {
        const s = line.replace(/;.*$/, '').trim();
        if (!s) continue;
        try { lines.push('> ' + s + '\n  ' + (REGISTER.run(s) || 'ok')); }
        catch (e) { lines.push('> ' + s + '\n  ' + e.message); }
      }
      out.textContent = lines.join('\n');
      listeners.forEach(f => f(step, false));
    };
    return { textarea: ta };
  }

  // A goal: test() is checked as memory changes
  function check(el, opts) {
    el.classList.add('k-check');
    let done = false;
    const draw = () => {
      const ok = done || !!opts.test();   // once reached, a goal stays done
      if (ok !== done || !el.textContent) {
        done = ok;
        el.classList.toggle('done', ok);
        el.innerHTML = ok ? `<b>Done.</b> ${opts.ok}` : `<b>Goal:</b> ${opts.goal}${opts.hint ? `<details><summary>Hint</summary>${opts.hint}</details>` : ''}`;
      }
    };
    setInterval(draw, 300);
    draw();
  }

  const CSS = `
    .k-grid { margin: 10px 0 14px; }
    .k-grid-label { color: #888; font-size: 12px; margin-bottom: 4px; }
    .k-grid-label span { color: #555; }
    .k-cells { display: grid; grid-template-columns: repeat(16, minmax(0, 1fr)); gap: 3px; }
    .k-cell { aspect-ratio: 1; min-width: 0; padding: 0; background: #111; border: 1px solid #2a2a2a; border-radius: 3px;
      color: #555; font: 10px ui-monospace, Menlo, monospace; cursor: pointer; }
    .k-cell:nth-child(4n+1) { border-color: #3a3a3a; }
    .k-cell.set { background: #22300a; color: #c8e86a; border-color: #5a7a12; }
    .k-cell.now { outline: 2px solid #9bbc0f; outline-offset: 1px; }
    .k-cell:focus-visible { outline: 2px solid #fff; }
    .k-poke textarea { width: 100%; height: 92px; background: #0b0b0b; color: #9bbc0f; border: 1px solid #222; border-radius: 4px;
      padding: 8px; font: 13px/1.5 ui-monospace, Menlo, monospace; resize: vertical; }
    .k-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
    .k-hint { color: #555; font-size: 12px; }
    .k-out { background: #0b0b0b; border: 1px solid #1a1a1a; border-radius: 4px; padding: 8px; color: #8a9a7a; min-height: 2.4em;
      margin: 4px 0 0; white-space: pre-wrap; font-size: 12px; }
    .k-check { border: 1px dashed #333; border-radius: 4px; padding: 10px 12px; margin: 14px 0; color: #aaa; }
    .k-check.done { border: 1px solid #5a7a12; background: #12180a; color: #c8e86a; }
    .k-check details { margin-top: 6px; color: #777; }
    .k-check summary { cursor: pointer; color: #888; }
    @media (max-width: 600px) {
      .k-cells { gap: 2px; }
      .k-cell { font-size: 8px; }
      .k-poke textarea { font-size: 16px; }
    }`;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  return { hex, play, stop, playButton, grid, pokeBox, check, boot, onStep: f => listeners.push(f) };
})();
