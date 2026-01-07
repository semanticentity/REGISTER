/**
 * $1010 PACKS - Classic Synth & Drum Machine Presets
 *
 * Load via: $1010.loadPack('TR-808') or drop into CodePen JS panel
 *
 * Each pack is a pure JS object:
 * - name: Display name
 * - category: drums | synth | sampler | fx
 * - year: Original release year
 * - manufacturer: Original maker
 * - description: What it's known for
 * - teaches: CS concepts this pack demonstrates
 * - init: Function that returns array of [address, value] pokes
 * - patterns: Optional preset patterns
 */

const $1010_PACKS = {

  // ============================================================
  // ROLAND DRUM MACHINES
  // ============================================================

  'TR-808': {
    name: 'Roland TR-808',
    category: 'drums',
    year: 1980,
    manufacturer: 'Roland',
    description: 'The 808. Hip-hop, electro, trap. That deep kick, crispy snare, iconic cowbell.',
    teaches: ['Analog synthesis', 'Envelope shaping', 'Why 808 kick = sine + pitch envelope'],
    init: () => [
      // Kick: Deep, boomy, long decay
      [0x1010, 32],   // KICK_PITCH - very low (F1)
      [0x1080, 127],  // KICK_VEL - full velocity

      // Snare: Tight, punchy, short
      [0x1030, 180],  // SNARE_TONE - mid frequency body
      [0x1040, 120],  // SNARE_SNAP - crispy transient
      [0x1090, 110],  // SNARE_VEL

      // Hi-hat (noise voice): Crispy
      [0x1310, 4],    // NOISE_DECAY - short (closed hat)
      [0x1320, 0],    // NOISE_TYPE - white noise
      [0x1330, 100],  // NOISE_VEL

      // Mixer: Classic 808 balance
      [0x1050, 127],  // Kick loud
      [0x1051, 90],   // Snare slightly back
      [0x1052, 70],   // Lead
      [0x1053, 100],  // Bass
      [0x1054, 80],   // Hi-hats
    ],
    patterns: {
      'Boom Bap': {
        bpm: 90,
        kick:  'x.....x...x.....',
        snare: '....x.......x...',
        noise: 'x.x.x.x.x.x.x.x.',
      },
      'Trap': {
        bpm: 140,
        kick:  'x.....x.x.......',
        snare: '....x.......x...',
        noise: 'x.xxx.x.x.xxx.x.',
      },
      'Electro': {
        bpm: 120,
        kick:  'x..x..x..x..x...',
        snare: '....x.......x...',
        noise: 'x.x.x.x.x.x.x.x.',
      }
    }
  },

  'TR-909': {
    name: 'Roland TR-909',
    category: 'drums',
    year: 1983,
    manufacturer: 'Roland',
    description: 'House and techno foundation. Punchier than 808, real hi-hat samples.',
    teaches: ['Hybrid analog/digital', 'Sample + synthesis', 'Why house music exists'],
    init: () => [
      // Kick: Punchy, mid-range, classic house
      [0x1010, 41],   // KICK_PITCH - F2, higher than 808
      [0x1080, 120],  // KICK_VEL

      // Snare: Cracking, more attack
      [0x1030, 200],  // SNARE_TONE - higher
      [0x1040, 150],  // SNARE_SNAP - more crack
      [0x1090, 115],  // SNARE_VEL

      // Hi-hat: Brighter, sampled feel
      [0x1310, 6],    // NOISE_DECAY - slightly longer
      [0x1320, 0],    // NOISE_TYPE - white
      [0x1330, 85],   // NOISE_VEL

      [0x1050, 120],  // Kick
      [0x1051, 95],   // Snare
      [0x1054, 75],   // Hats
    ],
    patterns: {
      'Four on the Floor': {
        bpm: 124,
        kick:  'x...x...x...x...',
        snare: '....x.......x...',
        noise: 'x.x.x.x.x.x.x.x.',
      },
      'Breakbeat': {
        bpm: 130,
        kick:  'x.....x...x.....',
        snare: '....x..x....x...',
        noise: 'x.x.x.x.x.x.x.x.',
      },
      'Techno': {
        bpm: 138,
        kick:  'x...x...x...x...',
        snare: '........x.......',
        noise: '..x...x...x...x.',
      }
    }
  },

  'TR-707': {
    name: 'Roland TR-707',
    category: 'drums',
    year: 1984,
    manufacturer: 'Roland',
    description: 'Digital drums. New Order, Depeche Mode. Clean, precise, 80s.',
    teaches: ['PCM samples', 'Digital audio', '8-bit sampling'],
    init: () => [
      [0x1010, 38],   // Tighter kick
      [0x1030, 220],  // Brighter snare
      [0x1040, 100],  // Less snap
      [0x1310, 3],    // Short hats
      [0x1050, 100],
      [0x1051, 100],
      [0x1054, 90],
    ],
    patterns: {
      'New Wave': {
        bpm: 120,
        kick:  'x...x...x...x...',
        snare: '....x.......x...',
        noise: 'x.x.x.x.x.x.x.x.',
      }
    }
  },

  'CR-78': {
    name: 'Roland CR-78',
    category: 'drums',
    year: 1978,
    manufacturer: 'Roland',
    description: 'First programmable drum machine. Phil Collins "In The Air Tonight".',
    teaches: ['Early digital', 'Step programming origins', 'Why 16 steps?'],
    init: () => [
      [0x1010, 45],   // Higher, thinner kick
      [0x1030, 160],  // Darker snare
      [0x1040, 60],   // Minimal snap
      [0x1310, 2],    // Very short hats
      [0x1050, 90],
      [0x1051, 80],
      [0x1054, 70],
    ],
    patterns: {
      'In The Air': {
        bpm: 94,
        kick:  'x.......x.......',
        snare: '....x.......x...',
        noise: 'x...x...x...x...',
      }
    }
  },

  // ============================================================
  // ROLAND BASS SYNTHS
  // ============================================================

  'TB-303': {
    name: 'Roland TB-303',
    category: 'synth',
    year: 1981,
    manufacturer: 'Roland',
    description: 'Acid house. That squelchy, resonant bassline. Accents and slides.',
    teaches: ['Resonant filters', 'Accent = velocity', 'Why acid sounds "alive"'],
    init: () => [
      // Bass voice: Heavy filter, lots of resonance
      [0x1220, 40],   // BASS_FILT - low cutoff (will sweep)
      [0x1210, 80],   // BASS_FM - some grit
      [0x1230, 127],  // BASS_VEL - full

      // Lead as second 303 (can layer)
      [0x1120, 100],  // LEAD_VEL
    ],
    patterns: {
      'Acid Line': {
        bpm: 130,
        bass: '24..24..27..24..',  // C2, C2, D#2, C2
        lead: '................',
      },
      'Squelch': {
        bpm: 138,
        bass: '24242424272424..',
      }
    }
  },

  // ============================================================
  // ROLAND POLY SYNTHS
  // ============================================================

  'JUNO-106': {
    name: 'Roland Juno-106',
    category: 'synth',
    year: 1984,
    manufacturer: 'Roland',
    description: 'The poly synth. Lush pads, that chorus. Every 80s record.',
    teaches: ['Chorus effect', 'PWM synthesis', 'Why unison = fat'],
    init: () => [
      // Lead: Warm, chorused
      [0x1110, 1],    // LEAD_ARP - slight arp for movement
      [0x1120, 90],   // LEAD_VEL

      // Detune for chorus effect
      [0x105C, 8],    // KICK_DETUNE (unused, but shows concept)
      [0x105E, 12],   // LEAD_DETUNE - slight chorusing

      // Bass: Warm, round
      [0x1220, 70],   // BASS_FILT - slightly open
      [0x1210, 30],   // BASS_FM - minimal
    ],
    patterns: {
      'Synthwave Pad': {
        bpm: 100,
        lead: '3C..3C..40..40..',  // C4, C4, E4, E4
        bass: '30......30......',  // C3
      }
    }
  },

  'JP-8000': {
    name: 'Roland JP-8000',
    category: 'synth',
    year: 1996,
    manufacturer: 'Roland',
    description: 'SuperSaw. 7 detuned saws = trance anthem fuel.',
    teaches: ['Unison/detune', 'Why 7 oscillators?', 'Additive vs subtractive'],
    init: () => [
      // Lead: SUPERSAW (emulated via heavy detune)
      [0x105E, 50],   // LEAD_DETUNE - maximum spread
      [0x1120, 127],  // LEAD_VEL - full

      // Bass: Also slightly supersaw
      [0x105F, 20],   // BASS_DETUNE
      [0x1220, 90],   // BASS_FILT - bright
    ],
    patterns: {
      'Trance Lead': {
        bpm: 138,
        lead: '3C..3C..43..43..3C..3C..45..45..',
        bass: '30......30......30......30......',
      }
    }
  },

  // ============================================================
  // KORG
  // ============================================================

  'MS-20': {
    name: 'Korg MS-20',
    category: 'synth',
    year: 1978,
    manufacturer: 'Korg',
    description: 'Aggressive, nasty, patchable. That filter screams.',
    teaches: ['Patch points', 'Self-oscillating filters', 'Semi-modular'],
    init: () => [
      // Aggressive settings
      [0x1220, 30],   // BASS_FILT - low, resonant
      [0x1210, 100],  // BASS_FM - nasty
      [0x1230, 127],

      [0x105E, 5],    // Slight detune
    ],
    patterns: {
      'Aggro Bass': {
        bpm: 125,
        bass: '24..2724..27....',
      }
    }
  },

  'M1': {
    name: 'Korg M1',
    category: 'synth',
    year: 1988,
    manufacturer: 'Korg',
    description: 'Workstation era. "M1 Piano" on every late 80s/90s record.',
    teaches: ['PCM + synthesis', 'Workstations', 'Rompler architecture'],
    init: () => [
      // Clean, bright, "digital"
      [0x1120, 85],
      [0x1220, 100],  // Open filter
      [0x1210, 10],   // Minimal FM
    ],
    patterns: {
      'House Organ': {
        bpm: 122,
        lead: '3C3C3C3C40404040',
        bass: '30......30......',
      }
    }
  },

  'Volca': {
    name: 'Korg Volca Series',
    category: 'synth',
    year: 2013,
    manufacturer: 'Korg',
    description: 'Modern affordable analog. Accessible synthesis for everyone.',
    teaches: ['Analog basics', 'Modern revival', 'Why analog came back'],
    init: () => [
      [0x1010, 36],   // Volca Kick
      [0x1030, 200],
      [0x1220, 60],
      [0x1210, 50],
    ],
    patterns: {
      'Pocket Techno': {
        bpm: 120,
        kick:  'x...x...x...x...',
        bass:  '24..24..2724....',
      }
    }
  },

  // ============================================================
  // YAMAHA
  // ============================================================

  'DX7': {
    name: 'Yamaha DX7',
    category: 'synth',
    year: 1983,
    manufacturer: 'Yamaha',
    description: 'FM synthesis. Electric piano, bells, basses. Defined the 80s.',
    teaches: ['FM synthesis', 'Operators and algorithms', 'Why FM is "hard"'],
    init: () => [
      // Bass: Classic FM bass
      [0x1210, 90],   // BASS_FM - the whole point
      [0x1220, 80],   // BASS_FILT
      [0x1230, 110],

      // Lead: Bell-like FM
      [0x1120, 95],
    ],
    patterns: {
      'FM Bass': {
        bpm: 116,
        bass: '24....24..27....',
      },
      'E-Piano': {
        bpm: 72,
        lead: '3C..40..43..40..',
      }
    }
  },

  // ============================================================
  // AKAI - SAMPLERS
  // ============================================================

  'MPC60': {
    name: 'Akai MPC60',
    category: 'sampler',
    year: 1988,
    manufacturer: 'Akai',
    description: 'Roger Linn + Akai. The MPC swing. Hip-hop production standard.',
    teaches: ['Sampling', 'MPC swing (why 54%?)', 'Quantization'],
    init: () => [
      // The famous MPC swing
      [0x1503, 54],   // SEQ_SWING - the magic number

      // Punchy, sample-like drums
      [0x1010, 38],
      [0x1030, 190],
      [0x1040, 130],

      [0x1050, 110],
      [0x1051, 100],
    ],
    patterns: {
      'Boom Bap Swing': {
        bpm: 94,
        kick:  'x.....x...x.....',
        snare: '....x.......x...',
        noise: 'x.x.x.x.x.x.x.x.',
      }
    }
  },

  'SP-1200': {
    name: 'E-mu SP-1200',
    category: 'sampler',
    year: 1987,
    manufacturer: 'E-mu',
    description: '12-bit crunch. Golden era hip-hop. That gritty, punchy sound.',
    teaches: ['Bit depth (12-bit)', 'Sample aliasing', 'Why lo-fi = character'],
    init: () => [
      // Emulate the "crunch" with aggressive settings
      [0x1010, 36],
      [0x1030, 175],
      [0x1040, 140],  // Extra snap

      // No swing (SP timing is different)
      [0x1503, 0],
    ],
    patterns: {
      'Golden Era': {
        bpm: 96,
        kick:  'x.....x...x.....',
        snare: '....x.......x.x.',
        noise: 'x.x.x.xxx.x.x.x.',
      }
    }
  },

  // ============================================================
  // OBERHEIM
  // ============================================================

  'OB-X': {
    name: 'Oberheim OB-X',
    category: 'synth',
    year: 1979,
    manufacturer: 'Oberheim',
    description: 'Van Halen "Jump". Fat, brassy, huge.',
    teaches: ['Discrete voice cards', 'Why analog varies', 'Polysynth history'],
    init: () => [
      // Fat, brassy
      [0x1220, 95],   // Open filter
      [0x1210, 40],   // Some FM
      [0x105E, 15],   // Detune for fatness
      [0x1120, 127],
      [0x1230, 127],
    ],
    patterns: {
      'Jump': {
        bpm: 132,
        lead: '40..40..40..40..3C..3C..3C..3C..',
        bass: '34......34......30......30......',
      }
    }
  },

  // ============================================================
  // MOOG
  // ============================================================

  'Minimoog': {
    name: 'Moog Minimoog',
    category: 'synth',
    year: 1970,
    manufacturer: 'Moog',
    description: 'THE synth bass. Stevie Wonder, Kraftwerk, everyone.',
    teaches: ['Subtractive synthesis', 'Moog ladder filter', 'Monophonic design'],
    init: () => [
      // Fat mono bass
      [0x1220, 50],   // BASS_FILT - classic Moog filtered
      [0x1210, 20],   // Minimal FM
      [0x1230, 127],
      [0x105F, 10],   // Slight detune
    ],
    patterns: {
      'Moog Bass': {
        bpm: 110,
        bass: '24....24..24..27',
      }
    }
  },

  // ============================================================
  // LINN
  // ============================================================

  'LinnDrum': {
    name: 'Linn LM-1 / LinnDrum',
    category: 'drums',
    year: 1980,
    manufacturer: 'Linn Electronics',
    description: 'First sampled drums. Prince, Human League. The 80s sound.',
    teaches: ['Digital sampling', '8-bit samples', 'Roger Linn = genius'],
    init: () => [
      // Sampled feel - natural, less synthetic
      [0x1010, 40],   // Natural kick
      [0x1030, 195],  // Realistic snare
      [0x1040, 90],   // Less synthetic snap
      [0x1310, 5],    // Natural hat decay
    ],
    patterns: {
      '80s Pop': {
        bpm: 118,
        kick:  'x...x...x...x...',
        snare: '....x.......x...',
        noise: 'x.x.x.x.x.x.x.x.',
      },
      'When Doves Cry': {
        bpm: 122,
        kick:  'x.x...x.x.x.....',
        snare: '....x.......x...',
        noise: 'x.x.x.x.x.x.x.x.',
      }
    }
  },

  // ============================================================
  // SEQUENTIAL
  // ============================================================

  'Prophet-5': {
    name: 'Sequential Prophet-5',
    category: 'synth',
    year: 1978,
    manufacturer: 'Sequential Circuits',
    description: 'First programmable polysynth. Saved patches! Revolutionary.',
    teaches: ['Memory/presets', 'Why saving matters', 'Polysynth architecture'],
    init: () => [
      // Warm, programmable poly
      [0x1220, 75],
      [0x1210, 35],
      [0x105E, 8],
      [0x1120, 100],
      [0x1230, 100],
    ],
    patterns: {
      'Poly Pad': {
        bpm: 90,
        lead: '3C..40..43..47..',
        bass: '30......30......',
      }
    }
  },

  // ============================================================
  // FAIRLIGHT
  // ============================================================

  'Fairlight': {
    name: 'Fairlight CMI',
    category: 'sampler',
    year: 1979,
    manufacturer: 'Fairlight',
    description: 'First commercial sampler. Art of Noise, Peter Gabriel. Orchestra hits.',
    teaches: ['Digital sampling', 'Waveform drawing', 'Why samples changed everything'],
    init: () => [
      // The "Fairlight" sound - digital, bright, artificial
      [0x1220, 110],  // Bright
      [0x1210, 15],   // Clean
      [0x1120, 100],
    ],
    patterns: {
      'Orch Hit': {
        bpm: 120,
        lead: '48......48......',  // Big stabs
      }
    }
  },

  // ============================================================
  // GENRE PRESETS (not machines, but styles)
  // ============================================================

  'Techno': {
    name: 'Detroit Techno',
    category: 'genre',
    year: 1988,
    manufacturer: 'Detroit',
    description: 'Belleville Three. Minimal, hypnotic, driving.',
    teaches: ['Repetition as technique', 'Minimalism', 'Why techno works'],
    init: () => [
      [0x1010, 38],
      [0x1030, 190],
      [0x1040, 120],
      [0x1310, 5],
      [0x1503, 0],    // No swing - straight
      [0x1050, 120],
      [0x1051, 85],
      [0x1054, 70],
    ],
    patterns: {
      'Minimal': {
        bpm: 130,
        kick:  'x...x...x...x...',
        snare: '........x.......',
        noise: '..x...x...x...x.',
      }
    }
  },

  'House': {
    name: 'Chicago House',
    category: 'genre',
    year: 1984,
    manufacturer: 'Chicago',
    description: 'Frankie Knuckles, Ron Hardy. Four on the floor. Soulful.',
    teaches: ['Groove construction', 'Swing', 'Sampling culture'],
    init: () => [
      [0x1010, 40],
      [0x1030, 200],
      [0x1040, 130],
      [0x1310, 6],
      [0x1503, 15],   // Slight swing
      [0x1050, 115],
      [0x1051, 100],
      [0x1054, 80],
    ],
    patterns: {
      'Classic House': {
        bpm: 122,
        kick:  'x...x...x...x...',
        snare: '....x.......x...',
        noise: 'x.x.x.x.x.x.x.x.',
        bass:  '24......2724....',
      }
    }
  },

  'Jungle': {
    name: 'Jungle / D&B',
    category: 'genre',
    year: 1992,
    manufacturer: 'UK',
    description: 'Breakbeats at 160+. Amen break chopped. Bass pressure.',
    teaches: ['Breakbeat programming', 'Time-stretching', 'Why 160+ BPM?'],
    init: () => [
      [0x1010, 42],   // Tighter kick
      [0x1030, 210],  // Cracking snare
      [0x1040, 150],
      [0x1310, 3],    // Fast hats
      [0x1503, 0],    // No swing at this speed
    ],
    patterns: {
      'Amen': {
        bpm: 170,
        kick:  'x.....x.x.......',
        snare: '....x..x....x..x',
        noise: 'x.x.x.x.x.x.x.x.',
      }
    }
  },

};

// ============================================================
// PACK LOADER API
// ============================================================

const $1010 = {
  packs: $1010_PACKS,

  /**
   * Load a pack by name
   * @param {string} name - Pack name (e.g., 'TR-808')
   * @param {function} poke - Function to write byte: poke(addr, val)
   */
  loadPack: function(name, poke) {
    const pack = this.packs[name];
    if (!pack) {
      console.error(`Pack not found: ${name}`);
      return false;
    }

    const pokes = pack.init();
    pokes.forEach(([addr, val]) => poke(addr, val));

    console.log(`Loaded: ${pack.name} (${pack.year}) - ${pack.description}`);
    return pack;
  },

  /**
   * Load a pattern from a pack
   * @param {string} packName - Pack name
   * @param {string} patternName - Pattern name within pack
   * @param {function} poke - Poke function
   */
  loadPattern: function(packName, patternName, poke) {
    const pack = this.packs[packName];
    if (!pack || !pack.patterns || !pack.patterns[patternName]) {
      console.error(`Pattern not found: ${packName}/${patternName}`);
      return false;
    }

    // First load the pack init
    this.loadPack(packName, poke);

    // Then load the pattern
    const pattern = pack.patterns[patternName];

    // Set BPM
    if (pattern.bpm) {
      poke(0x1501, pattern.bpm);
    }

    // Parse patterns
    const voices = {
      kick: 0x1000,
      snare: 0x1020,
      lead: 0x1100,
      bass: 0x1200,
      noise: 0x1300
    };

    Object.keys(voices).forEach(voice => {
      if (pattern[voice]) {
        const addr = voices[voice];
        const data = this.parsePattern(pattern[voice]);
        data.forEach((val, i) => poke(addr + i, val));
      }
    });

    return pattern;
  },

  /**
   * Parse pattern string to bytes
   * 'x...x...' -> [1,0,0,0,1,0,0,0]
   * '24..27..' -> [36,0,0,46,0,0] (hex notes)
   */
  parsePattern: function(str) {
    const result = [];
    let i = 0;

    while (i < str.length && result.length < 16) {
      const char = str[i];

      if (char === 'x' || char === 'X') {
        result.push(char === 'X' ? 127 : 1);  // X = accent
        i++;
      } else if (char === '.') {
        result.push(0);
        i++;
      } else if (/[0-9A-Fa-f]/.test(char) && i + 1 < str.length) {
        // Hex byte (e.g., '3C' for MIDI note 60)
        const hex = str.substr(i, 2);
        result.push(parseInt(hex, 16));
        i += 2;
      } else {
        i++;
      }
    }

    // Pad to 16 if needed
    while (result.length < 16) {
      result.push(0);
    }

    return result;
  },

  /**
   * List all available packs
   */
  list: function() {
    const categories = {};
    Object.entries(this.packs).forEach(([name, pack]) => {
      const cat = pack.category || 'other';
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push({ name, year: pack.year, desc: pack.description });
    });
    return categories;
  },

  /**
   * Get pack info
   */
  info: function(name) {
    return this.packs[name] || null;
  },

  /**
   * Generate mini-format string from pack pattern
   */
  toMini: function(packName, patternName) {
    const pack = this.packs[packName];
    if (!pack || !pack.patterns) return null;

    const pattern = pack.patterns[patternName];
    if (!pattern) return null;

    let mini = `BPM:${pattern.bpm || 120}\n`;

    const addrMap = {
      kick: '1000',
      snare: '1020',
      lead: '1100',
      bass: '1200',
      noise: '1300'
    };

    Object.keys(addrMap).forEach(voice => {
      if (pattern[voice]) {
        mini += `${addrMap[voice]}:${pattern[voice]}\n`;
      }
    });

    return mini.trim();
  }
};

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { $1010, $1010_PACKS };
}
if (typeof window !== 'undefined') {
  window.$1010 = $1010;
  window.$1010_PACKS = $1010_PACKS;
}

console.log('$1010 Packs loaded. Try: $1010.list() or $1010.loadPack("TR-808", poke)');
