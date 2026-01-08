# Carson Review Notes

Anticipated questions, pushback, and integration path for MTMC-16.

---

## Critical Bugs to Fix First

### 1. ~~WASM Backend Bug (1010compiler.js:760)~~ FIXED

```javascript
// OLD - assumed linear voice layout
(i32.add (i32.mul (local.get $voice) (i32.const 0x100)))

// NEW - uses lookup table at $0F00
(data (i32.const 0x0F00) "\00\10")  ;; voice 0: $1000
(data (i32.const 0x0F02) "\20\10")  ;; voice 1: $1020
(data (i32.const 0x0F04) "\00\11")  ;; voice 2: $1100
(data (i32.const 0x0F06) "\00\12")  ;; voice 3: $1200
(data (i32.const 0x0F08) "\00\13")  ;; voice 4: $1300

(func $voice_base (param $voice i32) (result i32)
  (i32.load16_u (i32.add (i32.const 0x0F00) (i32.mul (local.get $voice) (i32.const 2)))))
```

**FIXED** - Now uses proper lookup table for non-linear voice layout.

### 2. Memory Map Inconsistencies

Files reference addresses not in core spec:
- `$1050-$105F` (mixer) - documented in XMixer pack but used as if core
- `$1220` (BASS_FILT) - in runtime.wat but not README
- `$1320` (NOISE_TYPE) - same issue

**Decision needed: what's truly core vs pack?**

---

## Carson's Likely Questions

### Architecture

**Q: "Why $1000 as base address?"**
- A: Standard convention for MMIO regions (ROM at $0000, RAM at $8000, MMIO at $1000-$1FFF)
- Leaves $0000-$0FFF for program code
- Matches 6502/SPC-700 memory maps he'll recognize

**Q: "Why 5 voices specifically?"**
- A: Minimal set that covers all synthesis types:
  - Kick (pitched percussion)
  - Snare (noise + tone hybrid)
  - Lead (melodic square/saw)
  - Bass (sub + harmonics)
  - Noise (hats/fx)
- SPC-700 had 8 voices, but 5 is more teachable
- Can extend with packs (XVoice at $1400+)

**Q: "180 bytes seems arbitrary"**
- A: Actually 176 bytes for patterns + 4 for sequencer = 180
- 5 voices × 32 bytes each (gate + params) + 4 control = 164 actual
- Fits in single page, tweet-friendly

### Assembly Extensions

**Q: "Why not just use MTMC-16 base instructions?"**
- A: You CAN. `POKE $1000, 1` compiles to standard store-byte
- Extensions are convenience: `SBIT $00.0` = set step 0 on
- Inspired by SPC-700's audio-specific additions to 6502
- Teaching value: show both levels

**Q: "Does MTMC-16 have these opcodes already?"**
- A: **WE DON'T KNOW** - need MTMC-16 spec to verify
- Current compiler assumes: LI (load imm), SB (store byte), ADD, CMP, BNE
- May need adjustment to match actual MTMC-16 ISA

**Q: "23 new opcodes seems like a lot"**
- A: Can trim to essentials:
  - Memory: POKE, PEEK (2)
  - Bits: SBIT, CBIT (2)
  - Control: PLAY, STOP, TICK (3)
  - Loop: LOOP (1)
  - **Minimum viable: 8 opcodes**

### Teaching

**Q: "What's the first lesson?"**
```asm
POKE $1000, 1    ; kick step 0
POKE $1500, 3    ; play
; DONE - student hears kick every bar
```

**Q: "What's week 1 vs week 8?"**
| Week | Concept | $1010 Feature |
|------|---------|---------------|
| 1 | Memory writes | POKE address, hear sound |
| 2 | Hex/binary | $3C = 60 = 0011 1100 |
| 3 | Bit operations | SBIT/CBIT for steps |
| 4 | Loops | LOOP 16, fill pattern |
| 5 | Syscalls | TICK blocks, crosses boundary |
| 6 | Signed numbers | Detune: 135 = +7 cents |
| 7 | Tuning theory | Why 440Hz? Just intonation |
| 8 | Build a game | Use syscalls for game audio |

**Q: "How does this connect to existing MTMC-16 curriculum?"**
- A: $1010 is an I/O peripheral, not a replacement
- Students write MTMC-16 code that writes to $1010 region
- Same pattern as writing to display memory or GPIO
- Audio gives immediate feedback (more engaging than LED blink)

---

## Potential Pushback

### "This is too complex"

**Response:**
- Core is 180 bytes, 5 voices, 4 control registers
- Compare to SPC-700: 64KB, 8 voices, dozens of DSP regs
- Compare to MIDI: 16 channels, 128 programs, running status
- $1010 is simpler than NES APU

**Simplification options:**
1. Start with 2 voices (kick + lead): 64 bytes
2. Remove packs entirely for first semester
3. Use tweet format only (no assembly)

### "Why not just use Web Audio directly?"

**Response:**
- Web Audio teaches browser API, not CS fundamentals
- $1010 teaches: memory layout, addressing, bit ops, syscalls
- Same concepts apply to embedded, not just web
- Can deploy to real hardware (see below)

### "Students don't care about assembly in 2025"

**Response:**
- They care about games, music, creative coding
- Assembly is the vehicle, audio is the reward
- "POKE $1000, 1" → hear kick is magic
- Understanding memory makes them better at everything

---

## Hardware Integration Path

### Phase 1: WASM + Browser (DONE)
- Works today in 1010sequencer.html
- No hardware needed
- Good for classroom demos

### Phase 2: Raspberry Pi Pico (RP2040)
**Why Pico:**
- $4 microcontroller
- Dual-core ARM Cortex-M0+
- PIO for precise timing
- PWM audio out (or I2S with codec)
- MicroPython or C SDK

**Implementation:**
```c
// memory-mapped audio region
volatile uint8_t* MEM = (volatile uint8_t*)0x20000000;
#define KICK_GATE (MEM + 0x1000)
#define SEQ_CTRL  (MEM + 0x1500)

// student code
KICK_GATE[0] = 1;  // step 0 on
*SEQ_CTRL = 3;     // play + loop
```

**Audio output options:**
1. PWM to speaker (simplest, lo-fi)
2. I2S to PCM5102 DAC ($5, hi-fi)
3. PT8211 DAC ($2, good enough)

**Estimate: 2-3 days to port**

### Phase 3: FPGA (iCE40 / ECP5)

**Why FPGA:**
- True hardware implementation
- Can run at audio sample rate (48kHz)
- Teaches digital design alongside CS
- iCE40 UP5K: $10, open toolchain

**Implementation:**
```verilog
module audio_coprocessor (
    input clk,
    input [15:0] addr,
    input [7:0] data_in,
    input we,
    output [7:0] data_out,
    output [15:0] audio_out
);
    // 1.5KB block RAM for $1000-$15FF
    reg [7:0] mem [0:1535];

    // Sequencer state machine
    reg [3:0] step;
    reg [7:0] tick_counter;

    // ... synthesis logic
endmodule
```

**Challenges:**
- Synthesis algorithms in HDL (not trivial)
- May need soft CPU (PicoRV32) + audio peripheral
- Toolchain learning curve

**Estimate: 2-4 weeks for basic version**

### Phase 4: Custom Chip (ASIC)

**Realistic?** Not for teaching, but fun to consider.

**Options:**
1. **Efabless/Google MPW** - Free shuttle runs, 130nm
2. **TinyTapeout** - Shared die, very limited gates
3. **Commercial fab** - $10K+ for small run

**What would $1010 ASIC look like:**
- 5-voice wavetable synth
- 2KB SRAM for patterns
- Simple sequencer state machine
- I2S output
- SPI/I2C control interface

**Die size estimate:** ~1mm² in 130nm

**Cool but probably overkill for teaching.**

---

## Realistic Next Steps

### Immediate (This Week)
1. ~~Fix WASM backend bug~~ DONE
2. Clarify core vs pack memory map
3. Verify against actual MTMC-16 ISA
4. Create minimal 8-opcode version

### Short Term (Month)
1. Pi Pico port with PWM audio
2. Integration test: MTMC-16 asm → $1010 → audio
3. First lesson plan draft
4. Student feedback from test class

### Medium Term (Semester)
1. iCE40 FPGA version (stretch goal)
2. Full curriculum integration
3. Pack ecosystem (student contributions)
4. Tweet format sharing site

### Long Term (Dream)
1. TinyTapeout submission
2. $1010 badge/board (like Adafruit trinkets)
3. Community of student compositions

---

## Questions for Carson

1. **MTMC-16 ISA**: Can you share instruction set? Need to verify compiler output.

2. **Classroom constraints**: What hardware is available? Picos? FPGAs? Just laptops?

3. **Curriculum position**: Is this CS1? CS2? Elective? Affects complexity budget.

4. **Timeline**: When would you want to pilot this?

5. **Extensions**: Any specific packs that would help teaching? (XEuclidean for algorithms?)

6. **Student projects**: What do students currently build? Games? Could $1010 add audio?

---

## Demo Script

If presenting to Carson:

1. **Open 1010sequencer.html** - show UI, make a beat (30 sec)
2. **Show tweet format** - paste into 1010tweet.html, plays immediately
3. **View memory** - hex dump, show pattern data in raw bytes
4. **Edit in hex** - change $1000 directly, hear result
5. **Show assembly** - POKE instructions, compile to MTMC-16
6. **Discuss**: "What if this ran on real hardware in your lab?"

---

## Files Needing Attention

| File | Issue | Priority |
|------|-------|----------|
| ~~1010compiler.js~~ | ~~WASM backend bug~~ | ~~HIGH~~ FIXED |
| 1010packs.js | Export structure | MEDIUM |
| 1010runtime.wat | Undocumented addresses | LOW |
| README.md | Core vs pack clarity | LOW |
| colundikeys/ | Remove dist/ dupe | LOW |
