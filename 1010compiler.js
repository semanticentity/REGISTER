/**
 * $1010 COMPILER TOOLCHAIN
 *
 * A real compiler that takes the $1010 DSL and emits:
 * - MTMC-16 Assembly
 * - WebAssembly Text Format (.wat)
 * - C (for embedded)
 * - Rust (for embedded)
 * - Raw hex (for direct loading)
 *
 * Architecture:
 *   DSL → Lexer → Parser → AST → IR → Backend → Output
 */

const Compiler1010 = (function() {
  'use strict';

  // ============ TOKEN TYPES ============
  const TokenType = {
    DIRECTIVE: 'DIRECTIVE',   // @tempo, @pattern, @play, etc.
    IDENTIFIER: 'IDENTIFIER', // kick, snare, lead, etc.
    STRING: 'STRING',         // "x...x..."
    NUMBER: 'NUMBER',         // 120, 0x1000
    COMMENT: 'COMMENT',       // # or ;
    NEWLINE: 'NEWLINE',
    COLON: 'COLON',
    EOF: 'EOF',
    ERROR: 'ERROR'
  };

  // ============ LEXER ============
  class Lexer {
    constructor(source) {
      this.source = source;
      this.pos = 0;
      this.line = 1;
      this.col = 1;
      this.tokens = [];
      this.errors = [];
    }

    peek(offset = 0) {
      return this.source[this.pos + offset] || '\0';
    }

    advance() {
      const ch = this.peek();
      this.pos++;
      if (ch === '\n') {
        this.line++;
        this.col = 1;
      } else {
        this.col++;
      }
      return ch;
    }

    skipWhitespace() {
      while (this.peek() === ' ' || this.peek() === '\t' || this.peek() === '\r') {
        this.advance();
      }
    }

    readString() {
      const quote = this.advance(); // consume opening quote
      let value = '';
      while (this.peek() !== quote && this.peek() !== '\0' && this.peek() !== '\n') {
        value += this.advance();
      }
      if (this.peek() === quote) {
        this.advance(); // consume closing quote
      } else {
        this.errors.push({ line: this.line, col: this.col, msg: 'Unterminated string' });
      }
      return value;
    }

    readNumber() {
      let value = '';
      // Check for hex
      if (this.peek() === '0' && (this.peek(1) === 'x' || this.peek(1) === 'X')) {
        value += this.advance(); // 0
        value += this.advance(); // x
        while (/[0-9a-fA-F]/.test(this.peek())) {
          value += this.advance();
        }
        return parseInt(value, 16);
      }
      // Check for $ prefix (assembly style hex)
      if (this.peek() === '$') {
        this.advance(); // consume $
        while (/[0-9a-fA-F]/.test(this.peek())) {
          value += this.advance();
        }
        return parseInt(value, 16);
      }
      // Decimal (allow negative)
      if (this.peek() === '-') {
        value += this.advance();
      }
      while (/[0-9]/.test(this.peek())) {
        value += this.advance();
      }
      return parseInt(value, 10);
    }

    readIdentifier() {
      let value = '';
      while (/[a-zA-Z0-9_\-]/.test(this.peek())) {
        value += this.advance();
      }
      return value;
    }

    tokenize() {
      while (this.pos < this.source.length) {
        this.skipWhitespace();
        const ch = this.peek();
        const startLine = this.line;
        const startCol = this.col;

        if (ch === '\0') break;

        // Newline
        if (ch === '\n') {
          this.tokens.push({ type: TokenType.NEWLINE, line: startLine, col: startCol });
          this.advance();
          continue;
        }

        // Comment
        if (ch === '#' || ch === ';') {
          let comment = '';
          this.advance();
          while (this.peek() !== '\n' && this.peek() !== '\0') {
            comment += this.advance();
          }
          this.tokens.push({ type: TokenType.COMMENT, value: comment.trim(), line: startLine, col: startCol });
          continue;
        }

        // Directive
        if (ch === '@') {
          this.advance();
          const name = this.readIdentifier();
          this.tokens.push({ type: TokenType.DIRECTIVE, value: name.toLowerCase(), line: startLine, col: startCol });
          continue;
        }

        // String
        if (ch === '"' || ch === "'") {
          const value = this.readString();
          this.tokens.push({ type: TokenType.STRING, value, line: startLine, col: startCol });
          continue;
        }

        // Number (including hex with $ or 0x prefix, or negative)
        if (/[0-9$]/.test(ch) || (ch === '-' && /[0-9]/.test(this.peek(1)))) {
          const value = this.readNumber();
          this.tokens.push({ type: TokenType.NUMBER, value, line: startLine, col: startCol });
          continue;
        }

        // Colon
        if (ch === ':') {
          this.tokens.push({ type: TokenType.COLON, line: startLine, col: startCol });
          this.advance();
          continue;
        }

        // Identifier
        if (/[a-zA-Z_]/.test(ch)) {
          const value = this.readIdentifier();
          this.tokens.push({ type: TokenType.IDENTIFIER, value: value.toLowerCase(), line: startLine, col: startCol });
          continue;
        }

        // Unknown character - skip
        this.advance();
      }

      this.tokens.push({ type: TokenType.EOF, line: this.line, col: this.col });
      return { tokens: this.tokens, errors: this.errors };
    }
  }

  // ============ AST NODE TYPES ============
  const NodeType = {
    PROGRAM: 'PROGRAM',
    TITLE: 'TITLE',
    TEMPO: 'TEMPO',
    SWING: 'SWING',
    PATTERN: 'PATTERN',
    SCENE: 'SCENE',
    VOICE_ASSIGN: 'VOICE_ASSIGN',
    PLAY: 'PLAY',
    STOP: 'STOP',
    PARAM: 'PARAM',
    POKE: 'POKE',        // Direct memory write
    LOOP: 'LOOP',
    WAIT: 'WAIT',
    COMMENT: 'COMMENT'
  };

  // ============ PARSER ============
  class Parser {
    constructor(tokens) {
      this.tokens = tokens.filter(t => t.type !== TokenType.NEWLINE); // Remove newlines for easier parsing
      this.pos = 0;
      this.errors = [];
      this.warnings = [];
    }

    peek(offset = 0) {
      return this.tokens[this.pos + offset] || { type: TokenType.EOF };
    }

    advance() {
      return this.tokens[this.pos++];
    }

    expect(type, msg) {
      const tok = this.peek();
      if (tok.type !== type) {
        this.errors.push({ line: tok.line, col: tok.col, msg: msg || `Expected ${type}, got ${tok.type}` });
        return null;
      }
      return this.advance();
    }

    parse() {
      const program = { type: NodeType.PROGRAM, body: [], patterns: {}, scenes: {} };

      while (this.peek().type !== TokenType.EOF) {
        const node = this.parseStatement();
        if (node) {
          program.body.push(node);
          // Track patterns and scenes for reference
          if (node.type === NodeType.PATTERN) {
            program.patterns[node.name] = node;
          }
          if (node.type === NodeType.SCENE) {
            program.scenes[node.name] = node;
          }
        }
      }

      return { ast: program, errors: this.errors, warnings: this.warnings };
    }

    parseStatement() {
      const tok = this.peek();

      if (tok.type === TokenType.COMMENT) {
        this.advance();
        return { type: NodeType.COMMENT, value: tok.value, line: tok.line };
      }

      if (tok.type === TokenType.DIRECTIVE) {
        return this.parseDirective();
      }

      if (tok.type === TokenType.IDENTIFIER) {
        // Could be voice assignment in scene context: kick: pattern_name
        return this.parseVoiceAssign();
      }

      // Skip unknown
      this.advance();
      return null;
    }

    parseDirective() {
      const directive = this.advance();
      const name = directive.value;

      switch (name) {
        case 'title':
          return this.parseTitle(directive);
        case 'tempo':
          return this.parseTempo(directive);
        case 'swing':
          return this.parseSwing(directive);
        case 'pattern':
          return this.parsePattern(directive);
        case 'scene':
          return this.parseScene(directive);
        case 'play':
          return this.parsePlay(directive);
        case 'stop':
          return { type: NodeType.STOP, line: directive.line };
        case 'param':
          return this.parseParam(directive);
        case 'poke':
          return this.parsePoke(directive);
        case 'loop':
          return this.parseLoop(directive);
        case 'wait':
          return this.parseWait(directive);
        default:
          this.errors.push({ line: directive.line, col: directive.col, msg: `Unknown directive: @${name}` });
          return null;
      }
    }

    parseTitle(directive) {
      const str = this.expect(TokenType.STRING, 'Expected string after @title');
      return { type: NodeType.TITLE, value: str ? str.value : 'Untitled', line: directive.line };
    }

    parseTempo(directive) {
      const num = this.expect(TokenType.NUMBER, 'Expected number after @tempo');
      const value = num ? num.value : 120;
      if (value < 20 || value > 255) {
        this.warnings.push({ line: directive.line, msg: `Tempo ${value} out of range (20-255)` });
      }
      return { type: NodeType.TEMPO, value: Math.max(20, Math.min(255, value)), line: directive.line };
    }

    parseSwing(directive) {
      const num = this.expect(TokenType.NUMBER, 'Expected number after @swing');
      const value = num ? num.value : 0;
      if (value < 0 || value > 100) {
        this.warnings.push({ line: directive.line, msg: `Swing ${value} out of range (0-100)` });
      }
      return { type: NodeType.SWING, value: Math.max(0, Math.min(100, value)), line: directive.line };
    }

    parsePattern(directive) {
      const nameToken = this.expect(TokenType.IDENTIFIER, 'Expected pattern name');
      const dataToken = this.expect(TokenType.STRING, 'Expected pattern string');

      const name = nameToken ? nameToken.value : 'unnamed';
      const data = dataToken ? dataToken.value : '';

      // Validate pattern length
      if (data.length !== 16 && data.length !== 0) {
        this.warnings.push({ line: directive.line, msg: `Pattern "${name}" has ${data.length} chars (expected 16)` });
      }

      // Parse pattern data
      const steps = this.parsePatternString(data, directive.line);

      return { type: NodeType.PATTERN, name, data, steps, line: directive.line };
    }

    parsePatternString(str, line) {
      const steps = [];
      const noteRegex = /^([A-Ga-g][#b]?)(\d)$/;

      for (let i = 0; i < 16; i++) {
        const ch = str[i] || '.';

        if (ch === '.' || ch === '-') {
          steps.push(0); // Rest
        } else if (ch === 'x' || ch === 'X') {
          steps.push(ch === 'X' ? 127 : 1); // Trigger (X = accent)
        } else if (/[A-Ga-g]/.test(ch)) {
          // Try to parse as note (e.g., C4, D#3)
          let noteStr = ch;
          let j = i + 1;
          while (j < str.length && /[#b0-9]/.test(str[j])) {
            noteStr += str[j];
            j++;
          }
          const match = noteStr.match(noteRegex);
          if (match) {
            const noteName = match[1].toUpperCase();
            const octave = parseInt(match[2]);
            const noteNum = this.noteToMidi(noteName, octave);
            steps.push(noteNum);
            // Skip consumed characters
            i = j - 1;
          } else {
            steps.push(0);
          }
        } else if (/[0-9]/.test(ch)) {
          // Direct numeric value
          steps.push(parseInt(ch));
        } else {
          steps.push(0);
        }
      }

      // Pad to 16 if needed
      while (steps.length < 16) steps.push(0);
      return steps.slice(0, 16);
    }

    noteToMidi(note, octave) {
      const notes = { 'C': 0, 'C#': 1, 'DB': 1, 'D': 2, 'D#': 3, 'EB': 3, 'E': 4, 'F': 5, 'F#': 6, 'GB': 6, 'G': 7, 'G#': 8, 'AB': 8, 'A': 9, 'A#': 10, 'BB': 10, 'B': 11 };
      const n = notes[note.toUpperCase()] || 0;
      return (octave + 1) * 12 + n;
    }

    parseScene(directive) {
      const nameToken = this.expect(TokenType.IDENTIFIER, 'Expected scene name');
      const name = nameToken ? nameToken.value : 'a';
      const assignments = [];

      // Parse voice assignments until next directive or EOF
      while (this.peek().type === TokenType.IDENTIFIER) {
        const voice = this.advance();
        if (this.peek().type === TokenType.COLON) {
          this.advance(); // consume :
          const pattern = this.expect(TokenType.IDENTIFIER, 'Expected pattern name');
          assignments.push({
            voice: voice.value,
            pattern: pattern ? pattern.value : null
          });
        }
      }

      return { type: NodeType.SCENE, name, assignments, line: directive.line };
    }

    parsePlay(directive) {
      let scene = null;
      let loop = false;

      if (this.peek().type === TokenType.IDENTIFIER) {
        scene = this.advance().value;
      }
      if (this.peek().type === TokenType.IDENTIFIER && this.peek().value === 'loop') {
        this.advance();
        loop = true;
      }

      return { type: NodeType.PLAY, scene, loop, line: directive.line };
    }

    parseParam(directive) {
      // @param voice.param value
      const target = this.expect(TokenType.IDENTIFIER, 'Expected param target');
      const value = this.expect(TokenType.NUMBER, 'Expected param value');

      let voice = null, param = null;
      if (target) {
        const parts = target.value.split('.');
        voice = parts[0];
        param = parts[1] || 'gate';
      }

      return { type: NodeType.PARAM, voice, param, value: value ? value.value : 0, line: directive.line };
    }

    parsePoke(directive) {
      // @poke $addr value
      const addr = this.expect(TokenType.NUMBER, 'Expected address');
      const value = this.expect(TokenType.NUMBER, 'Expected value');

      return { type: NodeType.POKE, addr: addr ? addr.value : 0, value: value ? value.value : 0, line: directive.line };
    }

    parseLoop(directive) {
      const count = this.expect(TokenType.NUMBER, 'Expected loop count');
      return { type: NodeType.LOOP, count: count ? count.value : 1, line: directive.line };
    }

    parseWait(directive) {
      const steps = this.expect(TokenType.NUMBER, 'Expected step count');
      return { type: NodeType.WAIT, steps: steps ? steps.value : 16, line: directive.line };
    }

    parseVoiceAssign() {
      const voice = this.advance();
      if (this.peek().type === TokenType.COLON) {
        this.advance();
        const pattern = this.expect(TokenType.IDENTIFIER, 'Expected pattern name');
        return { type: NodeType.VOICE_ASSIGN, voice: voice.value, pattern: pattern ? pattern.value : null, line: voice.line };
      }
      return null;
    }
  }

  // ============ IR (INTERMEDIATE REPRESENTATION) ============
  // Simple bytecode that any backend can consume
  const IROpcode = {
    NOP: 0x00,
    WRITE: 0x01,      // WRITE addr, value
    TEMPO: 0x02,      // TEMPO bpm
    SWING: 0x03,      // SWING percent
    PLAY: 0x04,       // PLAY
    STOP: 0x05,       // STOP
    LOOP: 0x06,       // LOOP count
    ENDLOOP: 0x07,    // ENDLOOP
    WAIT: 0x08,       // WAIT steps
    COPY: 0x09,       // COPY src, dst, len
    COMMENT: 0xFF     // COMMENT (metadata, ignored in execution)
  };

  class IRGenerator {
    constructor(ast) {
      this.ast = ast;
      this.ir = [];
      this.patterns = ast.patterns || {};
    }

    generate() {
      for (const node of this.ast.body) {
        this.emitNode(node);
      }
      return this.ir;
    }

    emit(opcode, ...args) {
      this.ir.push({ op: opcode, args, line: args.line || 0 });
    }

    emitNode(node) {
      switch (node.type) {
        case NodeType.COMMENT:
          this.emit(IROpcode.COMMENT, node.value);
          break;

        case NodeType.TITLE:
          this.emit(IROpcode.COMMENT, `TITLE: ${node.value}`);
          break;

        case NodeType.TEMPO:
          this.emit(IROpcode.TEMPO, node.value);
          this.emit(IROpcode.WRITE, 0x1501, node.value); // SEQ_TEMPO
          break;

        case NodeType.SWING:
          this.emit(IROpcode.SWING, node.value);
          this.emit(IROpcode.WRITE, 0x1503, node.value); // SEQ_SWING
          break;

        case NodeType.PATTERN:
          // Patterns are stored, emitted when used in scene
          break;

        case NodeType.SCENE:
          this.emitScene(node);
          break;

        case NodeType.VOICE_ASSIGN:
          this.emitVoiceAssign(node.voice, node.pattern);
          break;

        case NodeType.PLAY:
          if (node.scene && this.ast.scenes[node.scene]) {
            this.emitScene(this.ast.scenes[node.scene]);
          }
          const ctrl = node.loop ? 0x03 : 0x01; // loop + play or just play
          this.emit(IROpcode.WRITE, 0x1500, ctrl); // SEQ_CTRL
          this.emit(IROpcode.PLAY);
          break;

        case NodeType.STOP:
          this.emit(IROpcode.WRITE, 0x1500, 0x00);
          this.emit(IROpcode.STOP);
          break;

        case NodeType.POKE:
          this.emit(IROpcode.WRITE, node.addr, node.value);
          break;

        case NodeType.WAIT:
          this.emit(IROpcode.WAIT, node.steps);
          break;

        case NodeType.LOOP:
          this.emit(IROpcode.LOOP, node.count);
          break;
      }
    }

    emitScene(scene) {
      this.emit(IROpcode.COMMENT, `SCENE: ${scene.name}`);
      for (const assign of scene.assignments) {
        this.emitVoiceAssign(assign.voice, assign.pattern);
      }
    }

    emitVoiceAssign(voice, patternName) {
      const pattern = this.patterns[patternName];
      if (!pattern) return;

      const baseAddr = this.voiceBaseAddr(voice);
      if (baseAddr === null) return;

      // Emit writes for each step
      for (let i = 0; i < 16; i++) {
        const value = pattern.steps[i] || 0;
        if (value !== 0) {
          this.emit(IROpcode.WRITE, baseAddr + i, value);
        }
      }
    }

    voiceBaseAddr(voice) {
      const addrs = {
        kick: 0x1000,
        snare: 0x1020,
        lead: 0x1100,
        bass: 0x1200,
        noise: 0x1300
      };
      return addrs[voice] || null;
    }
  }

  // ============ BACKENDS ============

  // MTMC-16 Assembly Backend
  class MTMC16Backend {
    constructor(ir, options = {}) {
      this.ir = ir;
      this.title = options.title || 'Untitled';
      this.tempo = options.tempo || 120;
    }

    emit() {
      let asm = `; ${this.title}
; Generated by $1010 Compiler
; Target: MTMC-16

.data
  ; Pattern data will be embedded inline

.text
main:
  jal audio_init
  jal load_patterns
  jal seq_start

main_loop:
  sys joystick
  mov t0 rv
  andi t0 1
  jz main_loop
  jal seq_stop
  sys exit

audio_init:
`;

      // Emit tempo/swing
      for (const instr of this.ir) {
        if (instr.op === IROpcode.TEMPO) {
          asm += `  li t0 ${instr.args[0]}\n`;
          asm += `  sb t0 $1501          ; SEQ_TEMPO\n`;
        }
        if (instr.op === IROpcode.SWING) {
          asm += `  li t0 ${instr.args[0]}\n`;
          asm += `  sb t0 $1503          ; SEQ_SWING\n`;
        }
      }
      asm += `  ret\n\n`;

      // Emit pattern loads
      asm += `load_patterns:\n`;
      for (const instr of this.ir) {
        if (instr.op === IROpcode.WRITE && instr.args[0] >= 0x1000 && instr.args[0] < 0x1600) {
          const addr = instr.args[0];
          const val = instr.args[1];
          asm += `  li t0 ${val}\n`;
          asm += `  sb t0 $${addr.toString(16).toUpperCase()}`;
          asm += `          ; ${this.addrComment(addr)}\n`;
        }
      }
      asm += `  ret\n\n`;

      asm += `seq_start:
  li t0 3              ; loop=1, play=1
  sb t0 $1500          ; SEQ_CTRL
  ret

seq_stop:
  li t0 0
  sb t0 $1500
  ret
`;

      return asm;
    }

    addrComment(addr) {
      if (addr >= 0x1000 && addr < 0x1020) return `KICK[${addr - 0x1000}]`;
      if (addr >= 0x1020 && addr < 0x1050) return `SNARE[${addr - 0x1020}]`;
      if (addr >= 0x1100 && addr < 0x1120) return `LEAD[${addr - 0x1100}]`;
      if (addr >= 0x1200 && addr < 0x1230) return `BASS[${addr - 0x1200}]`;
      if (addr >= 0x1300 && addr < 0x1330) return `NOISE[${addr - 0x1300}]`;
      if (addr === 0x1500) return 'SEQ_CTRL';
      if (addr === 0x1501) return 'SEQ_TEMPO';
      if (addr === 0x1503) return 'SEQ_SWING';
      return '';
    }
  }

  // WebAssembly Text Format Backend
  class WASMBackend {
    constructor(ir, options = {}) {
      this.ir = ir;
      this.title = options.title || 'Untitled';
    }

    emit() {
      let wat = `;; ${this.title}
;; Generated by $1010 Compiler
;; Target: WebAssembly

(module
  ;; Memory: 64KB (1 page)
  (memory (export "memory") 1)

  ;; Audio MMIO region: 0x1000-0x15FF

  ;; Initialize audio memory
  (func (export "init")
`;

      // Emit all writes
      for (const instr of this.ir) {
        if (instr.op === IROpcode.WRITE) {
          wat += `    (i32.store8 (i32.const ${instr.args[0]}) (i32.const ${instr.args[1]}))\n`;
        }
      }

      wat += `  )

  ;; Read byte from audio memory
  (func (export "read") (param $addr i32) (result i32)
    (i32.load8_u (local.get $addr))
  )

  ;; Write byte to audio memory
  (func (export "write") (param $addr i32) (param $val i32)
    (i32.store8 (local.get $addr) (local.get $val))
  )

  ;; Get sequencer control
  (func (export "get_ctrl") (result i32)
    (i32.load8_u (i32.const 0x1500))
  )

  ;; Get tempo
  (func (export "get_tempo") (result i32)
    (i32.load8_u (i32.const 0x1501))
  )

  ;; Get current step
  (func (export "get_step") (result i32)
    (i32.load8_u (i32.const 0x1502))
  )

  ;; Set current step
  (func (export "set_step") (param $step i32)
    (i32.store8 (i32.const 0x1502) (local.get $step))
  )

  ;; Get gate value for voice at step
  (func (export "get_gate") (param $voice i32) (param $step i32) (result i32)
    (i32.load8_u
      (i32.add
        (i32.add
          (i32.const 0x1000)
          (i32.mul (local.get $voice) (i32.const 0x100))
        )
        (local.get $step)
      )
    )
  )
)
`;

      return wat;
    }
  }

  // C Backend (for embedded)
  class CBackend {
    constructor(ir, options = {}) {
      this.ir = ir;
      this.title = options.title || 'Untitled';
    }

    emit() {
      let c = `/**
 * ${this.title}
 * Generated by $1010 Compiler
 * Target: C (embedded)
 */

#include <stdint.h>

// Audio MMIO base address (adjust for your platform)
#define AUDIO_BASE 0x1000

// Memory-mapped registers
#define KICK_GATE    ((volatile uint8_t*)(AUDIO_BASE + 0x000))
#define KICK_PITCH   ((volatile uint8_t*)(AUDIO_BASE + 0x010))
#define SNARE_GATE   ((volatile uint8_t*)(AUDIO_BASE + 0x020))
#define SNARE_TONE   ((volatile uint8_t*)(AUDIO_BASE + 0x030))
#define SNARE_SNAP   ((volatile uint8_t*)(AUDIO_BASE + 0x040))
#define LEAD_GATE    ((volatile uint8_t*)(AUDIO_BASE + 0x100))
#define LEAD_ARP     ((volatile uint8_t*)(AUDIO_BASE + 0x110))
#define BASS_GATE    ((volatile uint8_t*)(AUDIO_BASE + 0x200))
#define BASS_FM      ((volatile uint8_t*)(AUDIO_BASE + 0x210))
#define BASS_FILT    ((volatile uint8_t*)(AUDIO_BASE + 0x220))
#define NOISE_GATE   ((volatile uint8_t*)(AUDIO_BASE + 0x300))
#define NOISE_DECAY  ((volatile uint8_t*)(AUDIO_BASE + 0x310))
#define NOISE_TYPE   ((volatile uint8_t*)(AUDIO_BASE + 0x320))
#define SEQ_CTRL     ((volatile uint8_t*)(AUDIO_BASE + 0x500))
#define SEQ_TEMPO    ((volatile uint8_t*)(AUDIO_BASE + 0x501))
#define SEQ_STEP     ((volatile uint8_t*)(AUDIO_BASE + 0x502))
#define SEQ_SWING    ((volatile uint8_t*)(AUDIO_BASE + 0x503))

void audio_init(void) {
`;

      // Group writes by address region
      const writes = this.ir.filter(i => i.op === IROpcode.WRITE);

      for (const instr of writes) {
        const addr = instr.args[0];
        const val = instr.args[1];
        c += `    *((volatile uint8_t*)0x${addr.toString(16)}) = ${val};\n`;
      }

      c += `}

void seq_start(void) {
    *SEQ_CTRL = 0x03;  // loop + play
}

void seq_stop(void) {
    *SEQ_CTRL = 0x00;
}

// Call this from your main loop or timer ISR
void seq_tick(void) {
    uint8_t step = *SEQ_STEP;

    // Trigger voices based on gate values
    // (Implement your synthesis here)

    // Advance step
    *SEQ_STEP = (step + 1) & 0x0F;
}
`;

      return c;
    }
  }

  // Rust Backend (for embedded)
  class RustBackend {
    constructor(ir, options = {}) {
      this.ir = ir;
      this.title = options.title || 'Untitled';
    }

    emit() {
      let rs = `//! ${this.title}
//! Generated by $1010 Compiler
//! Target: Rust (embedded, no_std)

#![no_std]

/// Audio MMIO base address
const AUDIO_BASE: usize = 0x1000;

/// Voice gate addresses
const KICK_GATE: usize = AUDIO_BASE + 0x000;
const SNARE_GATE: usize = AUDIO_BASE + 0x020;
const LEAD_GATE: usize = AUDIO_BASE + 0x100;
const BASS_GATE: usize = AUDIO_BASE + 0x200;
const NOISE_GATE: usize = AUDIO_BASE + 0x300;

/// Sequencer control registers
const SEQ_CTRL: usize = AUDIO_BASE + 0x500;
const SEQ_TEMPO: usize = AUDIO_BASE + 0x501;
const SEQ_STEP: usize = AUDIO_BASE + 0x502;

/// Write to MMIO
#[inline(always)]
unsafe fn mmio_write(addr: usize, val: u8) {
    core::ptr::write_volatile(addr as *mut u8, val);
}

/// Read from MMIO
#[inline(always)]
unsafe fn mmio_read(addr: usize) -> u8 {
    core::ptr::read_volatile(addr as *const u8)
}

/// Initialize audio patterns
pub fn audio_init() {
    unsafe {
`;

      const writes = this.ir.filter(i => i.op === IROpcode.WRITE);
      for (const instr of writes) {
        rs += `        mmio_write(0x${instr.args[0].toString(16)}, ${instr.args[1]});\n`;
      }

      rs += `    }
}

/// Start sequencer (loop mode)
pub fn seq_start() {
    unsafe { mmio_write(SEQ_CTRL, 0x03); }
}

/// Stop sequencer
pub fn seq_stop() {
    unsafe { mmio_write(SEQ_CTRL, 0x00); }
}

/// Advance sequencer (call from timer ISR)
pub fn seq_tick() {
    unsafe {
        let step = mmio_read(SEQ_STEP);
        // Trigger voices based on gate values here
        mmio_write(SEQ_STEP, (step + 1) & 0x0F);
    }
}
`;

      return rs;
    }
  }

  // Raw Hex Backend (for direct loading)
  class HexBackend {
    constructor(ir, options = {}) {
      this.ir = ir;
    }

    emit() {
      const mem = new Uint8Array(0x600); // 0x1000-0x15FF

      for (const instr of this.ir) {
        if (instr.op === IROpcode.WRITE) {
          const addr = instr.args[0];
          if (addr >= 0x1000 && addr < 0x1600) {
            mem[addr - 0x1000] = instr.args[1];
          }
        }
      }

      // Output as Intel HEX format
      let hex = '';
      for (let addr = 0; addr < 0x600; addr += 16) {
        const bytes = [];
        let hasData = false;
        for (let i = 0; i < 16 && addr + i < 0x600; i++) {
          bytes.push(mem[addr + i]);
          if (mem[addr + i] !== 0) hasData = true;
        }
        if (hasData) {
          const realAddr = 0x1000 + addr;
          let line = `:${bytes.length.toString(16).padStart(2, '0')}`;
          line += realAddr.toString(16).padStart(4, '0');
          line += '00'; // Record type: data
          let checksum = bytes.length + (realAddr >> 8) + (realAddr & 0xFF);
          for (const b of bytes) {
            line += b.toString(16).padStart(2, '0');
            checksum += b;
          }
          checksum = ((~checksum) + 1) & 0xFF;
          line += checksum.toString(16).padStart(2, '0');
          hex += line.toUpperCase() + '\n';
        }
      }
      hex += ':00000001FF\n'; // EOF record

      return hex;
    }
  }

  // ============ LINTER ============
  class Linter {
    constructor(ast) {
      this.ast = ast;
      this.errors = [];
      this.warnings = [];
    }

    lint() {
      // Check for undefined patterns
      const definedPatterns = new Set(Object.keys(this.ast.patterns));

      for (const node of this.ast.body) {
        if (node.type === NodeType.SCENE) {
          for (const assign of node.assignments) {
            if (assign.pattern && !definedPatterns.has(assign.pattern)) {
              this.errors.push({
                line: node.line,
                msg: `Undefined pattern: ${assign.pattern}`
              });
            }
          }
        }

        if (node.type === NodeType.VOICE_ASSIGN) {
          if (node.pattern && !definedPatterns.has(node.pattern)) {
            this.errors.push({
              line: node.line,
              msg: `Undefined pattern: ${node.pattern}`
            });
          }
        }

        // Check voice names
        if (node.type === NodeType.VOICE_ASSIGN || node.type === NodeType.PARAM) {
          const validVoices = ['kick', 'snare', 'lead', 'bass', 'noise'];
          if (node.voice && !validVoices.includes(node.voice)) {
            this.warnings.push({
              line: node.line,
              msg: `Unknown voice: ${node.voice}`
            });
          }
        }

        // Check pattern lengths
        if (node.type === NodeType.PATTERN) {
          if (node.data.length !== 16) {
            this.warnings.push({
              line: node.line,
              msg: `Pattern "${node.name}" has ${node.data.length} chars (expected 16)`
            });
          }
        }

        // Check tempo range
        if (node.type === NodeType.TEMPO) {
          if (node.value < 20 || node.value > 255) {
            this.errors.push({
              line: node.line,
              msg: `Tempo ${node.value} out of range (20-255)`
            });
          }
        }

        // Check poke addresses
        if (node.type === NodeType.POKE) {
          if (node.addr < 0x1000 || node.addr >= 0x1600) {
            this.warnings.push({
              line: node.line,
              msg: `Address $${node.addr.toString(16)} outside audio region ($1000-$15FF)`
            });
          }
          if (node.value < 0 || node.value > 255) {
            this.errors.push({
              line: node.line,
              msg: `Value ${node.value} out of byte range (0-255)`
            });
          }
        }
      }

      return { errors: this.errors, warnings: this.warnings };
    }
  }

  // ============ MAIN COMPILER API ============
  function compile(source, options = {}) {
    const target = options.target || 'mtmc16';
    const result = {
      success: false,
      output: null,
      errors: [],
      warnings: [],
      ast: null,
      ir: null
    };

    // Step 1: Lexer
    const lexer = new Lexer(source);
    const { tokens, errors: lexErrors } = lexer.tokenize();
    result.errors.push(...lexErrors.map(e => ({ ...e, phase: 'lexer' })));

    if (lexErrors.length > 0) {
      return result;
    }

    // Step 2: Parser
    const parser = new Parser(tokens);
    const { ast, errors: parseErrors, warnings: parseWarnings } = parser.parse();
    result.ast = ast;
    result.errors.push(...parseErrors.map(e => ({ ...e, phase: 'parser' })));
    result.warnings.push(...parseWarnings.map(w => ({ ...w, phase: 'parser' })));

    if (parseErrors.length > 0) {
      return result;
    }

    // Step 3: Linter
    const linter = new Linter(ast);
    const { errors: lintErrors, warnings: lintWarnings } = linter.lint();
    result.errors.push(...lintErrors.map(e => ({ ...e, phase: 'linter' })));
    result.warnings.push(...lintWarnings.map(w => ({ ...w, phase: 'linter' })));

    if (lintErrors.length > 0) {
      return result;
    }

    // Step 4: IR Generation
    const irGen = new IRGenerator(ast);
    const ir = irGen.generate();
    result.ir = ir;

    // Step 5: Backend
    let backend;
    const backendOpts = { title: options.title || 'Untitled', tempo: options.tempo || 120 };

    switch (target) {
      case 'mtmc16':
      case 'asm':
        backend = new MTMC16Backend(ir, backendOpts);
        break;
      case 'wasm':
      case 'wat':
        backend = new WASMBackend(ir, backendOpts);
        break;
      case 'c':
        backend = new CBackend(ir, backendOpts);
        break;
      case 'rust':
      case 'rs':
        backend = new RustBackend(ir, backendOpts);
        break;
      case 'hex':
        backend = new HexBackend(ir, backendOpts);
        break;
      default:
        result.errors.push({ phase: 'backend', msg: `Unknown target: ${target}` });
        return result;
    }

    result.output = backend.emit();
    result.success = true;

    return result;
  }

  // ============ PUBLIC API ============
  return {
    compile,
    Lexer,
    Parser,
    Linter,
    IRGenerator,
    backends: {
      MTMC16: MTMC16Backend,
      WASM: WASMBackend,
      C: CBackend,
      Rust: RustBackend,
      Hex: HexBackend
    },
    TokenType,
    NodeType,
    IROpcode
  };

})();

// Export for Node.js / ES modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Compiler1010;
}
