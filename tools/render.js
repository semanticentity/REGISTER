#!/usr/bin/env node
// Run REGISTER lines, render them through the real engine, and measure.
// For people and for language models, which cannot hear: did each voice
// sound, how loud, at what pitch, did the mix clip, and did the chip skip
// anything (a fault)?
//
//   node tools/render.js song.txt [--bars 1] [--clear]
//   echo "POKE LEAD_ENGINE pokey" | node tools/render.js - --clear
//
// The input is console lines (POKE, PEEK, ...), one per line; ";" starts a
// comment. A block that starts with "SOUND name" and has a "FROM voice" line
// is a sound, loaded onto that voice by field name, up to the next blank line.
// --clear starts from silence instead of the sequencer's demo pattern.
// Prints JSON. Needs Playwright's Chromium (npx playwright install chromium).
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const VOICES = ['kick', 'snare', 'lead', 'bass', 'noise'];

// Split text into console lines and SOUND blocks, in order
function parse(text) {
  const items = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s*;.*$/, '').trim();
    if (!line) continue;
    if (/^SOUND\b/i.test(line)) {
      const block = [lines[i]];
      while (i + 1 < lines.length && lines[i + 1].trim()) block.push(lines[++i]);
      items.push({ sound: block.join('\n') });
    } else items.push({ line });
  }
  return items;
}

// Runs inside the sequencer page
async function inPage({ items, bars, clear, voices }) {
  for (let i = 0; i < 60 && !(window.REGISTER && window.REGISTER.run && window.REGISTER_MAP); i++) await new Promise(r => setTimeout(r, 100));
  initAudio();
  await new Promise(r => setTimeout(r, 300));
  if (clear) {
    for (const a of [0x1000, 0x1020, 0x1100, 0x1200, 0x1300]) MEM.fill(0, a, a + 16);
    MEM.fill(0, 0x1400, 0x14A0); MEM.fill(0, 0x1E00, 0x1E41);
  }
  MEM[0x1511] = 0;
  if (!window.RegisterSounds) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'sounds.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  const index = RegisterSounds.buildIndex(window.REGISTER_MAP);
  const ran = [];
  for (const it of items) {
    if (it.line) {
      try { ran.push({ line: it.line, out: REGISTER.run(it.line) }); } catch (e) { ran.push({ line: it.line, error: e.message }); }
      continue;
    }
    const s = RegisterSounds.parse(it.sound);
    const voice = (s.from || '').toLowerCase();
    if (!voices.includes(voice)) { ran.push({ sound: s.name, error: 'a SOUND needs a FROM line naming a voice: kick, snare, lead, bass or noise' }); continue; }
    const r = RegisterSounds.apply(index, MEM, it.sound, voice, { engineOptions: v => SYNTH_IDS[v] });
    ran.push({ sound: s.name, voice, wrote: r.applied.length, skipped: r.skipped });
  }
  if (MEM[0x1501]) tempo = MEM[0x1501];
  swing = MEM[0x1503] || 0;

  const measure = buf => {
    const d = buf.getChannelData(0), e = buf.numberOfChannels > 1 ? buf.getChannelData(1) : d;
    let s = 0, peak = 0;
    for (let i = 0; i < d.length; i++) { const v = Math.max(Math.abs(d[i]), Math.abs(e[i])); s += d[i] * d[i]; if (v > peak) peak = v; }
    return { rms: +Math.sqrt(s / d.length).toFixed(4), peak: +peak.toFixed(3) };
  };
  // Fundamental by autocorrelation, 80 ms after the first sound
  const pitch = buf => {
    const d = buf.getChannelData(0), sr = buf.sampleRate;
    let on = d.findIndex(v => Math.abs(v) > 0.01);
    if (on < 0) return null;
    const a = on + Math.floor(0.03 * sr), n = Math.floor(0.08 * sr);
    if (a + n + sr / 40 > d.length) return null;
    const corr = lag => { let c = 0; for (let i = 0; i < n; i++) c += d[a + i] * d[a + i + lag]; return c; };
    const lo = Math.floor(sr / 2000), hi = Math.floor(sr / 40);
    const cs = [];
    for (let lag = lo; lag <= hi; lag++) cs.push(corr(lag));
    const best = Math.max(...cs);
    if (best <= 0) return null;
    // The shortest lag that is nearly as good as the best avoids octave errors
    // Skip the first lobe (a signal always looks like itself a few samples on),
    // then take the first peak nearly as high as the best one: that avoids
    // octave errors
    let start = cs.findIndex(c => c < 0);
    if (start < 0) start = 0;
    const rest = Math.max(...cs.slice(start));
    let k = start + cs.slice(start).indexOf(rest);
    for (let j = Math.max(1, start); j < cs.length - 1; j++) if (cs[j] >= 0.9 * rest && cs[j] >= cs[j - 1] && cs[j] >= cs[j + 1]) { k = j; break; }
    // A parabola through the peak and its neighbours finds the lag between samples
    const y0 = cs[k - 1] ?? cs[k], y1 = cs[k], y2 = cs[k + 1] ?? cs[k];
    const shift = (y0 - 2 * y1 + y2) ? 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2) : 0;
    return +(sr / (lo + k + shift)).toFixed(1);
  };
  const GATE = { kick: 0x1000, snare: 0x1020, lead: 0x1100, bass: 0x1200, noise: 0x1300 };
  const out = { ran, tempo, bars, voices: {} };
  out.mix = measure(await exportWAV(bars, { returnBuffer: true }));
  out.mix.clipped = out.mix.peak >= 0.999;
  for (const v of voices) {
    const steps = Array.from(MEM.slice(GATE[v], GATE[v] + 16));
    const on = steps.map((b, i) => (b ? i : -1)).filter(i => i >= 0);
    const r = { engine: getVoiceSynth(v), steps: on };
    if (on.length) {
      const saved = voices.map(o => MEM.slice(GATE[o], GATE[o] + 16));
      voices.forEach(o => { if (o !== v) MEM.fill(0, GATE[o], GATE[o] + 16); });
      const buf = await exportWAV(bars, { returnBuffer: true });
      voices.forEach((o, i) => MEM.set(saved[i], GATE[o]));
      Object.assign(r, measure(buf));
      if (v === 'lead' || v === 'bass') {
        r.firstNote = steps[on[0]];
        r.expectHz = +midiHz(steps[on[0]]).toFixed(1);
        r.pitchHz = pitch(buf);
        // The lowest repeating period; an engine with a sub-oscillator reads an
        // octave low. centsOff compares with the nearest octave of the note.
        if (r.pitchHz) {
          const oct = Math.log2(r.pitchHz / r.expectHz);
          r.octave = Math.round(oct);
          r.centsOff = Math.round((oct - r.octave) * 1200);
        }
      }
    }
    out.voices[v] = r;
  }
  const map = window.REGISTER_MAP;
  const word = a => (MEM[a] | (MEM[a + 1] << 8) | (MEM[a + 2] << 16) | (MEM[a + 3] << 24)) >>> 0;
  const caps = [word(0x15F0), word(0x15F5)];
  out.caps = Object.entries(map.caps_bits).filter(([b]) => (caps[b >> 5] >>> (b & 31)) & 1).map(([, n]) => n);
  const code = MEM[0x1511];
  out.fault = code ? { code, addr: '$' + (MEM[0x1512] | (MEM[0x1513] << 8)).toString(16).toUpperCase().padStart(4, '0'), text: FAULTS[code] } : null;
  return out;
}

// Use from a test with an open sequencer page, or from the command line
async function probe(page, text, opts = {}) {
  return page.evaluate(inPage, { items: parse(text), bars: opts.bars || 1, clear: !!opts.clear, voices: VOICES });
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const bars = Number((args[args.indexOf('--bars') + 1]) || 1) || 1;
  if (!file) { console.error('usage: node tools/render.js song.txt [--bars 1] [--clear]   (use - to read stdin)'); process.exit(1); }
  const text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('file://' + path.join(root, 'sequencer.html'));
    await page.waitForTimeout(2500);
    const out = await probe(page, text, { bars, clear: args.includes('--clear') });
    if (errors.length) out.pageErrors = errors;
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await browser.close();
  }
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { parse, probe };
