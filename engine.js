/*
 * REGISTER sound engine: the code that turns memory into sound.
 *
 * One engine for every page. The sequencer, the tweet player and PIXEL all
 * load this file, so a byte means the same sound everywhere and a WAV export
 * renders through the same code you hear.
 *
 * What the host page provides (as globals, before it plays anything):
 *   MEM        a Uint8Array covering $1000-$1FFF (the shared memory)
 *   tempo      optional; otherwise SEQ_TEMPO ($1501) is used
 *
 * What it gives back (globals):
 *   initAudio()                       start audio, build the master chain
 *   playKick / playSnare / playLead / playBass / playNoise (t, ...)
 *   triggerStep(step, t, stepSeconds) every voice for one step, with XSTEP
 *   renderWithEngine(seconds, fn)     render offline through the same chain
 *   audioBufferToWav(buffer)          16-bit WAV bytes
 *   writeEngineCaps()                 OR this engine's packs into CAPS
 *
 * It is a plain script, not a module, so the sequencer's existing code keeps
 * calling these names directly.
 */

let audioCtx = null;   // the live AudioContext, made by initAudio()

function engineBpm() {
  return (typeof tempo === 'number' && tempo) || MEM[0x1501] || 120;
}

function engineStatus(msg) {
  const el = typeof document !== 'undefined' && document.getElementById('status');
  if (el) el.innerText = msg;
}

// ============ MICROTUNING SYSTEM ============
// Memory: $10A0 = tuning mode, $10A1-$10A2 = A4 ref (16-bit Hz), $10A3-$10A7 = per-voice cents (5 bytes)
const TUNING_ADDR = 0x10A0;

// Colundi frequencies from Aleksi Perälä / Ovuca
const COLUNDI = [
  33.7, 55, 87.7, 118, 136.1, 174.6, 210.8, 221.2, 241.5, 282.6, 344.5, 396.7, 470.9, 570.2,
  695.3, 728.1, 802, 880, 1027.5, 1174.7, 1200, 1334.3, 1396.9, 1440, 1587.1, 1642.4, 1768.6,
  1962, 2280, 2400, 2480, 2816, 3000, 3440, 3960, 4216, 4800, 5156, 6000, 7056, 8192, 8400,
  9840, 12000, 14400, 16800, 19600
];

// Just Intonation ratios (pure intervals)
const JUST_RATIOS = [1, 16/15, 9/8, 6/5, 5/4, 4/3, 45/32, 3/2, 8/5, 5/3, 9/5, 15/8];

// Pythagorean ratios (perfect fifths)
const PYTH_RATIOS = [1, 256/243, 9/8, 32/27, 81/64, 4/3, 729/512, 3/2, 128/81, 27/16, 16/9, 243/128];

const TUNING_MODES = ['12-TET', 'JUST', 'PYTH', 'COLUNDI'];
let currentTuning = 0; // 0=12-TET, 1=Just, 2=Pythagorean, 3=Colundi
let a4Reference = 440;
let voiceDetune = [0, 0, 0, 0, 0]; // cents offset per voice (kick, snare, lead, bass, noise)

// Tuning is read from memory ($10A0-$10A7) on every note, so a POKE is
// heard right away. A zero byte means "default": 12-TET, A4 = 440, 0 cents.
function tuningA4() {
  const raw = MEM[TUNING_ADDR + 1] | (MEM[TUNING_ADDR + 2] << 8);
  return raw ? Math.max(400, Math.min(480, raw)) : 440;
}

function tuningFromMem(voiceIndex) {
  const mode = (MEM[TUNING_ADDR] || 0) % TUNING_MODES.length;
  const a4 = tuningA4();
  const b = MEM[TUNING_ADDR + 3 + voiceIndex];
  const cents = b ? Math.max(-100, Math.min(100, b - 128)) : 0;  // stored +128
  // Keep the UI's copies in step with memory
  if (mode !== currentTuning || a4 !== a4Reference) {
    currentTuning = mode;
    a4Reference = a4;
    if (typeof updateTuningDisplay === 'function') updateTuningDisplay();
  }
  voiceDetune[voiceIndex] = cents;
  return { mode, a4, cents };
}

// Standard 12-TET conversion
const midiHz = m => tuningA4() * Math.pow(2, (m - 69) / 12 + unisonCents / 1200);

// Convert MIDI note to Hz respecting current tuning mode
function noteToHz(midiNote, voiceIndex = 2) {
  const { mode, a4, cents } = tuningFromMem(voiceIndex);
  const detuneRatio = Math.pow(2, (cents + unisonCents) / 1200);

  if (mode === 3) {
    // Colundi mode: map MIDI range to Colundi frequencies
    // Filter to playable range (roughly 60-2000 Hz for melodic use)
    const playable = COLUNDI.filter(f => f >= 60 && f <= 2000);
    const idx = Math.max(0, Math.min(playable.length - 1, midiNote - 36));
    return playable[idx] * detuneRatio;
  }

  if (mode === 1 || mode === 2) {
    // Just Intonation or Pythagorean
    const ratios = mode === 1 ? JUST_RATIOS : PYTH_RATIOS;
    const octave = Math.floor((midiNote - 69) / 12);
    const degree = ((midiNote - 69) % 12 + 12) % 12;
    const baseHz = a4 * Math.pow(2, octave);
    return baseHz * ratios[degree] * detuneRatio;
  }

  // 12-TET (default)
  return midiHz(midiNote) * detuneRatio;
}

// Get tuning mode from memory
function getTuningMode() {
  return MEM[TUNING_ADDR] || 0;
}


// ============ VOICE CONFIG ============
// Memory map: $1400-$144F = probability (5×16), $1450-$149F = ratchets (5×16)
// synth: default synth algorithm name, synthAddr: memory address for synth selector
// ADSR: 4 bytes per voice at $1060-$1073 (A, D, S, R) - values 0-255, scaled to ms/level
const VOICES = {
  kick:  { gate: 0x1000, prob: 0x1400, ratch: 0x1450, synth: 'kick', synthAddr: 0x1058, adsr: 0x1060, params: [{ addr: 0x1010, id: 'kick-pitch', def: 36 }] },
  snare: { gate: 0x1020, prob: 0x1410, ratch: 0x1460, synth: 'snare', synthAddr: 0x1059, adsr: 0x1064, params: [{ addr: 0x1030, id: 'snare-tone', def: 180 }, { addr: 0x1040, id: 'snare-snap', def: 100 }] },
  lead:  { gate: 0x1100, prob: 0x1420, ratch: 0x1470, synth: 'lead', synthAddr: 0x115A, adsr: 0x1068, params: [{ addr: 0x1110, id: 'lead-arp', def: 0 }], isNote: true },
  bass:  { gate: 0x1200, prob: 0x1430, ratch: 0x1480, synth: 'bass', synthAddr: 0x125A, adsr: 0x106C, params: [{ addr: 0x1210, id: 'bass-fm', def: 40 }, { addr: 0x1220, id: 'bass-filt', def: 70 }], isNote: true },
  noise: { gate: 0x1300, prob: 0x1440, ratch: 0x1490, synth: 'noise', synthAddr: 0x135A, adsr: 0x1070, params: [{ addr: 0x1310, id: 'noise-y', def: 14 }, { addr: 0x1320, id: 'noise-type', def: 0 }] }
};


// ============ MASTER EFFECTS BUS ============
// All voices connect here → effects chain → destination
let masterBus = null;
let masterGain = null;
let masterFilter = null;
let masterDelay = null;
let masterDelayGain = null;
let masterDelayFeedback = null;
let masterBitcrush = null;
let masterPan = null;

// XFX Memory Map: $1080-$109F (master volume at $10A8)
const XFX = {
  BITCRUSH_BITS:   0x1094,  // 8=normal, 4=crunchy, 2=gameboy, 1=pulse
  BITCRUSH_RATE:   0x1095,  // Sample rate reduction (0-3)
  FILTER_TYPE:     0x1080,  // 0=off, 1=LP, 2=HP, 3=BP, 4=Notch
  FILTER_CUTOFF:   0x1081,  // 0-255 → 100Hz-8000Hz
  FILTER_RESO:     0x1082,  // 0-255 → Q 0.5-20
  FILTER_ENV:      0x1083,  // Envelope amount
  DELAY_TIME_LO:   0x1090,  // Delay ms low byte
  DELAY_TIME_HI:   0x1091,  // Delay ms high byte
  DELAY_FEEDBACK:  0x1092,  // 0-255 → 0-90% feedback
  DELAY_MIX:       0x1093,  // 0-255 → dry/wet
  MASTER_VOL:      0x10A8,  // Master volume 0-255
};

// XFM Memory Map: $1900-$192F
const XFM = {
  OP1_RATIO:    0x1900,  // Frequency ratio: 0 = 0.5x, else byte / 16 (16 = 1x)
  OP1_LEVEL:    0x1901,  // Output level
  OP1_FEEDBACK: 0x1902,  // Self-modulation
  OP1_WAVE:     0x1903,  // Waveform (0=sin, 1=saw, 2=sq, 3=tri)
  OP2_RATIO:    0x1904,
  OP2_LEVEL:    0x1905,
  OP2_FEEDBACK: 0x1906,
  OP2_WAVE:     0x1907,
  OP3_RATIO:    0x1908,
  OP3_LEVEL:    0x1909,
  OP3_FEEDBACK: 0x190A,
  OP3_WAVE:     0x190B,
  OP4_RATIO:    0x190C,
  OP4_LEVEL:    0x190D,
  OP4_FEEDBACK: 0x190E,
  OP4_WAVE:     0x190F,
  ALGORITHM:    0x1910,  // 0-7: operator routing
  GLOBAL_FB:    0x1911,  // Global feedback, added to OP4
  OP1_DT1:      0x1912,  // DT1 detune, OP1-OP4 at $1912-$1915
  // ADSR for each operator
  OP1_A: 0x1920, OP1_D: 0x1921, OP1_S: 0x1922, OP1_R: 0x1923,
  OP2_A: 0x1924, OP2_D: 0x1925, OP2_S: 0x1926, OP2_R: 0x1927,
  OP3_A: 0x1928, OP3_D: 0x1929, OP3_S: 0x192A, OP3_R: 0x192B,
  OP4_A: 0x192C, OP4_D: 0x192D, OP4_S: 0x192E, OP4_R: 0x192F,
};

// Initialize XFM defaults (DX7-style electric piano)
// A region that is still all zero has not been set, so fill in a working
// default. A song or preset that already set it keeps its own bytes.
function regionBlank(start, end) {
  for (let a = start; a <= end; a++) if (MEM[a]) return false;
  return true;
}

function initXFMDefaults() {
  if (!regionBlank(0x1900, 0x192F)) return;
  // Electric piano on algorithm 4, two stacks: OP2 into OP1 is the body,
  // OP4 at 14x into OP3 is the bright tine that dies away fast
  const ops = [
    // ratio, level, feedback, wave, A, D, S, R
    [16, 220, 0, 0,  2, 150, 90, 90],   // OP1 1x  carrier: body
    [16, 70,  0, 0,  2, 110, 40, 70],   // OP2 1x  into OP1
    [16, 120, 0, 0,  2, 60,  20, 60],   // OP3 1x  carrier: tine
    [224, 50, 0, 0,  2, 25,  0,  30],   // OP4 14x into OP3
  ];
  ops.forEach((o, i) => {
    MEM.set(o.slice(0, 4), XFM.OP1_RATIO + i * 4);
    MEM.set(o.slice(4), XFM.OP1_A + i * 4);
  });
  MEM[XFM.ALGORITHM] = 4;
}

// Initialize XFX defaults
function initXFXDefaults() {
  if (!regionBlank(0x1080, 0x1095) || MEM[XFX.MASTER_VOL]) return;
  MEM[XFX.BITCRUSH_BITS] = 0;   // Off (0 = no crush)
  MEM[XFX.BITCRUSH_RATE] = 0;   // No rate reduction
  MEM[XFX.FILTER_TYPE] = 0;     // Off
  MEM[XFX.FILTER_CUTOFF] = 200; // High cutoff
  MEM[XFX.FILTER_RESO] = 30;    // Low resonance
  MEM[XFX.DELAY_TIME_LO] = 0;   // No delay
  MEM[XFX.DELAY_TIME_HI] = 0;
  MEM[XFX.DELAY_FEEDBACK] = 80;
  MEM[XFX.DELAY_MIX] = 60;
  MEM[XFX.MASTER_VOL] = 200;
}

// ============ MASTER CHAIN ============
// voices → master gain → bitcrush → filter → pan → speakers
//                       ↘→ delay → wet ↗      (delay → feedback → delay)
// Built for any audio context, so WAV export runs through the same chain.
let liveChain = null;
let masterCrush = null;
let masterCrushShaper = null;
let masterEnvAmt = null;

function buildMasterChain(ctx) {
  const n = {};
  n.gain = ctx.createGain();
  n.gain.gain.value = 0.8;
  n.crushIn = ctx.createGain();     // bitcrush slots in between these two
  n.crushOut = ctx.createGain();
  n.crushIn.connect(n.crushOut);
  n.filter = ctx.createBiquadFilter();
  n.filter.type = 'lowpass';
  n.filter.frequency.value = 8000;
  n.filter.Q.value = 1;
  n.delay = ctx.createDelay(2.0);
  n.delay.delayTime.value = 0;
  n.delayGain = ctx.createGain();      // wet level: how loud the echoes are
  n.delayGain.gain.value = 0;
  n.delayFeedback = ctx.createGain();  // how much of each echo comes back
  n.delayFeedback.gain.value = 0;
  n.pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  n.gain.connect(n.crushIn);
  n.crushOut.connect(n.filter);
  if (n.pan) n.filter.connect(n.pan).connect(ctx.destination);
  else n.filter.connect(ctx.destination);
  n.crushOut.connect(n.delay);
  n.delay.connect(n.delayGain);
  n.delayGain.connect(n.filter);
  n.delay.connect(n.delayFeedback);
  n.delayFeedback.connect(n.delay);
  // Filter envelope: a signal added to the cutoff, opened by hits ($1083-$1085)
  n.envAmt = ctx.createGain();
  n.envAmt.gain.value = 0;
  if (ctx.createConstantSource) {
    n.envSrc = ctx.createConstantSource();
    n.envSrc.offset.value = 1;
    n.envSrc.connect(n.envAmt).connect(n.filter.frequency);
    n.envSrc.start();
  }
  n.crush = null;
  return n;
}

// A hit opens the filter by FILTER_ENV, then it closes. FOLLOW ($1084) picks
// which voices open it, one bit each (kick = bit 0 ... noise = bit 4);
// 0 means every voice. CLOSE ($1085): 0 = one step, else 0-1000 ms.
function filterEnvHit(voice, t) {
  const amount = MEM[XFX.FILTER_ENV];
  if (!amount || !masterEnvAmt || !(voice in MIX_INDEX)) return;
  const follow = MEM[0x1084];
  if (follow && !(follow & (1 << MIX_INDEX[voice]))) return;
  const close = MEM[0x1085] ? MEM[0x1085] / 255 : (gateSeconds || 60 / engineBpm() / 4);
  const g = masterEnvAmt.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime((amount / 255) * 8000, t);
  g.setTargetAtTime(0, t, Math.max(0.005, close / 3));
}

function useMasterChain(n) {
  masterGain = n.gain;
  masterFilter = n.filter;
  masterDelay = n.delay;
  masterDelayGain = n.delayGain;
  masterDelayFeedback = n.delayFeedback;
  masterPan = n.pan;
  masterCrush = n.crush;
  masterCrushShaper = n.crushShaper || null;
  masterEnvAmt = n.envAmt;
  masterBus = n.gain;
}

// XFX bitcrush ($1094 bits, $1095 rate) as an AudioWorklet: fewer bits rounds
// each sample to fewer levels, a higher rate holds each sample for 2, 4 or 8.
const CRUSH_SOURCE = `
  class RegisterCrush extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        { name: 'bits', defaultValue: 0, minValue: 0, maxValue: 255, automationRate: 'k-rate' },
        { name: 'rate', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' }
      ];
    }
    constructor() { super(); this.held = [0, 0]; this.peak = [1e-3, 1e-3]; this.n = 0; }
    process(inputs, outputs, p) {
      const input = inputs[0], output = outputs[0];
      const raw = p.bits[0] | 0, hold = 1 << (p.rate[0] | 0);
      // Not in the docs: $10 is this chip's old name. It crushes to 2 bits
      // measured against each sound's own loudness, so quiet voices keep
      // their crunch instead of rounding away to silence.
      const follow = raw === 16;
      const bits = follow ? 2 : raw;
      const levels = bits > 0 && bits < 8 ? Math.pow(2, bits - 1) : 0;  // 0 or 8 = untouched
      let n = this.n;
      for (let c = 0; c < output.length; c++) {
        const src = input[c] || input[0], out = output[c];
        if (!src) { out.fill(0); continue; }
        let h = this.held[c] || 0, pk = this.peak[c] || 1e-3;
        n = this.n;
        for (let k = 0; k < out.length; k++, n++) {
          const x = src[k];
          if (follow) pk = Math.max(Math.abs(x), pk * 0.9997, 1e-3);
          if (n % hold === 0) {
            h = !levels ? x : follow ? (Math.round((x / pk) * levels) / levels) * pk : Math.round(x * levels) / levels;
          }
          out[k] = h;
        }
        this.held[c] = h;
        this.peak[c] = pk;
      }
      this.n = n % 8;
      return true;
    }
  }
  registerProcessor('register-crush', RegisterCrush);`;
let crushURL = null;
const crushLoaded = new WeakMap();

async function addCrusher(ctx, n) {
  try {
    if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;
    if (!crushURL) crushURL = URL.createObjectURL(new Blob([CRUSH_SOURCE], { type: 'application/javascript' }));
    if (!crushLoaded.has(ctx)) crushLoaded.set(ctx, ctx.audioWorklet.addModule(crushURL));
    await crushLoaded.get(ctx);
    const node = new AudioWorkletNode(ctx, 'register-crush', { outputChannelCount: [2] });
    n.crushIn.disconnect();
    n.crushIn.connect(node).connect(n.crushOut);
    n.crush = node;
    if (n === liveChain) masterCrush = node;
    return true;
  } catch (e) {
    // Worklets need the page served over http(s). Opened as a local file,
    // fall back to a WaveShaper: bit depth works, sample rate hold does not.
    const ws = ctx.createWaveShaper();
    n.crushIn.disconnect();
    n.crushIn.connect(ws).connect(n.crushOut);
    n.crushShaper = ws;
    if (n === liveChain) masterCrushShaper = ws;
    return false;
  }
}

function crushCurve(bits) {
  if (!(bits > 0 && bits < 8)) return null;     // null curve = untouched
  const levels = Math.pow(2, bits - 1), size = 4096, curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    curve[i] = Math.round(x * levels) / levels;
  }
  return curve;
}

function initAudio() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    liveChain = buildMasterChain(audioCtx);
    useMasterChain(liveChain);
    addCrusher(audioCtx, liveChain);

    // Initialize pack defaults
    initXFMDefaults();
    initXFXDefaults();
    initXSIDDefaults();
    initXWAVEDefaults();

    writeEngineCaps();

    // Start effects update loop
    setInterval(updateMasterEffects, 50);

    const led = document.getElementById('led');
    if (led) led.classList.add('on');
  }
  engineStatus('AUDIO READY [XFM+XFX]');
}

// Update master effects from memory (called periodically)
function updateMasterEffects() {
  if (!audioCtx || !masterFilter) return;

  // Master volume
  const vol = MEM[XFX.MASTER_VOL] || 200;
  masterGain.gain.value = vol / 255;
  if (masterPan) masterPan.pan.value = panOf(MEM[0x10A9]);

  // Bitcrush: bits 0 or 8 = clean, rate 0 = every sample
  const rawBits = MEM[XFX.BITCRUSH_BITS] || 0;
  const bits = rawBits === 16 ? 3 : Math.min(8, rawBits);   // the file:// fallback cannot follow loudness
  if (masterCrush) {
    masterCrush.parameters.get('bits').value = rawBits;
    masterCrush.parameters.get('rate').value = Math.min(3, MEM[XFX.BITCRUSH_RATE] || 0);
  } else if (masterCrushShaper && masterCrushShaper._bits !== bits) {
    masterCrushShaper.curve = crushCurve(bits);
    masterCrushShaper._bits = bits;
  }

  // Filter
  const filterType = MEM[XFX.FILTER_TYPE] || 0;
  if (filterType > 0) {
    const types = ['lowpass', 'lowpass', 'highpass', 'bandpass', 'notch'];
    masterFilter.type = types[filterType] || 'lowpass';
    const cutoff = MEM[XFX.FILTER_CUTOFF] || 200;
    masterFilter.frequency.value = 100 + (cutoff / 255) * 7900;
    const reso = MEM[XFX.FILTER_RESO] || 30;
    masterFilter.Q.value = 0.5 + (reso / 255) * 19.5;
  } else {
    masterFilter.frequency.value = 20000; // Bypass
    masterFilter.Q.value = 0.5;
  }

  // Delay: FEEDBACK is how much of each echo comes back (0-255 = 0-90%),
  // MIX is how loud the echoes are (0-255 = 0-100%). Separate, so a loud
  // echo can still die fast, and a long tail can sit quietly underneath.
  const delayMs = MEM[XFX.DELAY_TIME_LO] + (MEM[XFX.DELAY_TIME_HI] << 8);
  if (delayMs > 0) {
    masterDelay.delayTime.value = Math.min(delayMs / 1000, 2.0);
    masterDelayFeedback.gain.value = (MEM[XFX.DELAY_FEEDBACK] / 255) * 0.9;
    masterDelayGain.gain.value = MEM[XFX.DELAY_MIX] / 255;
  } else {
    masterDelayFeedback.gain.value = 0;
    masterDelayGain.gain.value = 0;
  }
}

// Get audio destination (use master bus if available, else direct)
function getAudioDest() {
  return unisonDest || voiceDest || masterBus || audioCtx.destination;
}

// ============ PER-VOICE MIX (XMixer $10B0-$10B9, XVel) ============
// Each voice gets its own channel strip: volume and velocity set the gain,
// pan places it left or right, then it joins the master bus.
// Volume and velocity: 0 = not set (full), 1-127 = level. Pan is a signed
// byte: -64 = hard left, 0 = center, +63 = hard right.
const MIX_INDEX = { kick: 0, snare: 1, lead: 2, bass: 3, noise: 4 };
const VEL_ADDR = { kick: 0x10C0, snare: 0x10C1, lead: 0x1120, bass: 0x1230, noise: 0x1330 };
const voiceStrips = {};
let voiceDest = null;    // the strip for the voice being played

function panOf(byte) {
  const s = (byte || 0) > 127 ? byte - 256 : (byte || 0);
  return Math.max(-1, Math.min(1, s / 64));
}

function voiceStrip(voice, t) {
  const out = masterBus || audioCtx.destination;
  const i = MIX_INDEX[voice];
  const vol = MEM[0x10B0 + i] || 127;
  const vel = MEM[VEL_ADDR[voice]] || 127;
  const level = (vol / 127) * (vel / 127), place = panOf(MEM[0x10B5 + i]);
  let strip = voiceStrips[voice];
  if (!strip || strip.out !== out) {
    const gain = audioCtx.createGain();
    const pan = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : null;
    if (pan) gain.connect(pan).connect(out); else gain.connect(out);
    gain.gain.value = level;          // a new strip starts exactly where it should
    if (pan) pan.pan.value = place;
    strip = voiceStrips[voice] = { gain, pan, out };
    return strip.gain;
  }
  // Changes glide over a few ms (no clicks), starting at the step's own time,
  // so a locked or changed value lands on its step
  const when = Math.max(audioCtx.currentTime, t === undefined ? 0 : t);
  strip.gain.gain.setTargetAtTime(level, when, 0.005);
  if (strip.pan) strip.pan.pan.setTargetAtTime(place, when, 0.005);
  return strip.gain;
}

let playingVoice = null;  // the voice being played, so one engine can serve several voices
const VOICE_ORDER = ['kick', 'snare', 'lead', 'bass', 'noise'];
function voiceIndexNow() { const i = VOICE_ORDER.indexOf(playingVoice); return i < 0 ? 2 : i; }

function withVoiceStrip(voice, play, t) {
  const voiceBefore = playingVoice;
  playingVoice = voice;
  if (!audioCtx || !(voice in MIX_INDEX)) { try { return play(); } finally { playingVoice = voiceBefore; } }
  const before = voiceDest;
  voiceDest = voiceStrip(voice, t);
  if (t !== undefined) filterEnvHit(voice, t);
  if (t !== undefined && !ownsEnvelope(voice)) {
    const shaper = envShaper(voice, t, voiceDest);
    if (shaper) voiceDest = shaper;
  }
  try { return play(); } finally { voiceDest = before; playingVoice = voiceBefore; }
}

// ============ ENVELOPES (XEnv $1060-$1073) ============
// Every voice's A, D, S, R bytes shape its sound. Lead, bass, FM and SID
// engines take the envelope themselves. The others (drums, noise, speech)
// play their own shape, and a per-hit gain follows the envelope on top:
// rise over A, fall to S over D, hold S for one step, fade over R.
//   all four 0                 = not set, the engine's own shape
//   A 0, S 255, R 255          = neutral, also the engine's own shape
//   R 255 on these engines     = let the sound ring out
const NATIVE_ENV = new Set(['lead', 'bass', 'fm', 'sid', 'wave', 'pokey']);
// Only the note voices: a wave or pokey kick is shaped like the other drums
function ownsEnvelope(voice) {
  return (voice === 'lead' || voice === 'bass') && NATIVE_ENV.has(getVoiceSynth(voice));
}
let gateSeconds = 0;   // one step, set by the sequencer as it plays

function shaperEnvelope(voice) {
  const base = VOICES[voice].adsr;
  const a = MEM[base], d = MEM[base + 1], s = MEM[base + 2], r = MEM[base + 3];
  if (!(a | d | s | r)) return null;
  if (a === 0 && s === 255 && r === 255) return null;
  return { a: a / 255 * 0.5, d: d / 255 * 0.5, s: s / 255, r: r === 255 ? null : r / 254 * 1.0 };
}

function envShaper(voice, t, out) {
  const e = shaperEnvelope(voice);
  if (!e) return null;
  const g = audioCtx.createGain();
  const p = g.gain;
  const t1 = t + e.a;
  p.setValueAtTime(e.a > 0 ? 0 : 1, t);
  if (e.a > 0) p.linearRampToValueAtTime(1, t1);
  if (e.d > 0) p.linearRampToValueAtTime(Math.max(e.s, 0), t1 + e.d);
  else p.setValueAtTime(e.s, t1);
  const step = gateSeconds || 60 / engineBpm() / 4;
  const gateEnd = Math.max(t + step, t1 + e.d);
  let end = gateEnd + 2;
  if (e.r !== null) {
    p.setValueAtTime(e.s, gateEnd);
    p.linearRampToValueAtTime(0, gateEnd + Math.max(0.003, e.r));
    end = gateEnd + e.r + 0.05;
  }
  g.connect(out);
  if (audioCtx instanceof AudioContext) {
    setTimeout(() => g.disconnect(), Math.max(0, (end - audioCtx.currentTime) * 1000) + 4000);
  }
  return g;
}

// CAPS ($15F0-$15F3, little-endian): packs this machine implements, bits from memory-map.json.
// CORE, XVOICE, XENV, XFX, XTUNING, XMIXER, XVEL, XSTEP, XFM, XSID, XLPC
// CAPS ($15F0-$15F3): the packs this engine makes audible. A page ORs these
// into whatever its core already declared (CORE, XSONG, XSTEP ...).
// XVOICE, XENV, XFX, XTUNING, XMIXER, XVEL, XFM, XSID, XLPC, XWAVE
const ENGINE_CAPS = ((1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 8) | (1 << 9) | (1 << 30) | (1 << 31)) >>> 0;
// CAPS_EXT ($15F5-$15F8) holds bits 32-63. XPOKEY is bit 33 and XFAULT
// bit 34, so bits 1 and 2 here.
const ENGINE_CAPS_EXT = ((1 << (33 - 32)) | (1 << (34 - 32))) >>> 0;
function orCapsWord(addr, bits) {
  const v = ((MEM[addr] | (MEM[addr + 1] << 8) | (MEM[addr + 2] << 16) | (MEM[addr + 3] << 24)) | bits) >>> 0;
  MEM[addr] = v & 0xFF; MEM[addr + 1] = (v >> 8) & 0xFF; MEM[addr + 2] = (v >> 16) & 0xFF; MEM[addr + 3] = (v >>> 24) & 0xFF;
}
function writeEngineCaps() {
  orCapsWord(0x15F0, ENGINE_CAPS);
  orCapsWord(0x15F5, ENGINE_CAPS_EXT);
  if (!MEM[0x15F4]) MEM[0x15F4] = 1;  // SPEC_VERSION
}

// ============ UNISON (XVoice $105C-$105F) ============
// Plays several copies of a lead or bass note, each tuned slightly apart
// and spread across the stereo field. Spread = total width in cents.
// Count: 0 = auto (2 copies when spread is set), 1 = off, 2-7 copies.
const UNISON_ADDR = { lead: 0x105C, bass: 0x105E };
let unisonCents = 0;     // pitch offset for the copy being built
let unisonDest = null;   // output for the copy being built

function unisonSettings(voice) {
  const a = UNISON_ADDR[voice];
  const spread = Math.min(100, MEM[a] || 0);
  let count = MEM[a + 1] || 0;
  if (count === 0) count = spread > 0 ? 2 : 1;
  return { spread, count: Math.max(1, Math.min(7, count)) };
}

function playWithUnison(voice, play) {
  const { spread, count } = unisonSettings(voice);
  if (count <= 1 || spread === 0 || !audioCtx) return play();
  const out = voiceDest || masterBus || audioCtx.destination;
  const level = 1 / Math.sqrt(count);  // keep overall loudness steady
  for (let i = 0; i < count; i++) {
    const x = i / (count - 1) - 0.5;   // -0.5 .. +0.5
    const gain = audioCtx.createGain();
    gain.gain.value = level;
    if (audioCtx.createStereoPanner) {
      const pan = audioCtx.createStereoPanner();
      pan.pan.value = x * 1.6;
      gain.connect(pan).connect(out);
      if (audioCtx instanceof AudioContext) setTimeout(() => { gain.disconnect(); pan.disconnect(); }, 8000);
    } else {
      gain.connect(out);
      if (audioCtx instanceof AudioContext) setTimeout(() => gain.disconnect(), 8000);
    }
    unisonDest = gain;
    unisonCents = x * spread;
    try { play(); } finally { unisonDest = null; unisonCents = 0; }
  }
}


// ============ SYNTH REGISTRY ============
// Pattern: Register synthesis algorithms by name, voices reference them
// This allows packs to swap synth algorithms, users to add new voices
const SYNTHS = {};  // name → function(t, params, ctx)

// Synth lookup tables - index in memory → synth name
const SYNTH_IDS = {
  kick:  ['kick', 'kick808', 'kick909'],
  snare: ['snare', 'clap', 'rim'],
  lead:  ['lead'],
  bass:  ['bass'],
  noise: ['noise'],
};

// Get current synth for a voice (reads from memory!)
function getVoiceSynth(voiceName) {
  const voice = VOICES[voiceName];
  if (!voice) return null;
  const synthId = MEM[voice.synthAddr] || 0;
  const synthList = SYNTH_IDS[voiceName] || [voice.synth];
  if (synthId >= synthList.length) engineFault(3, voice.synthAddr);   // names no engine: play the first
  return synthList[synthId] || synthList[0];
}

// API: Register a new synth algorithm
function registerSynth(name, fn) {
  SYNTHS[name] = fn;
  console.log(`[SYNTH] Registered: ${name}`);
}

// API: Add a new voice or modify existing
function registerVoice(name, config) {
  VOICES[name] = { ...VOICES[name], ...config };
  console.log(`[VOICE] Registered: ${name} → synth:${config.synth || VOICES[name]?.synth}`);
}

// API: Swap a voice's synth algorithm
function setVoiceSynth(voiceName, synthName) {
  if (VOICES[voiceName] && SYNTHS[synthName]) {
    VOICES[voiceName].synth = synthName;
    console.log(`[VOICE] ${voiceName} now uses synth: ${synthName}`);
  }
}

// Helper: get voice params from memory
function getVoiceParams(voice, step) {
  return voice.paramAddrs.map(addr => MEM[addr + step]);
}

// ============ SYNTH IMPLEMENTATIONS ============
// Register: SYNTHS['name'] = (t, note, params) => { ... }

// Character params: 0x1050=decay, 0x1051=sweep, 0x1052=click, 0x1053=sub
// Kick: parameterized for 808/909 style via character memory
SYNTHS['kick'] = function(t, note, params) {
  const pitch = params[0] || note;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const f = pitch > 0 ? midiHz(pitch) : 60;
  const decayParam = MEM[0x1050] || 100;
  const sweepParam = MEM[0x1051] || 90;
  const clickParam = MEM[0x1052] || 0;
  const subParam = MEM[0x1053] || 50;
  const decay = 0.15 + (decayParam / 255) * 0.6;
  const sweep = 1.5 + (sweepParam / 255) * 6;
  const clickLevel = clickParam / 255 * 0.4;
  const subLevel = subParam / 255 * 0.5;
  osc.frequency.setValueAtTime(f * sweep, t);
  osc.frequency.exponentialRampToValueAtTime(f, t + 0.06);
  gain.gain.setValueAtTime(0.7, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + decay);
  osc.connect(gain).connect(getAudioDest());
  osc.start(t); osc.stop(t + decay + 0.05);
  if (clickLevel > 0.05) {
    const click = audioCtx.createOscillator();
    const clickGain = audioCtx.createGain();
    click.type = 'square';
    click.frequency.setValueAtTime(1200, t);
    click.frequency.exponentialRampToValueAtTime(200, t + 0.01);
    clickGain.gain.setValueAtTime(clickLevel, t);
    clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
    click.connect(clickGain).connect(getAudioDest());
    click.start(t); click.stop(t + 0.03);
  }
  if (subLevel > 0.05) {
    const sub = audioCtx.createOscillator();
    const subGain = audioCtx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(f * 0.5, t);
    subGain.gain.setValueAtTime(subLevel, t);
    subGain.gain.exponentialRampToValueAtTime(0.01, t + decay * 1.2);
    sub.connect(subGain).connect(getAudioDest());
    sub.start(t); sub.stop(t + decay * 1.2 + 0.05);
  }
};

// Snare: parameterized body/noise balance
SYNTHS['snare'] = function(t, note, params) {
  const tone = params[0] || 180;
  const snap = params[1] || 100;
  const bodyDecay = MEM[0x1054] || 80;
  const noiseLevel = MEM[0x1055] || 127;
  const bodyTune = MEM[0x1056] || 100;
  const noiseBright = MEM[0x1057] || 150;
  const bodyTime = 0.05 + (bodyDecay / 255) * 0.2;
  const noiseMix = noiseLevel / 255;
  const bodyMix = 1 - (noiseMix * 0.5);
  const hpFreq = 1000 + (noiseBright / 255) * 6000;
  const osc = audioCtx.createOscillator();
  const g1 = audioCtx.createGain();
  osc.type = 'triangle';
  const f = tone > 0 ? tone * (0.5 + bodyTune/255) : 180;
  osc.frequency.setValueAtTime(f * 1.8, t);
  osc.frequency.exponentialRampToValueAtTime(f, t + 0.02);
  g1.gain.setValueAtTime(0.5 * bodyMix, t);
  g1.gain.exponentialRampToValueAtTime(0.01, t + bodyTime);
  osc.connect(g1).connect(getAudioDest());
  osc.start(t); osc.stop(t + bodyTime + 0.05);
  const noiseDecay = snap > 0 ? snap / 1000 : 0.1;
  const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.2, audioCtx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const noise = audioCtx.createBufferSource();
  const filt = audioCtx.createBiquadFilter();
  const g2 = audioCtx.createGain();
  noise.buffer = buf;
  filt.type = 'highpass';
  filt.frequency.value = hpFreq;
  g2.gain.setValueAtTime(0.6 * noiseMix, t);
  g2.gain.exponentialRampToValueAtTime(0.01, t + noiseDecay);
  noise.connect(filt).connect(g2).connect(getAudioDest());
  noise.start(t); noise.stop(t + noiseDecay + 0.05);
};

// Lead: square wave with optional arp + ADSR
SYNTHS['lead'] = function(t, note, params, adsr = {a:0.01, d:0.1, s:0.5, r:0.2}) {
  const arp = params[0] || 0;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const f = noteToHz(note, 2); // voice index 2 = lead
  osc.type = 'square';

  // Vibrato LFO
  const lfo = audioCtx.createOscillator();
  const lfoGain = audioCtx.createGain();
  lfo.type = 'sine';
  lfo.frequency.value = 5;
  lfoGain.gain.setValueAtTime(0, t);
  lfoGain.gain.linearRampToValueAtTime(f * 0.02, t + 0.1);
  lfo.connect(lfoGain).connect(osc.frequency);

  if (arp === 1) { // Major arp
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.setValueAtTime(f * 1.26, t + 0.025);
    osc.frequency.setValueAtTime(f * 1.5, t + 0.05);
    osc.frequency.setValueAtTime(f, t + 0.075);
  } else if (arp === 2) { // Minor arp
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.setValueAtTime(f * 1.19, t + 0.025);
    osc.frequency.setValueAtTime(f * 1.5, t + 0.05);
    osc.frequency.setValueAtTime(f, t + 0.075);
  } else {
    osc.frequency.setValueAtTime(f, t);
  }

  // ADSR envelope
  const peakVol = 0.25;
  const sustainVol = peakVol * adsr.s;
  const totalTime = adsr.a + adsr.d + 0.1 + adsr.r;
  gain.gain.setValueAtTime(0.001, t);
  gain.gain.linearRampToValueAtTime(peakVol, t + adsr.a);
  gain.gain.linearRampToValueAtTime(Math.max(0.001, sustainVol), t + adsr.a + adsr.d);
  gain.gain.setValueAtTime(Math.max(0.001, sustainVol), t + adsr.a + adsr.d + 0.1);
  gain.gain.exponentialRampToValueAtTime(0.001, t + totalTime);

  osc.connect(gain).connect(getAudioDest());
  lfo.start(t);
  osc.start(t);
  lfo.stop(t + totalTime);
  osc.stop(t + totalTime + 0.01);
};

// Bass: sawtooth with FM and sub + ADSR
SYNTHS['bass'] = function(t, note, params, adsr = {a:0.005, d:0.1, s:0.7, r:0.15}) {
  const fm = params[0] || 0;
  const filt = params[1] || 50;
  const f = noteToHz(note, 3); // voice index 3 = bass
  const carrier = audioCtx.createOscillator();
  const filter = audioCtx.createBiquadFilter();
  const gain = audioCtx.createGain();
  carrier.type = 'sawtooth';
  carrier.frequency.setValueAtTime(f * 1.5, t);
  carrier.frequency.exponentialRampToValueAtTime(f, t + 0.02);
  if (fm > 0) {
    const mod = audioCtx.createOscillator();
    const mg = audioCtx.createGain();
    mod.frequency.value = f * 1.414;
    mg.gain.setValueAtTime(fm, t);
    mg.gain.exponentialRampToValueAtTime(1, t + 0.1);
    mod.connect(mg).connect(carrier.frequency);
    mod.start(t); mod.stop(t + 0.15);
  }

  // ADSR envelope
  const peakVol = 0.35;
  const sustainVol = peakVol * adsr.s;
  const totalTime = adsr.a + adsr.d + 0.1 + adsr.r;

  // Sub oscillator with ADSR
  const sub = audioCtx.createOscillator();
  const sg = audioCtx.createGain();
  sub.type = 'sine';
  sub.frequency.value = f / 2;
  sg.gain.setValueAtTime(0.001, t);
  sg.gain.linearRampToValueAtTime(peakVol, t + adsr.a);
  sg.gain.linearRampToValueAtTime(Math.max(0.001, sustainVol), t + adsr.a + adsr.d);
  sg.gain.exponentialRampToValueAtTime(0.001, t + totalTime);
  sub.connect(sg).connect(getAudioDest());
  sub.start(t); sub.stop(t + totalTime + 0.01);

  // Main carrier with ADSR
  filter.type = 'lowpass';
  filter.frequency.value = 100 + filt * 60;
  filter.Q.value = 4;
  gain.gain.setValueAtTime(0.001, t);
  gain.gain.linearRampToValueAtTime(peakVol, t + adsr.a);
  gain.gain.linearRampToValueAtTime(Math.max(0.001, sustainVol), t + adsr.a + adsr.d);
  gain.gain.exponentialRampToValueAtTime(0.001, t + totalTime);
  carrier.connect(filter).connect(gain).connect(getAudioDest());
  carrier.start(t); carrier.stop(t + totalTime + 0.01);
};

// Noise: hat or zap
SYNTHS['noise'] = function(t, note, params) {
  const y = params[0] || 5;
  const type = params[1] || 0;
  if (type === 1) { // Zap
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const startF = 2000 + (15 - y) * 200;
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(startF, t);
    osc.frequency.exponentialRampToValueAtTime(50, t + 0.1);
    gain.gain.setValueAtTime(0.4, t);
    gain.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
    osc.connect(gain).connect(getAudioDest());
    osc.start(t); osc.stop(t + 0.15);
  } else { // Hat
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.1, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = audioCtx.createBufferSource();
    const filt = audioCtx.createBiquadFilter();
    const gain = audioCtx.createGain();
    src.buffer = buf;
    filt.type = 'highpass';
    filt.frequency.value = 3000 + y * 400;
    const decay = y > 10 ? 0.03 : 0.08;
    gain.gain.setValueAtTime(0.3, t);
    gain.gain.exponentialRampToValueAtTime(0.01, t + decay);
    src.connect(filt).connect(gain).connect(getAudioDest());
    src.start(t); src.stop(t + decay + 0.02);
  }
};

// ============ PLAY VOICE (unified interface) ============
// ADSR helper: returns {a, d, s, r} in seconds/level from MEM bytes
function getADSR(voiceName) {
  const voice = VOICES[voiceName];
  if (!voice || !voice.adsr) return { a: 0.01, d: 0.1, s: 0.5, r: 0.2 };
  const base = voice.adsr;
  return {
    a: MEM[base] / 255 * 0.5,       // Attack: 0-500ms
    d: MEM[base + 1] / 255 * 0.5,   // Decay: 0-500ms
    s: MEM[base + 2] / 255,         // Sustain: 0-1 level
    r: MEM[base + 3] / 255 * 1.0    // Release: 0-1000ms
  };
}

function playVoice(voiceName, t, step) {
  const voice = VOICES[voiceName];
  if (!voice) return;
  const synthFn = SYNTHS[voice.synth];
  if (!synthFn) return;
  const note = MEM[voice.addr + step];
  const params = voice.paramAddrs.map(a => MEM[a + step]);
  const adsr = getADSR(voiceName);
  withVoiceStrip(voiceName, () => synthFn(t, note, params, adsr), t);
}

// ============ ALTERNATE SYNTHS (switchable via registry) ============

// Kick909: punchy, clicky, short - classic techno/house
SYNTHS['kick909'] = function(t, note, params) {
  const pitch = params[0] || 0;
  const f = pitch > 0 ? midiHz(pitch) : 55;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(f, t + 0.05);
  gain.gain.setValueAtTime(1, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + 0.15);
  osc.connect(gain).connect(getAudioDest());
  osc.start(t); osc.stop(t + 0.2);
  // Click transient
  const click = audioCtx.createOscillator();
  const cg = audioCtx.createGain();
  click.type = 'square';
  click.frequency.setValueAtTime(1500, t);
  click.frequency.exponentialRampToValueAtTime(100, t + 0.01);
  cg.gain.setValueAtTime(0.3, t);
  cg.gain.exponentialRampToValueAtTime(0.001, t + 0.015);
  click.connect(cg).connect(getAudioDest());
  click.start(t); click.stop(t + 0.02);
};

// Kick808: long, boomy, subby - classic hip-hop
SYNTHS['kick808'] = function(t, note, params) {
  const pitch = params[0] || 0;
  const f = pitch > 0 ? midiHz(pitch) : 45;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(f * 3, t);
  osc.frequency.exponentialRampToValueAtTime(f, t + 0.1);
  gain.gain.setValueAtTime(0.8, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + 0.5);
  osc.connect(gain).connect(getAudioDest());
  osc.start(t); osc.stop(t + 0.55);
  // Sub layer
  const sub = audioCtx.createOscillator();
  const sg = audioCtx.createGain();
  sub.type = 'sine';
  sub.frequency.value = f * 0.5;
  sg.gain.setValueAtTime(0.5, t);
  sg.gain.exponentialRampToValueAtTime(0.01, t + 0.6);
  sub.connect(sg).connect(getAudioDest());
  sub.start(t); sub.stop(t + 0.65);
};

// Clap: layered noise bursts
SYNTHS['clap'] = function(t, note, params) {
  for (let i = 0; i < 3; i++) {
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.02, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let j = 0; j < d.length; j++) d[j] = Math.random() * 2 - 1;
    const src = audioCtx.createBufferSource();
    const filt = audioCtx.createBiquadFilter();
    const gain = audioCtx.createGain();
    src.buffer = buf;
    filt.type = 'bandpass';
    filt.frequency.value = 1200;
    filt.Q.value = 2;
    gain.gain.setValueAtTime(0.5, t + i * 0.015);
    gain.gain.exponentialRampToValueAtTime(0.01, t + i * 0.015 + 0.1);
    src.connect(filt).connect(gain).connect(getAudioDest());
    src.start(t + i * 0.015);
  }
};

// Rimshot: short, snappy
SYNTHS['rim'] = function(t, note, params) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(800, t);
  osc.frequency.exponentialRampToValueAtTime(300, t + 0.01);
  gain.gain.setValueAtTime(0.5, t);
  gain.gain.exponentialRampToValueAtTime(0.01, t + 0.03);
  osc.connect(gain).connect(getAudioDest());
  osc.start(t); osc.stop(t + 0.04);
};

// ============ FM SYNTH (XFM PACK) ============
// 4-operator FM, wired like the Yamaha YM2151 (arcade) and YM2612 (Genesis).
// Each operator is an oscillator whose output either reaches the speaker
// (a carrier) or pushes another operator's frequency around (a modulator).
// mods[i] lists the operators that modulate operator i; index 0 is OP1, the
// operator you always hear, and 3 is OP4, the top of the stack.
// The algorithm numbers are the chips' own, so a patch written for a YM2151
// or YM2612 keeps its algorithm.
const FM_ALGORITHMS = [
  { carriers: [0],          mods: [[1], [2], [3], []] },     // 0: 4>3>2>1, one stack
  { carriers: [0],          mods: [[1], [2, 3], [], []] },   // 1: (4+3)>2>1
  { carriers: [0],          mods: [[1, 3], [2], [], []] },   // 2: (4+(3>2))>1
  { carriers: [0],          mods: [[1, 2], [], [3], []] },   // 3: ((4>3)+2)>1
  { carriers: [0, 2],       mods: [[1], [], [3], []] },      // 4: (4>3)+(2>1), two stacks
  { carriers: [0, 1, 2],    mods: [[3], [3], [3], []] },     // 5: 4>(3,2,1)
  { carriers: [0, 1, 2],    mods: [[], [], [3], []] },       // 6: (4>3)+2+1
  { carriers: [0, 1, 2, 3], mods: [[], [], [], []] },        // 7: 4+3+2+1, organ
];
// DT1 ($1912-$1915): the YM2151's small detune, as a ratio. 0 and 4 are both none.
const FM_DT1 = [1, 1.0006, 1.0012, 1.0018, 1, 0.9994, 0.9988, 0.9982];
const FM_INDEX = 8;   // modulation index of a modulator at level 255

function fmRatio(b) { return b === 0 ? 0.5 : b / 16; }

// Operator feedback: the operator's own output nudges its phase,
// y = wave(phase + beta * y), averaged over the last two samples as the
// Yamaha chips do. A sine with feedback leans toward a saw. The result is
// periodic, so it is worked out once per amount and kept as a PeriodicWave.
const fmWaveCache = new WeakMap();   // audio context -> Map(key -> PeriodicWave)
function fmFeedbackWave(wave, fb) {
  let cache = fmWaveCache.get(audioCtx);
  if (!cache) fmWaveCache.set(audioCtx, cache = new Map());
  const key = wave * 256 + fb;
  if (cache.has(key)) return cache.get(key);
  const W = [
    p => Math.sin(2 * Math.PI * p),
    p => 2 * (p - Math.floor(p + 0.5)),
    p => (p - Math.floor(p) < 0.5 ? 1 : -1),
    p => 1 - 4 * Math.abs(p - Math.floor(p + 0.5))
  ][wave];
  const N = 256, beta = fb / 255 * 1.8 / (2 * Math.PI);
  const x = new Float32Array(N);
  let y1 = 0, y2 = 0;
  for (let cycle = 0; cycle < 8; cycle++) {
    for (let n = 0; n < N; n++) {
      const y = W(n / N + beta * (y1 + y2) / 2);
      y2 = y1; y1 = y;
      if (cycle === 7) x[n] = y;
    }
  }
  const H = 96, real = new Float32Array(H + 1), imag = new Float32Array(H + 1);
  for (let k = 1; k <= H; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) { const a = 2 * Math.PI * k * n / N; re += x[n] * Math.cos(a); im += x[n] * Math.sin(a); }
    real[k] = 2 * re / N;
    imag[k] = 2 * im / N;
  }
  const pw = audioCtx.createPeriodicWave(real, imag, { disableNormalization: true });
  cache.set(key, pw);
  return pw;
}

SYNTHS['fm'] = function(t, note, params, adsr) {
  const f = noteToHz(note, voiceIndexNow());
  const algo = FM_ALGORITHMS[MEM[XFM.ALGORITHM] & 7];
  const dest = getAudioDest();
  const waveTypes = ['sine', 'sawtooth', 'square', 'triangle'];
  const ops = [], opGains = [], hz = [];
  let last = t;

  for (let i = 0; i < 4; i++) {
    const baseAddr = XFM.OP1_RATIO + i * 4;
    const freq = f * fmRatio(MEM[baseAddr]) * FM_DT1[MEM[XFM.OP1_DT1 + i] & 7];
    const level = MEM[baseAddr + 1] / 255;
    const wave = MEM[baseAddr + 3] & 3;
    // OP4 is the chip's feedback operator: the global amount adds to it
    const fb = Math.min(255, MEM[baseAddr + 2] + (i === 3 ? MEM[XFM.GLOBAL_FB] : 0));

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    if (fb > 0) osc.setPeriodicWave(fmFeedbackWave(wave, fb));
    else osc.type = waveTypes[wave];
    osc.frequency.value = freq;

    // Operator envelope from XFM memory
    const envBase = XFM.OP1_A + i * 4;
    const a = (MEM[envBase] / 255) * 0.5;
    const d = (MEM[envBase + 1] / 255) * 0.5;
    const s = MEM[envBase + 2] / 255;
    const r = (MEM[envBase + 3] / 255) * 1.0;
    const totalTime = a + d + 0.1 + r;

    const sustainVol = level * s;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(Math.max(0.0001, level), t + a + 0.001);
    gain.gain.linearRampToValueAtTime(Math.max(0.0001, sustainVol), t + a + d + 0.001);
    gain.gain.setValueAtTime(Math.max(0.0001, sustainVol), t + a + d + 0.1);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + totalTime + 0.002);

    osc.connect(gain);
    ops.push(osc);
    opGains.push(gain);
    hz.push(freq);
    osc.start(t);
    osc.stop(t + totalTime + 0.05);
    last = Math.max(last, t + totalTime + 0.05);
  }

  // A modulator's output, scaled to its own frequency, moves the target's frequency:
  // that is a modulation index of FM_INDEX * level
  const extra = [];
  for (let i = 0; i < 4; i++) {
    for (const m of algo.mods[i]) {
      const depth = audioCtx.createGain();
      depth.gain.value = FM_INDEX * hz[m];
      opGains[m].connect(depth).connect(ops[i].frequency);
      extra.push(depth);
    }
  }

  // Carriers to the output, a little quieter when several sound at once
  const mix = audioCtx.createGain();
  mix.gain.value = 0.45 / Math.sqrt(algo.carriers.length);
  for (const c of algo.carriers) opGains[c].connect(mix);
  mix.connect(dest);
  if (audioCtx instanceof AudioContext) {
    setTimeout(() => { mix.disconnect(); extra.forEach(n => n.disconnect()); }, Math.max(0, (last - audioCtx.currentTime) * 1000) + 500);
  }
};

// Register FM as a lead synth option
SYNTH_IDS.lead.push('fm');

// ============ SID SYNTH (XSID PACK) ============
// Commodore 64 SID 6581 inspired synthesis
// Ring modulation, oscillator sync, multimode filter
const XSID = {
  OSC1_WAVE:     0x1A00,  // 0=tri, 1=saw, 2=pulse, 3=noise
  OSC1_DUTY:     0x1A01,  // Pulse width 0-255
  OSC1_SYNC:     0x1A02,  // Sync to OSC2 (bit 0)
  OSC1_RING:     0x1A03,  // Ring mod with OSC2 (bit 0)
  OSC2_WAVE:     0x1A04,
  OSC2_DUTY:     0x1A05,
  OSC2_DETUNE:   0x1A06,  // Detune cents (-128 to +127)
  OSC2_OCTAVE:   0x1A07,  // Octave offset (-2 to +2, stored as 0-4)
  OSC3_WAVE:     0x1A08,
  OSC3_DUTY:     0x1A09,
  OSC3_DETUNE:   0x1A0A,
  OSC3_OCTAVE:   0x1A0B,
  FILTER_ROUTE:  0x1A0C,  // Which oscs hit filter (bits 0-2)
  FILTER_TYPE:   0x1A0D,  // 0=LP, 1=HP, 2=BP, 3=Notch
  FILTER_CUTOFF: 0x1A0E,  // 0-255
  FILTER_RESO:   0x1A0F,  // 0-255 (famous SID resonance!)
};

// Initialize XSID defaults
function initXSIDDefaults() {
  if (!regionBlank(0x1A00, 0x1A0F)) return;
  MEM[XSID.OSC1_WAVE] = 2;     // Pulse
  MEM[XSID.OSC1_DUTY] = 128;   // 50% duty
  MEM[XSID.OSC2_WAVE] = 1;     // Saw
  MEM[XSID.OSC2_DETUNE] = 133; // +5 cents (128 = center)
  MEM[XSID.OSC2_OCTAVE] = 2;   // Same octave
  MEM[XSID.OSC3_WAVE] = 0;     // Triangle (sub)
  MEM[XSID.OSC3_OCTAVE] = 1;   // -1 octave
  MEM[XSID.FILTER_ROUTE] = 7;  // All through filter
  MEM[XSID.FILTER_TYPE] = 0;   // Lowpass
  MEM[XSID.FILTER_CUTOFF] = 200;
  MEM[XSID.FILTER_RESO] = 100;
}

// SID-style synth with 3 oscillators, ring mod, sync, filter
SYNTHS['sid'] = function(t, note, params, adsr = {a:0.01, d:0.15, s:0.6, r:0.25}) {
  const baseF = noteToHz(note, voiceIndexNow());
  const dest = getAudioDest();
  const waveTypes = ['triangle', 'sawtooth', 'square', 'custom']; // custom = noise

  // Create filter (the famous SID filter!)
  const filter = audioCtx.createBiquadFilter();
  const filterTypes = ['lowpass', 'highpass', 'bandpass', 'notch'];
  filter.type = filterTypes[MEM[XSID.FILTER_TYPE] & 3];
  filter.frequency.value = 100 + (MEM[XSID.FILTER_CUTOFF] / 255) * 7900;
  // SID resonance is legendary - can self-oscillate
  filter.Q.value = 0.5 + (MEM[XSID.FILTER_RESO] / 255) * 25;
  filter.connect(dest);

  const peakVol = 0.2;
  const sustainVol = peakVol * adsr.s;
  const totalTime = adsr.a + adsr.d + 0.15 + adsr.r;

  // Create 3 oscillators
  const oscs = [];
  const gains = [];

  for (let i = 0; i < 3; i++) {
    const baseAddr = XSID.OSC1_WAVE + i * 4;
    const wave = MEM[baseAddr] & 3;
    const duty = MEM[baseAddr + 1] || 128;
    const detune = (MEM[baseAddr + 2] || 128) - 128; // -128 to +127 cents
    const octave = (MEM[baseAddr + 3] || 2) - 2;     // -2 to +2 octaves

    // Calculate frequency with octave and detune
    let f = baseF * Math.pow(2, octave);
    f *= Math.pow(2, detune / 1200); // cents to ratio

    let osc;
    if (wave === 3) {
      // Noise oscillator
      const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.5, audioCtx.sampleRate);
      const d = buf.getChannelData(0);
      for (let j = 0; j < d.length; j++) d[j] = Math.random() * 2 - 1;
      osc = audioCtx.createBufferSource();
      osc.buffer = buf;
      osc.loop = true;
    } else {
      osc = audioCtx.createOscillator();
      osc.type = waveTypes[wave];
      osc.frequency.value = f;

      // Pulse width for square wave (fake it with phase offset)
      if (wave === 2 && duty !== 128) {
        // Create a second oscillator for PWM effect
        const pwmOsc = audioCtx.createOscillator();
        const pwmGain = audioCtx.createGain();
        pwmOsc.type = 'sawtooth';
        pwmOsc.frequency.value = f;
        // Invert and offset based on duty cycle
        pwmGain.gain.value = (duty - 128) / 255;
        pwmOsc.connect(pwmGain);
        const mixer = audioCtx.createGain();
        mixer.gain.value = 0.5;
        pwmGain.connect(mixer);
        pwmOsc.start(t);
        pwmOsc.stop(t + totalTime);
      }
    }

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.linearRampToValueAtTime(peakVol / 3, t + adsr.a);
    gain.gain.linearRampToValueAtTime(Math.max(0.001, sustainVol / 3), t + adsr.a + adsr.d);
    gain.gain.exponentialRampToValueAtTime(0.001, t + totalTime);

    oscs.push(osc);
    gains.push(gain);

    // Route through filter or direct based on FILTER_ROUTE
    const routeToFilter = (MEM[XSID.FILTER_ROUTE] >> i) & 1;
    if (wave !== 3) osc.connect(gain);
    else osc.connect(gain);

    if (routeToFilter) {
      gain.connect(filter);
    } else {
      gain.connect(dest);
    }

    osc.start(t);
    osc.stop(t + totalTime + 0.05);
  }

  // Ring modulation: OSC1 amplitude modulated by OSC2
  if (MEM[XSID.OSC1_RING] & 1) {
    // Ring mod = multiply two signals
    // In Web Audio, we use a gain node whose gain is modulated
    const ringMod = audioCtx.createGain();
    ringMod.gain.value = 0;
    // OSC2 modulates the gain of OSC1
    gains[1].connect(ringMod.gain);
    // Reconnect OSC1 through ring mod
    gains[0].disconnect();
    gains[0].connect(ringMod);
    const routeToFilter = MEM[XSID.FILTER_ROUTE] & 1;
    if (routeToFilter) {
      ringMod.connect(filter);
    } else {
      ringMod.connect(dest);
    }
  }

  // Hard sync: OSC1 synced to OSC2 (simplified - restart OSC1 at OSC2 frequency)
  if (MEM[XSID.OSC1_SYNC] & 1) {
    // True hard sync isn't possible in Web Audio without AudioWorklet
    // Fake it by adding harmonics
    if (oscs[0].type) {
      // Add extra harmonics to simulate sync "buzz"
      const syncOsc = audioCtx.createOscillator();
      const syncGain = audioCtx.createGain();
      const f2 = oscs[1].frequency ? oscs[1].frequency.value : baseF;
      syncOsc.type = 'sawtooth';
      syncOsc.frequency.value = f2 + (baseF % f2); // Residual frequency
      syncGain.gain.value = 0.15;
      syncGain.gain.exponentialRampToValueAtTime(0.001, t + totalTime * 0.5);
      syncOsc.connect(syncGain);
      const routeToFilter = MEM[XSID.FILTER_ROUTE] & 1;
      if (routeToFilter) {
        syncGain.connect(filter);
      } else {
        syncGain.connect(dest);
      }
      syncOsc.start(t);
      syncOsc.stop(t + totalTime);
    }
  }
};

// Register SID as synth options
SYNTH_IDS.lead.push('sid');
SYNTH_IDS.bass.push('sid');

// ============ XLPC: SPEAK & SPELL SPEECH ($14E0-$14E6) ============
// Linear predictive coding, the TMS5220 way: a buzz (vocal cords) or
// noise (breath) source, shaped by three formant filters (the mouth).
// The note picks the phoneme: C4 (60) = EE, C#4 = IH, ... 30 in all.
const LPC = {
  PHONEME:   0x14E0,  // 0 = from the note, 1-30 = force a phoneme
  PITCH:     0x14E1,  // 128 = no change, +/- one octave
  ENERGY:    0x14E2,  // loudness, 0 = default
  VOICING:   0x14E3,  // 0 = auto, 1 = always buzz, 2 = always noise
  RESONANCE: 0x14E4,  // formant sharpness, 0 = default
  FORMANT:   0x14E5,  // 128 = none; shifts the mouth up or down
  BUZZ:      0x14E6   // buzz pulse width, 0 = default
};

const PHONEMES = [
  // Vowels: formants F1, F2, F3 in Hz (average adult)
  { name: 'EE', f1: 270, f2: 2290, f3: 3010, voiced: true },
  { name: 'IH', f1: 390, f2: 1990, f3: 2550, voiced: true },
  { name: 'EH', f1: 530, f2: 1840, f3: 2480, voiced: true },
  { name: 'AE', f1: 660, f2: 1720, f3: 2410, voiced: true },
  { name: 'AH', f1: 730, f2: 1090, f3: 2440, voiced: true },
  { name: 'AW', f1: 570, f2: 840,  f3: 2410, voiced: true },
  { name: 'UH', f1: 440, f2: 1020, f3: 2240, voiced: true },
  { name: 'OO', f1: 300, f2: 870,  f3: 2240, voiced: true },
  { name: 'OH', f1: 490, f2: 1350, f3: 1690, voiced: true },
  { name: 'ER', f1: 490, f2: 1350, f3: 1690, voiced: true },
  // Voiced consonants
  { name: 'L',  f1: 350, f2: 1050, f3: 2880, voiced: true },
  { name: 'R',  f1: 420, f2: 1300, f3: 1600, voiced: true },
  { name: 'W',  f1: 300, f2: 610,  f3: 2200, voiced: true },
  { name: 'Y',  f1: 300, f2: 2200, f3: 3050, voiced: true },
  { name: 'M',  f1: 280, f2: 900,  f3: 2200, voiced: true },
  { name: 'N',  f1: 280, f2: 1700, f3: 2600, voiced: true },
  // Unvoiced: noise
  { name: 'S',  f1: 0,   f2: 0,    f3: 5000, voiced: false },
  { name: 'SH', f1: 0,   f2: 0,    f3: 2500, voiced: false },
  { name: 'F',  f1: 0,   f2: 0,    f3: 4000, voiced: false },
  { name: 'TH', f1: 0,   f2: 0,    f3: 5500, voiced: false },
  { name: 'HH', f1: 500, f2: 1500, f3: 2500, voiced: false },
  // Plosives: short bursts
  { name: 'P',  f1: 400, f2: 1000, f3: 2500, voiced: false, plosive: true },
  { name: 'T',  f1: 400, f2: 1800, f3: 3000, voiced: false, plosive: true },
  { name: 'K',  f1: 400, f2: 2000, f3: 3200, voiced: false, plosive: true },
  { name: 'B',  f1: 400, f2: 1000, f3: 2500, voiced: true,  plosive: true },
  { name: 'D',  f1: 400, f2: 1800, f3: 3000, voiced: true,  plosive: true },
  { name: 'G',  f1: 400, f2: 2000, f3: 3200, voiced: true,  plosive: true },
  // Special
  { name: 'ZZ', f1: 270, f2: 2290, f3: 3010, voiced: true },   // robot buzz
  { name: 'XX', f1: 0,   f2: 0,    f3: 2000, voiced: false },  // noise burst
  { name: '--', silent: true }                                  // silence
];

// Notes below C4 wrap around, so any note picks some phoneme
function noteToPhoneme(note) {
  return PHONEMES[(((note - 60) % 30) + 30) % 30];
}

const lpcWaveCache = new WeakMap();  // buzz waveforms per audio context, by pulse width

SYNTHS['lpc'] = function(t, note, params) {
  const forced = MEM[LPC.PHONEME];
  const phoneme = forced > 0 && forced <= 30 ? PHONEMES[forced - 1] : noteToPhoneme(note);
  if (!phoneme || phoneme.silent) return;

  const pitch = midiHz(note) * Math.pow(2, ((MEM[LPC.PITCH] || 128) - 128) / 128);
  const energy = (MEM[LPC.ENERGY] || 200) / 255;
  const voicing = MEM[LPC.VOICING];
  const q = (MEM[LPC.RESONANCE] || 180) / 255 * 30 + 1;
  const shift = Math.pow(2, (((MEM[LPC.FORMANT] || 128) - 128) / 128) * 0.5);  // up to half an octave
  const widthByte = MEM[LPC.BUZZ] || 64;
  const duration = phoneme.plosive ? 0.08 : 0.25;
  const voiced = voicing === 1 ? true : voicing === 2 ? false : phoneme.voiced;

  // Excitation: buzz from the vocal cords, or noise from breath
  let source;
  if (voiced) {
    if (!lpcWaveCache.has(audioCtx)) lpcWaveCache.set(audioCtx, {});
    const lpcWaves = lpcWaveCache.get(audioCtx);
    if (!lpcWaves[widthByte]) {
      const width = widthByte / 255;
      const real = new Float32Array(32), imag = new Float32Array(32);
      for (let n = 1; n < 32; n++) imag[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * width);
      lpcWaves[widthByte] = audioCtx.createPeriodicWave(real, imag);
    }
    source = audioCtx.createOscillator();
    source.setPeriodicWave(lpcWaves[widthByte]);
    source.frequency.value = pitch;
  } else {
    const buf = audioCtx.createBuffer(1, Math.ceil(audioCtx.sampleRate * duration), audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    source = audioCtx.createBufferSource();
    source.buffer = buf;
  }

  // The mouth: three band-pass formant filters in parallel
  const mix = audioCtx.createGain();
  mix.gain.value = energy * 1.5;  // band-pass filters cut a lot of level
  [[phoneme.f1 || 400, 1.0, 1.0], [phoneme.f2 || 1200, 0.8, 0.7], [phoneme.f3 || 2500, 0.6, 0.4]].forEach(([f, qScale, level]) => {
    const bp = audioCtx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f * shift;
    bp.Q.value = q * qScale;
    const g = audioCtx.createGain();
    g.gain.value = level;
    source.connect(bp).connect(g).connect(mix);
  });

  // Envelope: sharp for plosives, smoother for vowels
  const env = audioCtx.createGain();
  env.gain.setValueAtTime(0, t);
  if (phoneme.plosive) {
    env.gain.linearRampToValueAtTime(1, t + 0.01);
  } else {
    env.gain.linearRampToValueAtTime(1, t + 0.02);
    env.gain.setValueAtTime(1, t + duration - 0.05);
  }
  env.gain.exponentialRampToValueAtTime(0.01, t + duration);
  mix.connect(env).connect(getAudioDest());

  source.start(t);
  source.stop(t + duration);
};
SYNTH_IDS.lead.push('lpc');  // lead engine 3
SYNTH_IDS.bass.push('lpc');  // bass engine 2

// ============ XWAVE: WAVETABLE VOICE ($1A20-$1A3F) ============
// One cycle of a waveform as 32 signed bytes, like the Namco WSG and Konami
// SCC chips. The engine plays that shape at the note's pitch. The 32 steps are
// kept as steps (a staircase), which is where the chip-like grit comes from,
// and turned into a band-limited oscillator so high notes do not alias.
const XWAVE = { TABLE: 0x1A20, SIZE: 32, MODE: 0x1A40 };   // MODE: 0 = SCC 8-bit, 1 = WSG 4-bit
const waveCache = new WeakMap();   // audio context -> { key, wave }

function initXWAVEDefaults() {
  if (!regionBlank(XWAVE.TABLE, XWAVE.TABLE + XWAVE.SIZE - 1)) return;
  // A sine, so the first sound is gentle; draw your own over it
  for (let i = 0; i < XWAVE.SIZE; i++) MEM[XWAVE.TABLE + i] = Math.round(Math.sin(2 * Math.PI * i / XWAVE.SIZE) * 100) & 255;
}

function wavePeriodic() {
  const bytes = MEM.subarray(XWAVE.TABLE, XWAVE.TABLE + XWAVE.SIZE);
  const wsg = (MEM[XWAVE.MODE] & 1) === 1;
  const key = (wsg ? 'w' : 's') + Array.from(bytes).join(',');
  const hit = waveCache.get(audioCtx);
  if (hit && hit.key === key) return hit.wave;
  const HOLD = 8, N = XWAVE.SIZE * HOLD, H = N / 2;
  const x = new Float32Array(N);
  // The Namco WSG stored 4 bits a sample: 16 levels. The Konami SCC stored 8.
  const level = b => { const v = b > 127 ? b - 256 : b; return wsg ? (Math.round((v + 128) / 255 * 15) / 7.5 - 1) : v / 128; };
  for (let n = 0; n < N; n++) x[n] = level(bytes[Math.floor(n / HOLD)]);
  const real = new Float32Array(H + 1), imag = new Float32Array(H + 1);
  for (let k = 1; k <= H; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) { const a = 2 * Math.PI * k * n / N; re += x[n] * Math.cos(a); im += x[n] * Math.sin(a); }
    real[k] = (2 / N) * re;
    imag[k] = (2 / N) * im;
  }
  const wave = audioCtx.createPeriodicWave(real, imag, { disableNormalization: true });
  waveCache.set(audioCtx, { key, wave });
  return wave;
}

SYNTHS['wave'] = function(t, note, params, adsr = {a:0.005, d:0.1, s:0.7, r:0.15}) {
  if (!note) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.setPeriodicWave(wavePeriodic());
  osc.frequency.setValueAtTime(noteToHz(note, voiceIndexNow()), t);
  const peak = 0.3, sustain = Math.max(0.001, peak * adsr.s);
  const total = adsr.a + adsr.d + 0.1 + adsr.r;
  gain.gain.setValueAtTime(0.001, t);
  gain.gain.linearRampToValueAtTime(peak, t + adsr.a);
  gain.gain.linearRampToValueAtTime(sustain, t + adsr.a + adsr.d);
  gain.gain.setValueAtTime(sustain, t + adsr.a + adsr.d + 0.1);
  gain.gain.exponentialRampToValueAtTime(0.001, t + total);
  osc.connect(gain).connect(getAudioDest());
  osc.start(t);
  osc.stop(t + total + 0.01);
};
SYNTH_IDS.lead.push('wave');  // lead engine 4
SYNTH_IDS.bass.push('wave');  // bass engine 3

// Engines that play differently per voice: VOICE_SYNTHS[voice][engine]
const VOICE_SYNTHS = { kick: {}, snare: {}, lead: {}, bass: {}, noise: {} };

// ============ WAVE DRUMS (XWAVE) ============
// The Namco WSG and Konami SCC had no noise channel and no drum circuit:
// every drum was the wavetable, played fast and bent. These do the same with
// the table at $1A20. The "noise" is the table jumping to a random pitch
// about every half millisecond.
function waveHop(t, dur, lo, hi, level, out) {
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.setPeriodicWave(wavePeriodic());
  const hop = 0.0006;
  for (let x = 0; x < dur; x += hop) osc.frequency.setValueAtTime(lo * Math.pow(hi / lo, Math.random()), t + x);
  g.gain.setValueAtTime(level, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(g).connect(out);
  osc.start(t); osc.stop(t + dur + 0.01);
}

VOICE_SYNTHS.kick.wave = function(t, note, params) {
  const out = getAudioDest();
  const f = midiHz(params[0] || 36) * Math.pow(2, (tuningFromMem(0).cents) / 1200);
  const decay = 0.12 + (MEM[0x1050] || 100) / 255 * 0.35;     // KICK_DECAY
  const sweep = 2 + (MEM[0x1051] || 90) / 255 * 6;             // KICK_SWEEP
  const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
  osc.setPeriodicWave(wavePeriodic());
  osc.frequency.setValueAtTime(f * sweep, t);
  osc.frequency.exponentialRampToValueAtTime(f, t + 0.04);
  g.gain.setValueAtTime(1.0, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + decay);
  osc.connect(g).connect(out);
  osc.start(t); osc.stop(t + decay + 0.02);
};

VOICE_SYNTHS.snare.wave = function(t, note, params) {
  const out = getAudioDest();
  const tone = params[0] || 180, snap = params[1] || 100;
  const body = 0.04 + (MEM[0x1054] || 80) / 255 * 0.12;        // SNARE_BODY_DECAY
  const noise = (MEM[0x1055] || 127) / 255;                     // SNARE_NOISE_LEVEL
  const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
  osc.setPeriodicWave(wavePeriodic());
  osc.frequency.setValueAtTime(140 + tone, t);
  osc.frequency.exponentialRampToValueAtTime(70 + tone * 0.4, t + 0.03);
  g.gain.setValueAtTime(0.5, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + body);
  osc.connect(g).connect(out);
  osc.start(t); osc.stop(t + body + 0.02);
  waveHop(t, 0.05 + snap / 255 * 0.1, 1500, 9000, 0.12 + noise * 0.3, out);
};

VOICE_SYNTHS.noise.wave = function(t, note, params) {
  const y = params[0] || 5, type = params[1] || 0;
  const out = getAudioDest();
  if (type === 1) {   // zap: the table swept down
    const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
    osc.setPeriodicWave(wavePeriodic());
    osc.frequency.setValueAtTime(1200 + (15 - Math.min(15, y)) * 150, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.12);
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(g).connect(out);
    osc.start(t); osc.stop(t + 0.13);
    return;
  }
  const bright = Math.min(15, y) / 15;
  waveHop(t, y > 10 ? 0.03 : 0.07, 2500 + bright * 3000, 12000, 0.4, out);
};
SYNTH_IDS.kick.push('wave');
SYNTH_IDS.snare.push('wave');
SYNTH_IDS.noise.push('wave');

// ============ POKEY (XPOKEY $1A50-$1A5F) ============
// The Atari POKEY divides one clock down to make pitch. Each channel either
// flips a square wave on every count (pure) or reads a polynomial counter: a
// shift register whose bits repeat every 15, 31, 511 or 131071 counts. Short
// ones buzz, long ones hiss. Volume has 16 steps, and a game changed it (and
// the pitch) once per video frame, 60 times a second, so sweeps come in steps.
// Each voice has three bytes, POLY, DIV, VOL, in voice order, then the clock.
const XPOKEY = { BASE: 0x1A50, CLOCK: 0x1A5F };
const POKEY_CLOCKS = [63921, 15699, 1789790];          // NTSC POKEY: 64 kHz, 15 kHz, 1.79 MHz
const POKEY_POLY = { PURE: 1, P4: 2, P5: 3, P9: 4, P17: 5 };
const POKEY_TAPS = { 2: [4, 3], 3: [5, 3], 4: [9, 5], 5: [17, 14] };   // x^n + x^k + 1, all maximal length
const POKEY_DEFAULT_POLY = { kick: 1, snare: 5, lead: 1, bass: 2, noise: 5 };
const pokeyPatterns = {};

// One full period of a polynomial counter, as bits
function pokeyPattern(poly) {
  if (pokeyPatterns[poly]) return pokeyPatterns[poly];
  const [n, k] = POKEY_TAPS[poly];
  const len = (1 << n) - 1, mask = len;
  const bits = new Uint8Array(len);
  let s = 1;
  for (let i = 0; i < len; i++) {
    const b = ((s >> (n - 1)) ^ (s >> (k - 1))) & 1;
    s = ((s << 1) | b) & mask;
    bits[i] = b;
  }
  return (pokeyPatterns[poly] = bits);
}

function pokeyOf(voice) {
  const a = XPOKEY.BASE + VOICE_ORDER.indexOf(voice) * 3;
  const poly = MEM[a] >= 1 && MEM[a] <= 5 ? MEM[a] : POKEY_DEFAULT_POLY[voice];
  return { poly, div: MEM[a + 1], vol: Math.min(15, MEM[a + 2] || 15), clock: POKEY_CLOCKS[MEM[XPOKEY.CLOCK]] || POKEY_CLOCKS[0] };
}

// Counts per cycle of the sound: a pure tone flips twice per cycle; a
// polynomial counter's pattern is one cycle. 9- and 17-bit are noise, so
// they use the pure tone's divider for the same note, as Atari music did.
function pokeyPer(poly) { return poly === POKEY_POLY.P4 ? 15 : poly === POKEY_POLY.P5 ? 31 : 2; }

// The divider nearest to a pitch, and the count rate it really gives.
// At 64 and 15 kHz the divider is 8 bits, so high notes land out of tune:
// that is the chip, not a bug, and notes too low for 8 bits go up an octave
// until they fit. At 1.79 MHz Atari music joined two channels into one
// 16-bit divider, and so does this, which puts every note in tune.
function pokeyRate(f, poly, clock) {
  const per = pokeyPer(poly), max = clock > 1e6 ? 65535 : 255;
  let n = Math.round(clock / (f * per)) - 1;
  while (n > max) { f *= 2; n = Math.round(clock / (f * per)) - 1; }
  return clock / (Math.max(0, n) + 1);
}
function pokeyDivRate(div, clock) { return clock / ((div & 255) + 1); }

// Render one hit. frame(k) gives { poly, rate, vol } for video frame k
// (1/60 s); the counter runs at that rate until the next frame.
function pokeyRender(t, seconds, frame, level = 0.22) {
  const sr = audioCtx.sampleRate, len = Math.max(1, Math.ceil(seconds * sr));
  const buf = audioCtx.createBuffer(1, len, sr), d = buf.getChannelData(0);
  let k = -1, cur = null, pattern = null, pos = 0, out = 1, acc = 0;
  for (let i = 0; i < len; i++) {
    const fk = Math.floor(i * 60 / sr);
    if (fk !== k) {
      k = fk;
      cur = frame(k);
      pattern = cur.poly > 1 ? pokeyPattern(cur.poly) : null;
      if (pattern) pos %= pattern.length;
    }
    acc += cur.rate / sr;
    while (acc >= 1) {
      acc -= 1;
      if (pattern) { pos = pos + 1 === pattern.length ? 0 : pos + 1; out = pattern[pos]; } else out ^= 1;
    }
    d[i] = (out ? 1 : -1) * (cur.vol / 15) * level;
  }
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(getAudioDest());
  src.start(t);
  return src;
}

// Lead and bass: the note picks the divider; the voice envelope runs a frame
// at a time and lands on the chip's 16 volume steps
function pokeyNote(voice) {
  return function(t, note, params, adsr) {
    if (!note) return;
    const p = pokeyOf(voice);
    const e = adsr || { a: 0.005, d: 0.12, s: 0.6, r: 0.15 };
    const hold = Math.max(0.02, (gateSeconds || 0.125) - e.a - e.d);
    const total = e.a + e.d + hold + e.r;
    const rate = pokeyRate(noteToHz(note, voiceIndexNow()), p.poly, p.clock);
    const env = x => x < e.a ? x / e.a : x < e.a + e.d ? 1 - (1 - e.s) * (x - e.a) / e.d : x < e.a + e.d + hold ? e.s : e.s * Math.max(0, 1 - (x - e.a - e.d - hold) / Math.max(0.001, e.r));
    pokeyRender(t, total + 1 / 60, k => ({ poly: p.poly, rate, vol: Math.round(p.vol * env(k / 60)) }));
  };
}
VOICE_SYNTHS.lead.pokey = pokeyNote('lead');
VOICE_SYNTHS.bass.pokey = pokeyNote('bass');

// Kick: a pitch that drops each frame toward the step's note
VOICE_SYNTHS.kick.pokey = function(t, note, params) {
  const p = pokeyOf('kick');
  const end = midiHz(params[0] || 36);
  const start = p.div ? pokeyDivRate(p.div, p.clock) / pokeyPer(p.poly) : end * (2 + (MEM[0x1051] || 90) / 255 * 6);
  const frames = 5 + Math.round((MEM[0x1050] || 100) / 255 * 20);     // KICK_DECAY
  pokeyRender(t, frames / 60, k => ({
    poly: p.poly,
    rate: pokeyRate(end + (start - end) * Math.pow(0.45, k), p.poly, p.clock),
    vol: Math.round(p.vol * Math.max(0, 1 - k / frames))
  }), 0.4);
};

// Snare: one frame of tone, then the counter's noise, fading by frames
VOICE_SYNTHS.snare.pokey = function(t, note, params) {
  const p = pokeyOf('snare');
  const tone = params[0] || 180, snap = params[1] || 100;
  const noiseRate = p.div ? pokeyDivRate(p.div, p.clock) : p.clock / (1 + Math.round((255 - snap) / 48));
  const frames = 6 + Math.round((MEM[0x1054] || 80) / 255 * 10);      // SNARE_BODY_DECAY
  pokeyRender(t, frames / 60, k => k === 0
    ? { poly: POKEY_POLY.PURE, rate: pokeyRate(120 + tone, POKEY_POLY.PURE, p.clock), vol: p.vol }
    : { poly: p.poly, rate: noiseRate, vol: Math.round(p.vol * Math.max(0, 1 - k / frames)) }, 0.16);
};

// Noise: hats from the counter (y sets the brightness), or a zap on type 1
VOICE_SYNTHS.noise.pokey = function(t, note, params) {
  const p = pokeyOf('noise');
  const y = Math.min(15, params[0] || 5), type = params[1] || 0;
  if (type === 1) {
    const frames = 8;
    pokeyRender(t, frames / 60, k => ({ poly: POKEY_POLY.PURE, rate: pokeyRate((1200 + (15 - y) * 150) * Math.pow(0.6, k), POKEY_POLY.PURE, p.clock), vol: Math.round(p.vol * (1 - k / frames)) }), 0.16);
    return;
  }
  const rate = p.div ? pokeyDivRate(p.div, p.clock) : p.clock / (1 + (15 - y));
  const frames = y > 10 ? 2 : 5;
  pokeyRender(t, frames / 60, k => ({ poly: p.poly, rate, vol: Math.round(p.vol * (1 - k / frames)) }), 0.12);
};
SYNTH_IDS.kick.push('pokey');
SYNTH_IDS.snare.push('pokey');
SYNTH_IDS.lead.push('pokey');
SYNTH_IDS.bass.push('pokey');
SYNTH_IDS.noise.push('pokey');

// Legacy wrappers - read synth selector from MEMORY (MTMC-16 style!)
// An engine can play differently per voice (a wave kick is not a wave lead)
function synthOf(voice) {
  const name = getVoiceSynth(voice);
  return (VOICE_SYNTHS[voice] && VOICE_SYNTHS[voice][name]) || SYNTHS[name];
}
function playKick(t, p) { withVoiceStrip('kick', () => synthOf('kick')(t, 0, [p]), t); }
function playSnare(t, tone, snap) { withVoiceStrip('snare', () => synthOf('snare')(t, 0, [tone, snap]), t); }
function playLead(t, note, arp) { withVoiceStrip('lead', () => playWithUnison('lead', () => synthOf('lead')(t, note, [arp], envOf('lead'))), t); }
function playBass(t, note, fm, filt) { withVoiceStrip('bass', () => playWithUnison('bass', () => synthOf('bass')(t, note, [fm, filt], envOf('bass'))), t); }

// XENV ($1060-$1073): the voice's envelope from memory. All four bytes 0 means
// not set, so the engine keeps its own default shape. Lead, bass, FM and SID
// engines use it; the drum, noise and speech engines shape themselves.
function envOf(voice) {
  const base = VOICES[voice].adsr;
  if (!(MEM[base] | MEM[base + 1] | MEM[base + 2] | MEM[base + 3])) return undefined;
  return getADSR(voice);
}
function playNoise(t, y, type) { withVoiceStrip('noise', () => synthOf('noise')(t, 0, [y, type]), t); }
// ============ SEQUENCER ============

// ============ STEP TRIGGER (XSTEP probability and ratchets) ============
function shouldTrigger(voice, stepIdx) {
  const v = VOICES[voice];
  const prob = MEM[v.prob + stepIdx];
  // 0 or undefined = 100% (default), 1-100 = that percentage
  if (prob === 0 || prob === undefined) return true;
  return Math.random() * 100 < prob;
}

function getRatchets(voice, stepIdx) {
  const v = VOICES[voice];
  const r = MEM[v.ratch + stepIdx];
  // 0 or undefined = 1 (single hit), 2-8 = that many hits
  return (r && r > 1) ? Math.min(r, 8) : 1;
}

// Every voice for one step. Live playback and WAV export both call this,
// so an export is the same engine you hear.
function triggerStep(step, t, baseStep) {
  gateSeconds = baseStep;
  const lateLocks = busBegin(step);
  const restore = applyLocks(step, lateLocks);
  try {
    triggerVoices(step, t, baseStep);
  } finally {
    for (let i = restore.length - 1; i >= 0; i--) MEM[restore[i][0]] = restore[i][1];
  }
}

// ============ PARAMETER LOCKS (XSEQ $1E00-$1E40) ============
// A lock changes one byte for one step: on that step the chip writes the
// value, plays the step, then puts the old byte back. LOCK_COUNT at $1E00,
// then 4 bytes per lock: step, address low, address high, value.
const LOCKS = { COUNT: 0x1E00, TABLE: 0x1E01, MAX: 16 };

// Sound settings only: never the locks themselves, CAPS and the system page, or outside the chip
function soundByte(addr) {
  return addr >= 0x1000 && addr <= 0x1FFF && !(addr >= 0x1500 && addr < 0x1600) && !(addr >= 0x1E00 && addr <= 0x1E40);
}

function applyLocks(step, lateLocks = []) {
  const restore = [];
  const land = (addr, value) => {
    const w = busRoute(addr, value, 'lock', step);
    if (!w) return;
    restore.push([w.addr, MEM[w.addr]]);
    MEM[w.addr] = w.value;
  };
  lateLocks.forEach(w => land(w.addr, w.value));   // locks the bus held back last step
  const n = Math.min(LOCKS.MAX, MEM[LOCKS.COUNT] || 0);
  for (let i = 0; i < n; i++) {
    const e = LOCKS.TABLE + i * 4;
    if ((MEM[e] & 15) !== step) continue;
    const addr = MEM[e + 1] | (MEM[e + 2] << 8);
    if (soundByte(addr)) land(addr, MEM[e + 3]);
    else engineFault(1, addr);
  }
  return restore;
}

// ============ FAULTS (XFAULT $1510-$1513) ============
// Rule 2: a machine ignores what it cannot do, and keeps playing. The fault
// register is where it says what it ignored: a code and the address. A page
// can define onEngineFault(code, addr) to react; the sequencer can halt and
// show a panic screen, the way a real machine reports a fault.
const XFAULT = { CTRL: 0x1510, CODE: 0x1511, ADDR: 0x1512 };
const FAULTS = {
  1: 'LOCK OUTSIDE SOUND SETTINGS',
  2: 'BUS OVERRUN: A LATE WRITE WAS LOST',
  3: 'NO SUCH ENGINE: PLAYED THE FIRST'
};
function engineFault(code, addr) {
  MEM[XFAULT.CODE] = code;
  MEM[XFAULT.ADDR] = addr & 255;
  MEM[XFAULT.ADDR + 1] = (addr >> 8) & 255;
  if (typeof onEngineFault === 'function' && typeof AudioContext !== 'undefined' && audioCtx instanceof AudioContext) onEngineFault(code, addr);
}

// ============ BUS BUDGET (XBUS $1508-$150C) ============
// A real sound chip sits on a bus that takes only so many register writes
// per video frame. The SID, the SPC700 and Paula all had this limit, and
// composers worked inside it. With BUS_CTRL on, the automation that writes
// memory while a song plays (parameter locks, the LFO, evolve) shares
// BUS_SPEED writes per step. A write that does not fit fails as BUS_MODE says:
//   drop     it is lost                               (the CPU missed it)
//   corrupt  it lands with some low bits flipped      (a register conflict)
//   late     it lands at the start of the next step   (DMA got the bus first)
//   alias    it lands one address line away           (a bus glitch)
// What you type, click or POKE yourself is never budgeted.
const XBUS = { CTRL: 0x1508, SPEED: 0x1509, MODE: 0x150A, OVERFLOWS: 0x150B, LOAD: 0x150C };
const BUS_MODES = ['drop', 'corrupt', 'late', 'alias'];
const BUS_LATE_MAX = 64;
const bus = { used: 0, late: [], events: [] };   // events: what failed this step, for the page to draw

function busOn() { return (MEM[XBUS.CTRL] & 1) === 1; }
function busSpeed() { return MEM[XBUS.SPEED] || 8; }

// Start of a step. Late writes land first and count against this step.
// Returns the late lock writes, which belong to this step's locks.
function busBegin(step) {
  bus.used = 0;
  bus.events = [];
  MEM[XBUS.LOAD] = 0;
  const late = bus.late;
  bus.late = [];
  if (!busOn()) return [];
  const locks = [];
  for (const w of late) {
    if (w.source === 'lock') { locks.push(w); continue; }
    const r = busRoute(w.addr, w.value, w.source, step);
    if (r) MEM[r.addr] = r.value;
  }
  return locks;
}

// One automation write through the bus. Returns { addr, value } to write,
// or null when the write is lost or held for the next step.
function busRoute(addr, value, source, step) {
  if (!busOn()) return { addr, value };
  bus.used++;
  MEM[XBUS.LOAD] = Math.min(255, bus.used);
  if (bus.used <= busSpeed()) return { addr, value };
  MEM[XBUS.OVERFLOWS] = (MEM[XBUS.OVERFLOWS] + 1) & 255;
  const mode = BUS_MODES[MEM[XBUS.MODE]] || 'drop';
  const ev = { addr, value, source, mode, step };
  bus.events.push(ev);
  if (mode === 'corrupt') return { addr, value: value ^ (1 + Math.floor(Math.random() * 63)) };
  if (mode === 'late') {
    if (bus.late.length < BUS_LATE_MAX) bus.late.push({ addr, value, source });
    else engineFault(2, addr);
    return null;
  }
  if (mode === 'alias') {
    const wrong = addr ^ (1 << Math.floor(Math.random() * 4));
    ev.to = wrong;
    return soundByte(wrong) ? { addr: wrong, value } : null;
  }
  return null;   // drop
}

// Run automation (LFO, evolve) through the bus: let it write as it likes,
// then replay its writes one at a time so only the budget's worth land.
// Earlier calls in a step have priority over later ones.
function busAutomation(source, step, run) {
  if (!busOn()) return run();
  const before = MEM.slice(0x1000, 0x2000);
  const result = run();
  const writes = [];
  for (let a = 0x1000; a < 0x2000; a++) {
    const old = before[a - 0x1000];
    if (MEM[a] !== old && soundByte(a)) { writes.push([a, MEM[a]]); MEM[a] = old; }
  }
  for (const [a, v] of writes) {
    const w = busRoute(a, v, source, step);
    if (w) MEM[w.addr] = w.value;
  }
  return result;
}

function triggerVoices(step, t, baseStep) {
  // Kick with prob/ratchet
  if (MEM[0x1000 + step] && shouldTrigger('kick', step)) {
    const ratchets = getRatchets('kick', step);
    const ratchetTime = baseStep / ratchets;
    for (let r = 0; r < ratchets; r++) {
      playKick(t + r * ratchetTime * 0.9, MEM[0x1010 + step]);
    }
  }
  // Snare with prob/ratchet
  if (MEM[0x1020 + step] && shouldTrigger('snare', step)) {
    const ratchets = getRatchets('snare', step);
    const ratchetTime = baseStep / ratchets;
    for (let r = 0; r < ratchets; r++) {
      playSnare(t + r * ratchetTime * 0.9, MEM[0x1030 + step], MEM[0x1040 + step]);
    }
  }
  // Lead with prob/ratchet
  if (MEM[0x1100 + step] && shouldTrigger('lead', step)) {
    const ratchets = getRatchets('lead', step);
    const ratchetTime = baseStep / ratchets;
    for (let r = 0; r < ratchets; r++) {
      playLead(t + r * ratchetTime * 0.9, MEM[0x1100 + step], MEM[0x1110 + step]);
    }
  }
  // Bass with prob/ratchet
  if (MEM[0x1200 + step] && shouldTrigger('bass', step)) {
    const ratchets = getRatchets('bass', step);
    const ratchetTime = baseStep / ratchets;
    for (let r = 0; r < ratchets; r++) {
      playBass(t + r * ratchetTime * 0.9, MEM[0x1200 + step], MEM[0x1210 + step], MEM[0x1220 + step]);
    }
  }
  // Noise with prob/ratchet
  if (MEM[0x1300 + step] && shouldTrigger('noise', step)) {
    const ratchets = getRatchets('noise', step);
    const ratchetTime = baseStep / ratchets;
    for (let r = 0; r < ratchets; r++) {
      playNoise(t + r * ratchetTime * 0.9, MEM[0x1310 + step], MEM[0x1320 + step]);
    }
  }

}


// ============ WAV EXPORT ============
// ============ WAV EXPORT ============
// Renders through the real engine: the same triggerStep, synth engines,
// envelopes, unison, channel strips and master chain you hear, pointed at
// an OfflineAudioContext for a moment instead of the speakers.
async function renderWithEngine(seconds, schedule) {
  if (!audioCtx) initAudio();
  const sampleRate = 44100;
  const off = new OfflineAudioContext(2, Math.ceil(sampleRate * seconds), sampleRate);
  const chain = buildMasterChain(off);
  await addCrusher(off, chain);
  const live = { ctx: audioCtx, strips: Object.assign({}, voiceStrips), gate: gateSeconds, bus: { used: bus.used, late: bus.late, events: bus.events } };
  bus.late = [];
  const memBefore = MEM.slice(0x1000, 0x2000);
  audioCtx = off;
  useMasterChain(chain);
  Object.keys(voiceStrips).forEach(k => delete voiceStrips[k]);
  try {
    updateMasterEffects();
    schedule();
  } finally {
    MEM.set(memBefore, 0x1000);     // LFO steps during export do not stick
    audioCtx = live.ctx;
    useMasterChain(liveChain);
    Object.keys(voiceStrips).forEach(k => delete voiceStrips[k]);
    Object.assign(voiceStrips, live.strips);
    gateSeconds = live.gate;
    Object.assign(bus, live.bus);
  }
  return off.startRendering();
}


// WAV encoder
function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const data = interleave(buffer);
  const dataSize = data.length * bytesPerSample;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const arrayBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(arrayBuffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write samples
  let offset = 44;
  for (let i = 0; i < data.length; i++) {
    const sample = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
    offset += 2;
  }

  return arrayBuffer;
}

function interleave(buffer) {
  const length = buffer.length * buffer.numberOfChannels;
  const result = new Float32Array(length);
  const channels = [];
  for (let i = 0; i < buffer.numberOfChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }
  let idx = 0;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      result[idx++] = channels[ch][i];
    }
  }
  return result;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// Play one hit or note on a voice, so you hear a change right away
function previewVoice(voice) {
  try {
    initAudio();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t = audioCtx.currentTime + 0.03;
    if (voice === 'kick') playKick(t, MEM[0x1010] || 0);
    else if (voice === 'snare') playSnare(t, MEM[0x1030] || 180, MEM[0x1040] || 100);
    else if (voice === 'lead') playLead(t, 60, 0);
    else if (voice === 'bass') playBass(t, 36, MEM[0x1210] || 40, MEM[0x1220] || 70);
    else if (voice === 'noise') playNoise(t, MEM[0x1310] || 14, MEM[0x1320] || 0);
  } catch (e) { /* audio not available: the bytes are still written */ }
}
