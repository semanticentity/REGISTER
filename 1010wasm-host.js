/**
 * $1010 APU WASM Host
 *
 * Bridges the WASM runtime to Web Audio.
 * WASM handles: sequencer logic, memory, state
 * JS handles: audio synthesis, timing, UI
 */

class APU1010 {
  constructor() {
    this.wasm = null;
    this.memory = null;
    this.audioCtx = null;
    this.timer = null;
    this.onTick = null;  // Callback for UI updates
  }

  // ============ INITIALIZATION ============

  async init(wasmUrl = '1010runtime.wasm') {
    // Create audio context
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // Define imports (audio callbacks from WASM)
    const imports = {
      audio: {
        triggerKick: (pitch) => this.playKick(pitch),
        triggerSnare: (tone, snap) => this.playSnare(tone, snap),
        triggerLead: (note) => this.playLead(note),
        triggerBass: (note, fm) => this.playBass(note, fm),
        triggerNoise: (decay) => this.playNoise(decay)
      }
    };

    // Load WASM
    try {
      const response = await fetch(wasmUrl);
      const bytes = await response.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes, imports);
      this.wasm = instance.exports;
      this.memory = new Uint8Array(this.wasm.memory.buffer);

      // Initialize
      this.wasm.init();

      console.log('$1010 APU initialized (WASM)');
      return true;
    } catch (err) {
      console.error('Failed to load WASM:', err);
      return false;
    }
  }

  // Initialize from .wat source (for development)
  async initFromWat(watSource) {
    // This requires wat2wasm or browser support
    // For now, compile .wat to .wasm externally
    console.warn('Direct .wat loading requires external compilation');
    return false;
  }

  // ============ MEMORY ACCESS ============

  read(addr) {
    return this.wasm.read(addr);
  }

  write(addr, value) {
    this.wasm.write(addr, value);
  }

  // Get memory view for visualization
  getMemorySlice(start, length) {
    return Array.from(this.memory.slice(start, start + length));
  }

  // Load pattern from array
  loadPattern(voice, data) {
    // voice: 0=kick, 1=snare, 2=lead, 3=bass, 4=noise
    const baseAddrs = [0x1000, 0x1020, 0x1100, 0x1200, 0x1300];
    const addr = baseAddrs[voice];
    for (let i = 0; i < 16 && i < data.length; i++) {
      this.write(addr + i, data[i]);
    }
  }

  // ============ SEQUENCER CONTROL ============

  start() {
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    this.wasm.start();
    this._startTimer();
  }

  stop() {
    this.wasm.stop();
    this._stopTimer();
  }

  reset() {
    this.wasm.reset();
  }

  get isPlaying() {
    return this.wasm.isPlaying() === 1;
  }

  get currentStep() {
    return this.wasm.getStep();
  }

  get tempo() {
    return this.wasm.getTempo();
  }

  set tempo(bpm) {
    this.wasm.setTempo(bpm);
    if (this.isPlaying) {
      this._stopTimer();
      this._startTimer();
    }
  }

  // ============ TIMER ============

  _startTimer() {
    const bpm = this.tempo;
    const stepMs = (60 / bpm / 4) * 1000;  // 16th note

    const tick = () => {
      if (this.wasm.tick()) {
        if (this.onTick) {
          this.onTick(this.currentStep);
        }
        this.timer = setTimeout(tick, stepMs);
      }
    };

    tick();
  }

  _stopTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ============ AUDIO SYNTHESIS ============
  // These are called from WASM via imports

  midiToFreq(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
  }

  playKick(pitch = 36) {
    if (!this.audioCtx) return;
    const ctx = this.audioCtx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(this.midiToFreq(pitch + 24), now);
    osc.frequency.exponentialRampToValueAtTime(this.midiToFreq(pitch), now + 0.1);

    gain.gain.setValueAtTime(0.8, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);

    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.3);
  }

  playSnare(tone = 180, snap = 100) {
    if (!this.audioCtx) return;
    const ctx = this.audioCtx;
    const now = ctx.currentTime;

    // Noise burst
    const bufferSize = ctx.sampleRate * 0.1;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.3, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

    // Body oscillator
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = tone;

    oscGain.gain.setValueAtTime(0.3, now);
    oscGain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

    noise.connect(noiseGain).connect(ctx.destination);
    osc.connect(oscGain).connect(ctx.destination);

    noise.start(now);
    osc.start(now);
    noise.stop(now + 0.15);
    osc.stop(now + 0.15);
  }

  playLead(note) {
    if (!this.audioCtx || note === 0) return;
    const ctx = this.audioCtx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'square';
    osc.frequency.value = this.midiToFreq(note);

    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);

    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.25);
  }

  playBass(note, fm = 40) {
    if (!this.audioCtx || note === 0) return;
    const ctx = this.audioCtx;
    const now = ctx.currentTime;
    const freq = this.midiToFreq(note);

    const carrier = ctx.createOscillator();
    const modulator = ctx.createOscillator();
    const modGain = ctx.createGain();
    const gain = ctx.createGain();

    modulator.frequency.value = freq * 2;
    modGain.gain.value = fm;
    carrier.frequency.value = freq;

    gain.gain.setValueAtTime(0.4, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);

    modulator.connect(modGain).connect(carrier.frequency);
    carrier.connect(gain).connect(ctx.destination);

    modulator.start(now);
    carrier.start(now);
    modulator.stop(now + 0.35);
    carrier.stop(now + 0.35);
  }

  playNoise(decay = 8) {
    if (!this.audioCtx) return;
    const ctx = this.audioCtx;
    const now = ctx.currentTime;
    const duration = decay / 50;

    const bufferSize = ctx.sampleRate * duration;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 8000;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + duration);

    noise.connect(filter).connect(gain).connect(ctx.destination);
    noise.start(now);
    noise.stop(now + duration);
  }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = APU1010;
}

// Global for browser
if (typeof window !== 'undefined') {
  window.APU1010 = APU1010;
}
