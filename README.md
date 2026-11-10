# REGISTER

Memory-mapped audio coprocessor. 217-byte core. 16-bit address space.

```asm
POKE $1000, 1      ; gate ON at step 0
POKE $1500, 3      ; start sequencer
```

## Memory Map

Audio region: `$1000-$1FFF`. The core lives in `$1000-$15FF`; packs fill the rest.

### Core (217 bytes)

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
| `$15F0` | 4 | CAPS, read-only: packs this machine implements |
| `$15F4` | 1 | SPEC_VERSION, read-only |
| `$15F5` | 4 | CAPS_EXT, read-only: packs 32-63 |

### Extension Packs

| Pack | Address | Size | Function |
|------|---------|------|----------|
| XVoice | `$1050-$105F` | 16 | Drum character, engine select, lead and bass unison |
| XEnv | `$1060-$1073` | 20 | ADSR envelopes |
| XFX | `$1080-$109F` | 32 | Filter, delay, bitcrush |
| XTuning | `$10A0-$10A7` | 8 | Temperament, A4 ref, detune |
| XMixer | `$10A8-$10B9` | 12 | Volume, pan |
| XStep | `$1400-$149F` | 160 | Per-step probability, ratchets |
| XFM | `$1900-$192F` | 48 | 4-operator FM, the 8 Yamaha algorithms, DT1 detune |
| XSong | `$1760-$18FF` | 416 | Song structure: timed POKE, COPY, JUMP, STOP |
| XLPC | `$14E0-$14EF` | 16 | Speak & Spell speech: 30 phonemes, formant filters |
| XSID | `$1A00-$1A0F` | 16 | C64-style oscillators |
| XWave | `$1A20-$1A4F` | 48 | Wavetable: 32 samples, SCC 8-bit or WSG 4-bit |
| XPokey | `$1A50-$1A5F` | 16 | Atari POKEY: square waves and polynomial counters |
| XBus | `$1508-$150F` | 8 | Bus budget: so many automation writes per step |
| XFault | `$1510-$1513` | 4 | Fault register: what the chip skipped, and halt on fault |

Full pack list: XSteps, XTempo, XTheory, XChord, XEuclidean, XLFO, XMarkov, XFollow, XPatch, XArp, XSeq, XClock, and more. Every region is in [`memory-map.json`](memory-map.json).

## Design Rules

A song is a description, not a recording. Each machine plays it at whatever quality it can, like a vector image. Three rules keep that true as the spec grows:

1. **One map, no overlaps.** Every address belongs to exactly one region in `memory-map.json`. Run `node tools/check-map.js` before every commit. It fails if regions overlap or any file uses unassigned space.
2. **Unknown regions are ignored, not errors.** A machine without a pack skips its bytes and plays the rest.
3. **Machines declare what they can do.** Each machine writes a bitmask of the packs it implements to `CAPS` (`$15F0-$15F3`, little-endian) and its map version to `SPEC_VERSION` (`$15F4`). Bit 0 is the core. The WASM core reports `0x20000001`: the core plus the XSong arranger (bit 29). All 32 bits are taken, so packs 32-63 go in a second word, `CAPS_EXT` (`$15F5-$15F8`), the way a CPU adds an extended CPUID leaf. A machine older than the second word reads 0 there, which is the truth: it has none of those packs.

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
│  │   REGISTER Memory Region     │  │
│  │       $1000-$1FFF            │  │
│  └──────────────────────────────┘  │
│              ▲ read/write          │
│  ┌───────────┴──────────────────┐  │
│  │  MTMC-16 (x366) / WASM CPU   │  │
│  └──────────────────────────────┘  │
└────────────────────────────────────┘
```

## Assembly (x366)

The MTMC-16 runs x366, an x86-style 16-bit assembly. REGISTER adds no instructions to it. The chip watches memory, so a MOV is a POKE:

```asm
.MEMORY 16K               ; the chip sits at 0x1000-0x1FFF, under the stack

    MOV [0x1000], 1       ; KICK_GATE[0]
    MOV [0x1501], 120     ; SEQ_TEMPO
    MOV [0x1500], 3       ; SEQ_CTRL: play and loop, always last

    SYSCALL READ_CHAR     ; wait for a key
    MOV [0x1500], 0       ; stop
    SYSCALL EXIT
```

Pointers, LOOP and a Euclidean rhythm in x366, plus a proposal for sound in the MTMC-16 emulator: [asm.html](asm.html)

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
| `index.html` | Home page linking every demo |
| `tour.html` | Specification |
| `asm.html` | Playing the chip from x366, the MTMC-16 assembly, and a proposal for sound in its emulator |
| `sequencer.html` | Browser sequencer |
| `arcade.html` | Game demos |
| `tweet.html` | Tweet-format player. Runs on the WASM core, shows live memory, exports to all five targets |
| `debugger.html` | Memory debugger |
| `compiler.js` | DSL → target compiler |
| `runtime.wat` | WASM runtime source |
| `runtime.wasm` | Built WASM runtime (1,291 bytes) |
| `wasm-host.js` | Minimal JS host for embedding the WASM runtime elsewhere (simple voices; load `engine.js` for the full sound) |
| `tools/build-wasm.js` | Rebuilds the `.wasm` and embeds it in the tweet player |
| `memory-map.json` | The one memory map: every region, its pack, field types and ranges, and the CAPS bits |
| `memory-map.js` | Generated from the JSON (`node tools/check-map.js --write`) so pages opened from disk can load it |
| `docs/CONCEPT.md` | The idea behind it: the memory map is the whole contract |
| `pixel.html` | PIXEL picture chip and the sound chip in one address space |
| `pixel.wat` / `pixel.wasm` | PIXEL core (1,776 bytes): plasma, rings, raster bars, xor, beat sync |
| `pixel-map.json` / `pixel-map.js` | PIXEL's typed memory map (`$2000-$3FFF`) |
| `map-panel.js` | Builds controls, COPY and PASTE from any typed map |
| `engine.js` | The sound engine every page shares: voices, envelopes, mixer, effects, WAV render |
| `lesson-kit.js`, `lesson1-3.html` | The lessons and the small kit they share |
| `dom-bridge.js`, `tools/map-from-html.js` | Port any HTML instrument: draft its map, bind memory to its controls |
| `white-dwarf-map.json`, `bridges/` | The WHITE DWARF port |
| `chip-editors.js` | The wave and parameter lock editors |
| `sounds.js` | Portable sounds by field name: save, duplicate, templates, share links |
| `register-console.js` | `REGISTER.POKE` / `PEEK` and the in-page console (press the backtick key) |
| `tools/check-map.js` | Checks the map for overlaps and every file for addresses outside it |
| `packs.js` | Sound pack definitions |

Old `1010*.html` addresses redirect to the new names, so existing links keep working.

## Compile Targets

- **MTMC-16**: x366 assembly, plain byte stores
- **WebAssembly**: Browser target
- **C**: Embedded (Arduino, Pi Pico)
- **Rust**: no_std compatible
- **Intel HEX**: ROM distribution

## Building the WASM core

The tweet player carries the core inline, so it works from a double-click with no server.
After any change to `runtime.wat` or `pixel.wat`:

```sh
npm install
npm run build
```

This writes the `.wasm` files and re-embeds them in `tweet.html` and `pixel.html`. `npm run check` fails if they ever drift from their source.

## Make it talk (XLPC)

The Speak & Spell chip is a lead or bass engine: a buzz or breath-noise source shaped by three formant filters, like a vocal tract. The note picks the phoneme (C4 = EE, then IH, EH, AE, AH... through 30). In the sequencer's console (press `` ` ``):

```
POKE LEAD_ENGINE 3     ; lead plays through the speech chip
POKE $1100, 80         ; HH
POKE $1101, 62         ; EH
POKE $1102, 70         ; L
POKE $1103, 68         ; OH
```

Then press PLAY. The MAP panel shows every speech setting, including a phoneme menu that overrides the note.

## Console

Press the backtick key (`` ` ``) on the tweet player, the sequencer or PIXEL to open a console:

```
POKE $105C, 12            write a byte
POKE LEAD_UNISON_SPREAD 12  names from the memory maps work too
PEEK SEQ_TEMPO            read a byte (or just type $1501)
DUMP $1000 32             hex dump
FIND unison               search the maps
CAPS                      what each chip implements
```

The same calls work from JavaScript: `REGISTER.POKE('$105C', 12)`, `REGISTER.PEEK('SEQ_TEMPO')`. Writes are checked against the typed maps: read-only bytes and addresses outside every map are refused with a reason. That makes the console the easiest way for scripts and agents to drive a chip.

## The MAP panel

In the sequencer, the **MAP** button opens controls generated from `memory-map.json` for every pack the machine reports in CAPS. Each control reads and writes memory directly. **COPY** on any pack (or on the lead and bass panels) gives you its bytes as `POKE` lines. Paste lines like these into the MAP panel and press **LOAD** to write them back:

```
POKE $105C, 12    ; LEAD_UNISON_SPREAD
@poke $1081 200
$1094: 4
```

`$` or `0x` means hex, plain numbers are decimal. Read-only bytes (CAPS, SPEC_VERSION, SEQ_STEP) are skipped.

## Sounds: one description, any voice

Press **SND** on any voice in the sequencer. A sound is text that sets fields by name, not by address:

```
SOUND Slow Pad
A = 140
D = 90
S = 200
R = 200
VOL = 90
UNISON_SPREAD = 18
UNISON_COUNT = 5
```

`A` means `LEAD_A` ($1068) on the lead and `BASS_A` ($106C) on the bass. The voice you load it onto supplies the base address, the way a pointer supplies the base of a struct. So the same sound fits any voice, the way one vector drawing fits any screen.

The fields fall into three blocks, all worked out from `memory-map.json`:

1. **Every voice has these:** engine, envelope, fine tune, volume, pan, velocity. These always land.
2. **Only some voices have these:** unison (lead and bass), drum character (kick and snare). They land where the voice has them and are skipped elsewhere.
3. **Chip settings:** FM, SID, speech and the wavetable each have one patch for the whole chip. POKEY gives each voice its own channel (`POKEY_POLY`, `POKEY_DIV`, `POKEY_VOL`). Those lines apply only when the voice ends up on that engine, so loading a sound never changes the patch another voice is using.

Anything a voice or machine lacks is skipped with a reason ("kick does not have it; lead, bass do"). That is design rule 2 again: unknown regions are ignored, not errors. A machine's CAPS decide which packs count as present.

Every field in the first block is heard on every engine. Lead, bass, FM and SID engines take the envelope directly. Drum, noise and speech engines keep their own shape, and the envelope rides on top of it: rise over A, fall to S over D, hold for one step, fade over R. For those engines A 0, S 255, R 255 is neutral, and R 255 lets the sound ring out. Each voice has its own channel strip for volume, velocity and pan.

WAV export renders through the same engine you hear, pointed at an offline audio context: same engines, envelopes, unison, channel strips, bitcrush, filter and delay. What you design is what you export.

In the drawer:

- **Starters** and **From the presets** are templates. Load one, change it, and SAVE keeps your own copy; the original stays as it was.
- **My sounds** are kept in your browser. **DUP** makes a copy to change, **DEL** removes one (tap twice).
- **APPLY** writes the sound to the chosen voice and plays one note so you hear it.
- **AS POKES** compiles the sound to POKE lines for one voice: the same sound, lowered to addresses. **FILE** downloads it, **LINK** copies a link that carries it.

## Effects that follow

The master filter can open on a hit and close again (the "wah" on each note). What opens it is programmable, like everything else:

| Address | Field | What it does |
| --- | --- | --- |
| `$1083` | FILTER_ENV | How far the filter opens on a hit. 0 = off |
| `$1084` | FILTER_ENV_FOLLOW | Which voices open it, one bit each: kick = bit 0, snare = 1, lead = 2, bass = 3, noise = 4. 0 = every voice |
| `$1085` | FILTER_ENV_CLOSE | How fast it closes. 0 = one step, else 0-1000 ms |

```asm
POKE $1080, 1     ; low-pass
POKE $1081, 20    ; mostly closed
POKE $1083, 200   ; open wide on a hit
POKE $1084, 5     ; kick and lead only: 1 + 4 = %00101
```

Bits as a list of choices is the lesson: `%00101` is "kick and lead", and AND tells the chip whether a voice is on the list.

### Values the map does not list

Real chips had behavior nobody documented: the 6502's undocumented opcodes, the SID's mixed waveforms when you set two wave bits at once. People found them by poking values the manual skipped. REGISTER has at least one. It hides in the bitcrush register, under this project's old name.

## Wavetable voice (XWAVE)

A waveform is just bytes. `$1A20-$1A3F` holds one cycle of a wave as 32 signed samples, -128 to 127, the way the Namco WSG and Konami SCC chips did it. Set any voice's engine to `wave`. Lead and bass play the shape at the note's pitch. Kick, snare and noise play it fast and bent: neither chip had a noise channel, so their drums were the wavetable too, and the "noise" here is the table jumping to a random pitch every half millisecond.

`WAVE_MODE` (`$1A40`) picks how the table is read. SCC 8-bit plays every byte. WSG 4-bit keeps 16 levels, as the Namco chip stored them, and sounds grittier. In the sequencer, **WAVE** lets you draw it with a finger or a mouse, or start from sine, saw, square, triangle, random, or a WSG or SCC style shape.

```asm
POKE $115A, 4     ; lead engine 4 = wave
POKE $1A20, 127   ; first sample: top
POKE $1A30, 128   ; sample 16: bottom (128 is -128 as a signed byte)
POKE $1A40, 1     ; WSG 4-bit
```

## FM, wired like the Yamaha chips (XFM)

Four operators. Each one is an oscillator that you either hear (a carrier) or that pushes another operator's pitch around (a modulator). `FM_ALGORITHM` (`$1910`) picks the wiring, and the numbers are the YM2151's and YM2612's own, so a patch from an arcade board or a Genesis keeps its algorithm. Counting the chain from OP4 down:

| Algorithm | Wiring | Sounds like |
| --- | --- | --- |
| 0 | 4 > 3 > 2 > 1 | one deep stack: bells, basses |
| 1 | (4 + 3) > 2 > 1 | |
| 2 | (4 + (3 > 2)) > 1 | |
| 3 | ((4 > 3) + 2) > 1 | brass |
| 4 | (4 > 3) + (2 > 1) | two stacks: the arcade lead, electric piano |
| 5 | 4 > (3, 2, 1) | one modulator, three carriers |
| 6 | (4 > 3) + 2 + 1 | |
| 7 | 4 + 3 + 2 + 1 | four sines: an organ |

A ratio byte is the multiple of the note: 16 = 1x, 32 = 2x, 0 = 0.5x. Feedback makes an operator modulate itself, which bends a sine toward a saw; `FM_GLOBAL_FB` adds to OP4, the one the Yamaha chips let feed back. `OP1_DT1` to `OP4_DT1` (`$1912-$1915`) are the YM2151's small detune, a few cents up or down, so stacked operators beat against each other. The drawer has OPM starters (arcade lead, slap bass, brass, strings, electric piano) built from these.

## POKEY (XPOKEY)

The Atari 8-bit's sound chip divides one clock down to make pitch. A channel either flips a square wave on every count (pure) or reads a polynomial counter, a shift register whose bits repeat every 15, 31, 511 or 131071 counts. The short ones buzz; the long ones hiss. Volume has 16 steps, and a game changed volume and pitch once per video frame, 60 times a second, so a POKEY kick drops in steps you can hear.

Set any voice's engine to `pokey`. Each voice has three bytes from `$1A50`: `POLY` (pure, 4-bit, 5-bit, 9-bit, 17-bit), `DIV` (the divider, for drums and noise; lead and bass take the note) and `VOL` (1-15). `POKEY_CLOCK` (`$1A5F`) is the clock they count: at 64 kHz the divider is 8 bits and high notes land out of tune, the way Atari music sounds; 1.79 MHz joins two channels into a 16-bit divider, as Atari composers did, and is in tune.

```asm
POKE $125A, 4     ; bass engine 4 = pokey
POKE $1A59, 2     ; BASS_POKEY_POLY = 4-bit: the buzzy Atari bass
```

## Bus budget (XBUS)

A real sound chip sits on a bus that takes only so many register writes per video frame. Composers on the SID, the SNES's SPC700 and the Amiga's Paula all worked inside limits like it. Turn `BUS_CTRL` (`$1508`) on and the automation that writes memory while a song plays, parameter locks first, then the LFO, then evolve, shares `BUS_SPEED` (`$1509`) writes per step. What does not fit fails the way `BUS_MODE` (`$150A`) says:

| Mode | The write that does not fit | Like |
| --- | --- | --- |
| drop | is lost | a CPU that ran out of time |
| corrupt | lands with some bits flipped | a register conflict |
| late | lands at the start of the next step | DMA taking the bus first |
| alias | lands one address line away | a bus glitch |

What you click, type or POKE yourself is never budgeted. `BUS_OVERFLOWS` (`$150B`) counts the misses and `BUS_LOAD` (`$150C`) shows this step's writes. In the sequencer, **BUS** has the settings and a load meter, and a missed write marks its grid cell for a moment. The question is not how to avoid it, but how to make it part of the sound.

## Faults and panic (XFAULT)

Rule 2 says a machine skips what it cannot do and keeps playing. The fault register is where it says what it skipped: `FAULT_CODE` (`$1511`) and the address involved (`FAULT_ADDR`, `$1512-$1513`).

| Code | Fault |
| --- | --- |
| 1 | A parameter lock aimed outside the sound settings (the transport, CAPS, the lock table) |
| 2 | The bus queue overflowed, so a late write was lost |
| 3 | An engine byte names no engine; the voice played its first one |

Set `FAULT_CTRL` (`$1510`) to 1 and the sequencer halts on a fault instead: playback stops and a panic screen shows the code, the address and the bytes around it, the way a real machine reports a crash. **RST** clears the code. The switch is in the **BUS** panel.

## 11 to 9

A mixing exercise in the sequencer. **11→9** turns every voice up to the top, 11. Then you pull them back to 9, one at a time, until one is left. The one you could not pull back is your lead. It is only `VOICE_VOL` bytes (`$10B0-$10B4`): 11 is 127, 9 is 104, about 82%. The panel shows the POKE lines it wrote. **KEEP** keeps the new mix; **UNDO** puts yours back.

## Parameter locks (XSEQ)

A lock changes one setting on one step only, then puts it back: a brighter snare on step 12, a louder lead on the last note. `$1E00` counts the locks; each is 4 bytes from `$1E01`: step, address low byte, address high byte, value. On that step the chip writes the value, plays, and restores the old byte. In the sequencer, **LOCKS** lists every setting in the map to choose from.

```asm
POKE $1E00, 1     ; one lock
POKE $1E01, 12    ; on step 12
POKE $1E02, $55   ; address $1055 (SNARE_NOISE_LEVEL), low byte
POKE $1E03, $10   ; high byte
POKE $1E04, 230   ; value for that step
```

## Debugger: breakpoints and watchpoints

In the step debugger, click a step number to set a **breakpoint**: the chip stops before it reads that step. Click a byte in the memory inspector to **watch** it: the chip stops the moment it changes, whether the song, a click or a console POKE changed it. PLAY or STEP continues.

## Port any instrument

REGISTER is a contract, not only a chip: a typed memory map, CAPS, and POKE. Any HTML instrument whose settings are controls can join.

1. **Draft a map** from the instrument's HTML: `node tools/map-from-html.js instrument.html config.json > name-map.json`. The config names the machine, picks its address space, and groups controls into packs by id. Each control becomes one typed byte: a range input becomes a byte spread across its range (on a log curve for wide frequency ranges), a select becomes an enum, checkboxes become bits, and a step sequence becomes `steps`.
2. **Attach the bridge**: `RegisterBridge.attach({ map })` from `dom-bridge.js`. A POKE moves the instrument's own control and fires the same event a hand would, so the instrument reacts normally. Moving a control rewrites the byte. Nothing inside the instrument changes.
3. **Dock it**: `RegisterBridge.dock({ map, bridge })` adds a MAP button with the generated controls, COPY and PASTE, and the console.

4. **Adapt what is not a control.** State kept in objects (a list of patch cables, per-step settings) gets a small adapter: `custom: { kind: { read(binding, mem), write(binding, mem) } }`, used by map fields whose control is `{ "custom": "kind" }`.

[WHITE DWARF](bridges/white-dwarf.config.json) is the first port, at `$4000-$4FFF`: 91 controls, its five 32-step tracks, per-step velocity, probability, ratchet, trig pass and bass accent, the Lyra note banks A to D, and 16 patch bay slots. [`bridges/white-dwarf.js`](bridges/white-dwarf.js) is its adapter. `white-dwarf-map.json` passes the same checks as the REGISTER and PIXEL maps. It covers everything WHITE DWARF saves in a preset: a round trip (save memory, scramble WHITE DWARF with its own randomizers, restore memory) brings back every pattern, per-step setting, Lyra bank, patch, effect and toggle exactly, and 83 of 93 sliders exactly; the rest land within one byte step (under 1% of their range). A full restore takes about 75 ms; keeping memory in step takes under 1 ms.

To attach it, add these before `</body>`:

```html
<script src="https://semanticentity.github.io/REGISTER/white-dwarf-map.js"></script>
<script src="https://semanticentity.github.io/REGISTER/map-panel.js"></script>
<script src="https://semanticentity.github.io/REGISTER/register-console.js"></script>
<script src="https://semanticentity.github.io/REGISTER/dom-bridge.js"></script>
<script src="https://semanticentity.github.io/REGISTER/bridges/white-dwarf.js"></script>
```

## PIXEL: a second chip on the same pattern

`pixel.html` runs two chips in one address space, like a console. The picture chip imports the sound chip's memory, so it reads the song step (`$1502`) and the kick (`$1000`) directly and flashes on the beat with no glue code.

| Address | What |
|---------|------|
| `$2000-$2007` | Picture on, effect (plasma, rings, bars, xor), speed, frequency, zoom, warp, palette cycling |
| `$2010-$202F` | Beat sync: flash on the kick or on marked steps |
| `$2100-$210B` | Palette RAM: 4 colors |
| `$2200-$22FF` | Sine lookup table the chip builds at start (no floating point) |
| `$3000-$3FFF` | 64x64 framebuffer, one palette index per pixel |

Its map lives in `pixel-map.json`, checked by the same `tools/check-map.js`, and both chips' control panels are built by the same `map-panel.js`. Presets are just POKE lines.

Scroll down to the settings and a mini view of the picture follows you in the corner, so you can watch it while you move sliders. Tap it to jump back up. POP sends it to the browser's own floating window, which stays on top of other apps where the browser supports it.

## Lessons

Three short lessons that run in the page and check your work as you go:

1. [Memory and POKE](lesson1.html): addresses, bytes, hex, and why a memory-mapped chip needs no sound command.
2. [Bits and Patterns](lesson2.html): eight bits make a byte, a hex digit is four bits, a bar fits in two bytes, and a byte can be a list of choices.
3. [A Sound Is a Struct](lesson3.html): fields and offsets, an array of structs, a voice as a pointer, and names that compile to addresses.

They share `lesson-kit.js` and play through `engine.js`, the same engine as everything else.

## Song Structure

Patterns are bars. The arranger plays them in order. Everything before the first time marker is setup; everything after happens at a time:

```
@at 0
@play intro
@at 2b          ; bar 3
@play full
@loop start
> 4b            ; same as @after 4b
@loop end       ; jump back to @loop start
```

It compiles to an event table at `$1770`: each event is "at step N, do POKE / COPY / JUMP / STOP". A loop is a JUMP that rewrites the song position, the same way a CPU loops by rewriting its program counter. The tweet player plays full songs too: any line starting with `@` switches it to song mode.

## Tweet Format

280 characters. Full song.

```
BPM:120
1000:x...x...x...x...
1020:....x.......x...
1100:3C..40..43..40..
1200:24......24..27..
```

One character per step for drums (`x` hit, `.` rest). Hex pairs for notes, one pair per step,
so a melody line can run to 32 characters to fill all 16 steps.

## For language models

[`llms.txt`](llms.txt) is the short version of this README for language models and other programs: the rules, how to POKE by name, the engines, sounds as text, and one line per pack. [`llms-full.txt`](llms-full.txt) adds every field with its address, range and note. Both are generated from `memory-map.json` and `engine.js` by `tools/build-llms.js`, and CI fails if they are out of date. Every example in them is run by the tests: the lines go to the console, the bar is rendered, and the voices the example names must be heard at the notes it wrote.

A model cannot hear, so it can measure instead:

```sh
node tools/render.js song.txt --clear
```

That runs the lines in a headless browser, renders through the real engine, and prints JSON: each voice's loudness and pitch played alone, whether the mix clips, CAPS, and any fault. The console also takes a field's own words as values (`POKE BASS_ENGINE pokey`, `POKE WAVE_MODE WSG 4-bit`), and a wrong one says what the field takes.

## Tests

```sh
npm install                        # Playwright and wabt, pinned
npx playwright install chromium    # once, for the browser tests
npm test                           # everything
npm run test:unit                  # only the Node tests, no browser
npm run check                      # memory maps and WASM cores match their sources
```

The tests live in `tests/`, with a short harness you can read in one sitting (`tests/lib.js`, `tests/run.js`). Sound is tested by rendering it: a test sets bytes, renders a bar through the same engine as WAV export, and measures the samples. GitHub runs all of it on every push.

## References

- [SPC-700 Instruction Set](https://wiki.superfamicom.org/spc700-reference) - Sony SNES audio CPU, which played music by writing the DSP's registers
- [MTMC-16](https://github.com/msu/mtmc) - Montana State teaching computer and its x366 assembly
- [Colundi Sequence](https://daily.bandcamp.com/lists/colundi-aleksi-perala-interview) - Alternative tuning system

## License

MIT
