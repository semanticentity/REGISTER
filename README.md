# $1010

A memory-mapped audio coprocessor. 180-byte core. Infinite leverage.

```
POKE $1000, 1      ; kick on step 0
POKE $1500, 3      ; play
; That's it. You're making music.
```

## Philosophy

Like htmx extends HTML without replacing it, $1010 extends memory without hiding it. Tiny core, explicit extensions. A student's first program is 2 lines.

## Files

| File | Description |
|------|-------------|
| `1010tour.html` | Language specification and tutorial |
| `1010asm.html` | Assembly extensions for MTMC-16 (inspired by SPC-700) |
| `1010sequencer.html` | Full-featured browser sequencer |
| `1010arcade.html` | Game Boy-style arcade demos |
| `1010tweet.html` | Play songs from tweet-sized code |
| `1010debugger.html` | Step-through memory debugger |

## Architecture

```
┌─────────────────────────────────────────────┐
│  $1010 Memory Map ($1000-$15FF)             │
├─────────────────────────────────────────────┤
│  Core (~180 bytes)                          │
│  ├── $1000-$104F  Drums (kick, snare)       │
│  ├── $1100-$112F  Lead                      │
│  ├── $1200-$122F  Bass                      │
│  ├── $1300-$132F  Noise                     │
│  └── $1500-$1503  Sequencer control         │
├─────────────────────────────────────────────┤
│  Tier 1 Packs (~40 bytes)                   │
│  ├── XMixer   $1050-$105B  Volume/pan       │
│  ├── XEnv     $1060-$1073  ADSR envelopes   │
│  └── XTuning  $10A0-$10A7  Microtuning      │
├─────────────────────────────────────────────┤
│  Tier 2+ Packs ($1600+)                     │
│  └── XSteps, XTheory, XEuclidean, XLFO...   │
└─────────────────────────────────────────────┘
```

## Quick Start

1. Open `1010tour.html` in a browser
2. Read the spec, understand the memory map
3. Open `1010sequencer.html` to play
4. Check `1010asm.html` for assembly-level programming

## Teaching

$1010 was designed for [MTMC-16](https://github.com/bigskysoftware/mtmc-16), Carson Gross's teaching computer for Montana State University. One primitive, entire CS curriculum:

- Memory-mapped I/O → POKE address, hear result
- Hex/binary → $3C = 60 = 0011 1100
- Bit manipulation → SBIT, CBIT for step sequencing
- Syscalls → TICK crosses CPU/audio boundary
- Tuning theory → Why 440Hz? Why 12 notes?

## Inspiration

- **SPC-700**: Sony's SNES audio CPU. 6502 + audio extensions.
- **htmx**: Extend HTML, don't replace it.
- **Colundi**: Aleksi Perälä's 47-frequency tuning system.

## License

MIT

---

*Sound is memory. Memory is bytes. Bytes are yours.*
