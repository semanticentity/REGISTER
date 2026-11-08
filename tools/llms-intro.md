# REGISTER

> A memory-mapped sound chip for teaching. Every setting is a byte at a fixed address in $1000-$1FFF. You make music by writing bytes (POKE) and you can read every setting back (PEEK). The memory map in memory-map.json is the whole contract: typed fields, ranges, and a note on every field.

This file is for language models and other programs that want to write REGISTER songs and sounds. It is generated from memory-map.json and engine.js by tools/build-llms.js, and CI fails when it is out of date. Every example in it is run by the test suite: each line is sent to the console, the bar is rendered, and the voices it names must be heard.

## How to write to the chip

On any REGISTER page, open the console with the backtick key, or call `REGISTER.run(line)` from JavaScript. Lines look like this:

- `POKE $1501, 120` writes one byte. `$` or `0x` is hex; plain numbers are decimal.
- `POKE SEQ_TEMPO 120` does the same by name. Prefer names: they are harder to get wrong than addresses.
- `POKE BASS_ENGINE pokey` and `POKE WAVE_MODE WSG 4-bit` use a field's own words: an option, or an engine's name.
- `PEEK SEQ_TEMPO` reads a byte. `FIND unison` searches the map. `CAPS` lists what this machine implements.

Writing a read-only byte, or an address outside every map, is an error with a reason. Nothing else is: rule 2 below.

## Three rules

1. One map, no overlaps. Every address belongs to exactly one region in memory-map.json.
2. Unknown regions are ignored, not errors. A machine without a pack skips its bytes and plays the rest.
3. Machines declare what they can do. CAPS ($15F0-$15F3) holds pack bits 0-31 and CAPS_EXT ($15F5-$15F8) bits 32-63. Read them before relying on a pack.

## The core: a beat in 16 steps

Five voices, 16 steps each. A step's byte is its gate: 0 is silent. For lead and bass the gate byte is the MIDI note (60 = middle C).

```register hear=kick,snare,lead,bass,noise
POKE SEQ_TEMPO 120
POKE $1000, 1
POKE $1004, 1
POKE $1008, 1
POKE $100C, 1
POKE $1024, 1
POKE $102C, 1
POKE $1100, 64
POKE $1106, 67
POKE $110A, 71
POKE $1200, 40
POKE $1208, 43
POKE $1302, 1
POKE $130A, 1
```

Rows: KICK_GATE $1000, SNARE_GATE $1020, LEAD_GATE $1100, BASS_GATE $1200, NOISE_GATE $1300. Step n of a row is its start plus n.

## Engines

Each voice has an engine byte (KICK_ENGINE, SNARE_ENGINE, LEAD_ENGINE, BASS_ENGINE, NOISE_ENGINE). The value is an index into that voice's list:

{{ENGINES}}

Engines with a chip bank (fm, sid, lpc, wave, pokey) read their settings from that pack. FM, SID, speech and the wavetable are one patch shared by every voice on that engine. POKEY gives each voice its own channel: BASS_POKEY_POLY, BASS_POKEY_DIV, BASS_POKEY_VOL and so on.

```register hear=bass
POKE $1200, 33
POKE $1208, 33
POKE BASS_ENGINE pokey
POKE BASS_POKEY_POLY 4-bit
POKE POKEY_CLOCK 64 kHz
```

```register hear=lead
POKE $1100, 60
POKE $1104, 64
POKE $1108, 67
POKE LEAD_ENGINE wave
POKE WAVE_MODE WSG 4-bit
```

## Sounds as text

A sound is a list of fields by name, without the voice prefix: `A` means LEAD_A on the lead and BASS_A on the bass. The voice you load it onto supplies the base address. Values are readable: numbers, option names, engine names. Lines a voice or machine does not have are skipped with a reason. `FROM` says which voice it was made on; render.js loads it onto that voice. Use `RegisterSounds.resolve(index, text, voice, opts)` to see what would be written on any voice, or the SND drawer in the sequencer.

```sound hear=lead
SOUND Bright Lead
FROM lead
; FM, two stacks, the classic arcade algorithm
ENGINE = fm
A = 2
D = 60
S = 170
R = 50
FM_ALGORITHM = 4
OP1_RATIO = 16
OP1_LEVEL = 200
OP2_RATIO = 32
OP2_LEVEL = 90
OP3_RATIO = 16
OP3_LEVEL = 120
OP4_RATIO = 48
OP4_LEVEL = 60
```

## Check your work by rendering

A model cannot hear, so measure. `node tools/render.js song.txt` loads the sequencer in a headless browser, runs each line, renders the bars through the same engine as WAV export, and prints JSON: each voice's loudness and pitch played alone, the mix's peak, CAPS, and any fault. A voice you meant to hear with an rms near 0 did not sound. For lead and bass, `pitchHz` is the lowest repeating period and `centsOff` compares it with the nearest octave of the note you wrote: near 0 is in tune. Some engines add a sub-oscillator, so `octave` -1 can be right. A large `centsOff` means a wrong note, tuning or clock.

```sh
node tools/render.js song.txt --clear --bars 1
```

`--clear` starts from silence instead of the page's demo pattern.

## Faults

The chip skips what it cannot do and keeps playing, and records what it skipped in FAULT_CODE ($1511) and FAULT_ADDR ($1512). render.js reports it. Codes: 1 = a lock aimed outside the sound settings, 2 = the bus queue overflowed, 3 = an engine byte names no engine.
