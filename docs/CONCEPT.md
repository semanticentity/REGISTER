# The memory map is the whole contract

REGISTER started as a sound chip for a teaching computer. Building it showed a bigger pattern: if every setting is a byte at a known address, one map can drive everything else.

## The idea

Design the memory map once. Everything else is a view of the same bytes.

| Layer | What it is | In REGISTER |
| --- | --- | --- |
| Engine | A tiny core that reads bytes and does the work | `runtime.wasm`, 1,291 bytes |
| GUI | Controls that write bytes | Sequencer panels, the MAP panel |
| Text | Bytes written down | Tweet songs, the song language, POKE lines |
| Targets | The same bytes on other machines | MTMC-16, WebAssembly, C, Rust, Intel HEX |
| Contract | The list of what each byte means | `memory-map.json` |

Change the map and every layer follows. Add a pack to the map and it gets an address, a CAPS bit, a control and a text form.

## Why it works

- **A song is a description, not a recording.** Like a vector image, each machine renders it at whatever quality it can. A $5 microcontroller plays the core. A browser plays the effects too.
- **One map, no overlaps.** `tools/check-map.js` fails the build if two features share an address. That rule found a real bug: two packs were writing over the kick's probability, so the downbeat dropped two times out of three.
- **Unknown bytes are ignored.** Machines skip what they don't implement and play the rest.
- **Machines say what they can do.** `CAPS` at `$15F0` lists the packs a machine implements. A GUI can show only the controls that will be heard.

## Precedent

None of the parts are new. That's a good sign.

- [Faust](https://hal.archives-ouvertes.fr/hal-02158925) compiles audio code to WebAssembly and [generates its controls](https://github.com/Fr0stbyteR/faust-ui) from the parameters the code declares.
- PICO-8 gives every game a fixed memory map you can `poke`.
- Hardware synths wired front-panel knobs to chip registers and saved patches as raw bytes.

What's new is putting them in one loop: one map drives the engine, a generated GUI, a text format small enough to post, and five compile targets.

## The agent angle

A memory map is the best interface there is for an AI agent.

- It's small and every value is a typed byte.
- Every write can be checked against the map.
- Results replay exactly, on any target.

Agents are bad at clicking through GUIs and good at writing `POKE $105C, 12`. So the working loop looks like this: a person tunes by ear with sliders, presses COPY, and shares the bytes. An agent edits the bytes and sends them back. The person presses PASTE and listens. Same file underneath, no hand-off format.

## Teaching

The same model works from first lesson to graduate topic. Lesson 1 is two POKEs. Later lessons cover bitmasks, ring buffers, fixed-point math, race conditions, compilers and filters, each one a region of the same map. The arranger shows jumps and branches: a loop is one JUMP event that rewrites the song position, the same move a CPU makes with its program counter.

## Roadmap

1. **Typed map.** Each region declares its type (steps, byte, signed, 16-bit, cents, choice) and range. Done.
2. **Generated GUI.** The MAP panel builds controls from the map for every pack the machine reports in CAPS. Done.
3. **Round trip.** COPY bytes out, PASTE them back in. Done.
4. **A second domain.** PIXEL, a picture chip with its own typed map, sharing memory with the sound chip so the picture reads the beat directly. Both chips' panels come from the same builder. Done.
5. **Hardware.** The core on a Raspberry Pi Pico, then an FPGA, then a [Tiny Tapeout](https://tinytapeout.com/) chip.
