# $1010

Memory-mapped audio coprocessor. 180-byte core. 16-bit address space.

```asm
POKE $1000, 1      ; gate ON at step 0
POKE $1500, 3      ; start sequencer
```

## Memory Map

Audio region: `$1000-$15FF`

### Core (~180 bytes)

| Address | Size | Function |
|---------|------|----------|
| `$1000` | 16 | KICK gate (1=trigger per step) |
| `$1010` | 16 | KICK pitch (MIDI note) |
| `$1020` | 16 | SNARE gate |
| `$1030` | 16 | SNARE tone |
| `$1040` | 16 | SNARE snap |
| `$1100` | 16 | LEAD gate (value=MIDI note) |
| `$1110` | 16 | LEAD arp offset |
| `$1200` | 16 | BASS gate (value=MIDI note) |
| `$1210` | 16 | BASS FM amount |
| `$1300` | 16 | NOISE gate |
| `$1310` | 16 | NOISE decay |
| `$1500` | 1 | SEQ_CTRL (bit0=play, bit1=loop) |
| `$1501` | 1 | SEQ_TEMPO (BPM, 40-200) |
| `$1502` | 1 | SEQ_STEP (0-15) |
| `$1503` | 1 | SEQ_SWING (0-100%) |

### Extension Packs

| Pack | Address | Size | Function |
|------|---------|------|----------|
| XMixer | `$1050-$105B` | 12 | Volume, pan |
| XEnv | `$1060-$1073` | 20 | ADSR envelopes |
| XTuning | `$10A0-$10A7` | 8 | Temperament, A4 ref, detune |

Full pack list: XSteps, XTempo, XTheory, XChord, XFX, XEuclidean, XLFO, XMarkov, XFollow, XPatch, XArp, XSeq, XClock

## Architecture

```
┌────────────────────────────────────┐
│         Host (Browser/Native)      │
│  ┌──────────────────────────────┐  │
│  │      Audio Synthesis         │  │
│  │   (Web Audio / Native DSP)   │  │
│  └──────────────────────────────┘  │
│              ▲ syscalls            │
├──────────────┼─────────────────────┤
│  ┌───────────┴──────────────────┐  │
│  │     $1010 Memory Region      │  │
│  │       $1000-$15FF            │  │
│  └──────────────────────────────┘  │
│              ▲ read/write          │
│  ┌───────────┴──────────────────┐  │
│  │     MTMC-16 / WASM CPU       │  │
│  └──────────────────────────────┘  │
└────────────────────────────────────┘
```

## Assembly Extensions

23 opcodes for MTMC-16. Inspired by SPC-700 (SNES audio CPU).

```asm
; Bit operations (step = bit)
SBIT $00.0        ; set bit 0 at $1000 (step 0 ON)
CBIT $00.4        ; clear bit 4 (step 4 OFF)
BSET $00.0, loop  ; branch if bit set

; Voice operations
SELV #0           ; select voice 0 (kick)
GATE #0, #1       ; gate ON at step 0
NOTE #4, #60      ; MIDI 60 at step 4
TRIG              ; immediate trigger (syscall)

; Sequencer control
PLAY              ; $1500 |= 1
STOP              ; $1500 &= ~1
TICK              ; wait one step (syscall)
BPM #120          ; set tempo

; Loop primitives
LOOP #16, label   ; decrement counter, branch if ≠0
STEP+             ; S = (S+1) & 15
```

Full instruction set: [1010asm.html](1010asm.html)

## Tuning Modes

| Mode | Value | Description |
|------|-------|-------------|
| 12-TET | 0 | Equal temperament (default) |
| JUST | 1 | Just intonation (pure ratios) |
| PYTH | 2 | Pythagorean (perfect fifths) |
| COLUNDI | 3 | Aleksi Perälä's 47-frequency sequence |

```asm
POKE $10A0, 3     ; COLUNDI mode
POKE $10A1, $B8   ; A4 = 440 Hz (low byte)
POKE $10A2, $01   ; A4 = 440 Hz (high byte)
POKE $10A5, 135   ; lead detune +7 cents
```

## Files

| File | Description |
|------|-------------|
| `1010tour.html` | Specification |
| `1010asm.html` | Assembly instruction set |
| `1010sequencer.html` | Browser sequencer |
| `1010arcade.html` | Game demos |
| `1010tweet.html` | Tweet-format player |
| `1010debugger.html` | Memory debugger |
| `1010compiler.js` | DSL → target compiler |
| `1010runtime.wat` | WASM runtime |
| `1010packs.js` | Sound pack definitions |

## Compile Targets

- **MTMC-16**: Native assembly
- **WebAssembly**: Browser target
- **C**: Embedded (Arduino, Pi Pico)
- **Rust**: no_std compatible
- **Intel HEX**: ROM distribution

## Tweet Format

280 characters. Full song.

```
BPM:120
1000:x...x...x...x...
1020:....x.......x...
1100:3C..40..43..40..
1200:24......24..27..
```

## References

- [SPC-700 Instruction Set](https://wiki.superfamicom.org/spc700-reference) - Sony SNES audio CPU
- [MTMC-16](https://github.com/bigskysoftware/mtmc-16) - Montana State teaching computer
- [Colundi Sequence](https://daily.bandcamp.com/lists/colundi-aleksi-perala-interview) - Alternative tuning system

## License

MIT
