/**
 * REGISTER COMPILER TOOLCHAIN
 *
 * A real compiler that takes the REGISTER DSL and emits:
 * - MTMC-16 assembly (x366)
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

        // '>' is shorthand for @after (Director syntax: "> 2b")
        if (ch === '>') {
          this.advance();
          this.tokens.push({ type: TokenType.DIRECTIVE, value: 'after', line: startLine, col: startCol });
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
    LOOP_MARK: 'LOOP_MARK', // @loop start / @loop end (arranger)
    WAIT: 'WAIT',
    TIME: 'TIME',           // @at 4b / @after 2b (arranger)
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
        // POKE $1000, 1 works here too: POKE is the language everywhere else
        if (tok.value === 'poke') {
          this.advance();
          return this.parsePoke(tok);
        }
        // Could be voice assignment in scene context: kick: pattern_name
        return this.parseVoiceAssign();
      }

      // Skip unknown, but say so: a silently ignored line is a trap
      this.notUnderstood(this.advance());
      return null;
    }

    notUnderstood(tok) {
      this.warnedLines = this.warnedLines || new Set();
      if (!tok || this.warnedLines.has(tok.line)) return;
      this.warnedLines.add(tok.line);
      this.warnings.push({
        line: tok.line, col: tok.col,
        msg: `Line ${tok.line} was skipped: lines start with @ (like @pattern), a voice (kick: four), POKE, or ; for a comment`
      });
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
        case '':      // "@ 4b", the Director's form of @at
        case 'at':
          return this.parseTime(directive, false);
        case 'after':
          return this.parseTime(directive, true);
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

      // Length is checked by the Linter (counts steps, not characters)

      // Parse pattern data
      const steps = this.parsePatternString(data, directive.line);

      return { type: NodeType.PATTERN, name, data, steps, line: directive.line };
    }

    parsePatternString(str, line) {
      const steps = [];
      const noteRegex = /^([A-Ga-g][#b]?)(\d)$/;

      // i walks characters, steps counts output steps (notes like C#4 span several chars)
      for (let i = 0; steps.length < 16; i++) {
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

    // @at 4b, @at 64, @after 2b: a time in bars ("b") or steps
    parseTime(directive, relative) {
      const num = this.expect(TokenType.NUMBER, `Expected a time after @${relative ? 'after' : 'at'} (like 4b or 64)`);
      let steps = num ? num.value : 0;
      if (this.peek().type === TokenType.IDENTIFIER && this.peek().value === 'b') {
        this.advance();
        steps *= 16;
      }
      if (steps < 0 || steps > 0xFFFF) {
        this.errors.push({ line: directive.line, col: directive.col, msg: `Time ${steps} out of range (0-65535 steps)` });
        steps = 0;
      }
      return { type: NodeType.TIME, steps, relative, line: directive.line };
    }

    parseLoop(directive) {
      if (this.peek().type === TokenType.IDENTIFIER && ['start', 'end'].includes(this.peek().value)) {
        return { type: NodeType.LOOP_MARK, mark: this.advance().value, line: directive.line };
      }
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
      this.notUnderstood(voice);
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
      this.assigned = false;
      this.errors = [];
      // Arranger (XSONG). time is null during setup; the first @at/@after
      // starts the timeline, and later commands become timed events.
      this.time = null;
      this.events = [];
      this.bank = [new Array(16).fill(0)]; // slot 0 is silence
      this.loopStart = 0;
      this.played = false;
    }

    generate() {
      for (const node of this.ast.body) {
        if (this.time !== null && this.emitTimed(node)) continue;
        this.emitNode(node);
      }
      if (this.events.length) this.emitSong();
      return this.ir;
    }

    // ---- Arranger ----
    static get SONG() {
      return { POS: 0x1760, CTRL: 0x1762, COUNT: 0x1763, EVENTS: 0x1770, BANK: 0x1800, MAX_EVENTS: 24, MAX_SLOTS: 16 };
    }
    static get VOICE_ORDER() { return ['kick', 'snare', 'lead', 'bass', 'noise']; }

    event(op, a = 0, b = 0, c = 0, line = 0) {
      this.events.push({ step: this.time, op, a, b, c, line });
    }

    bankSlot(steps) {
      const key = steps.join(',');
      let slot = this.bank.findIndex(p => p.join(',') === key);
      if (slot === -1) {
        slot = this.bank.length;
        this.bank.push(steps.slice(0, 16));
      }
      return slot;
    }

    // Returns true if the node was handled as a timed event.
    emitTimed(node) {
      const voiceIndex = v => IRGenerator.VOICE_ORDER.indexOf(v);
      switch (node.type) {
        case NodeType.TIME:
          this.time = node.relative ? this.time + node.steps : node.steps;
          return true;
        case NodeType.WAIT:
          this.time += node.steps;
          return true;
        case NodeType.TEMPO:
          this.event(1, 0x01, 0x15, node.value, node.line);
          return true;
        case NodeType.SWING:
          this.event(1, 0x03, 0x15, node.value, node.line);
          return true;
        case NodeType.POKE:
          this.event(1, node.addr & 0xFF, (node.addr >> 8) & 0xFF, node.value & 0xFF, node.line);
          return true;
        case NodeType.STOP:
          this.event(4, 0, 0, 0, node.line);
          return true;
        case NodeType.LOOP_MARK:
          if (node.mark === 'start') this.loopStart = this.time;
          else this.event(3, this.loopStart & 0xFF, (this.loopStart >> 8) & 0xFF, 0, node.line);
          return true;
        case NodeType.VOICE_ASSIGN: {
          const pattern = this.patterns[node.pattern];
          if (pattern && voiceIndex(node.voice) !== -1) {
            this.event(2, this.bankSlot(pattern.steps), voiceIndex(node.voice), 0, node.line);
          }
          return true;
        }
        case NodeType.PLAY: {
          const scene = node.scene && this.ast.scenes[node.scene];
          if (!scene) return false; // plain @play: start as usual
          // A scene sets every voice: assigned voices get their pattern, the rest go silent
          const assigned = {};
          for (const a of scene.assignments) assigned[a.voice] = a.pattern;
          IRGenerator.VOICE_ORDER.forEach((voice, v) => {
            const pattern = this.patterns[assigned[voice]];
            this.event(2, pattern ? this.bankSlot(pattern.steps) : 0, v, 0, node.line);
          });
          if (!this.played) {
            this.played = true;
            this.emit(IROpcode.WRITE, 0x1500, 0x03);
            this.emit(IROpcode.PLAY);
          }
          return true;
        }
        default:
          return false;
      }
    }

    // Writes the bank, the event table and the arranger registers
    emitSong() {
      const S = IRGenerator.SONG;
      if (this.events.length > S.MAX_EVENTS) {
        this.errors.push({ line: this.events[S.MAX_EVENTS].line, msg: `Too many arranger events (${this.events.length}, max ${S.MAX_EVENTS})` });
        return;
      }
      if (this.bank.length > S.MAX_SLOTS) {
        this.errors.push({ line: 0, msg: `Too many different patterns in the arrangement (${this.bank.length - 1}, max ${S.MAX_SLOTS - 1})` });
        return;
      }
      this.emit(IROpcode.COMMENT, `SONG: ${this.events.length} events, ${this.bank.length - 1} banked patterns`);
      this.bank.forEach((steps, slot) => {
        steps.forEach((v, i) => { if (v) this.emit(IROpcode.WRITE, S.BANK + slot * 16 + i, v); });
      });
      this.events.sort((x, y) => x.step - y.step);
      this.events.forEach((e, i) => {
        const at = S.EVENTS + i * 6;
        [e.step & 0xFF, (e.step >> 8) & 0xFF, e.op, e.a, e.b, e.c].forEach((v, k) => this.emit(IROpcode.WRITE, at + k, v));
      });
      this.emit(IROpcode.WRITE, S.POS, 0);
      this.emit(IROpcode.WRITE, S.POS + 1, 0);
      this.emit(IROpcode.WRITE, S.COUNT, this.events.length);
      this.emit(IROpcode.WRITE, S.CTRL, 1);
      if (!this.played && !this.ir.some(x => x.op === IROpcode.PLAY)) {
        this.emit(IROpcode.WRITE, 0x1500, 0x03);
        this.emit(IROpcode.PLAY);
      }
    }

    emit(opcode, ...args) {
      this.ir.push({ op: opcode, args, line: args.line || 0 });
    }

    emitNode(node) {
      switch (node.type) {
        case NodeType.COMMENT:
          this.emit(IROpcode.COMMENT, node.value);
          break;

        case NodeType.TIME:
          this.time = node.steps;  // the first time marker starts the arranger timeline
          break;

        case NodeType.LOOP_MARK:
          this.time = 0;
          this.emitTimed(node);
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
          // Scenes are definitions; their writes are emitted when played
          break;

        case NodeType.VOICE_ASSIGN:
          this.emitVoiceAssign(node.voice, node.pattern);
          this.assigned = true;
          break;

        case NodeType.PLAY: {
          const scenes = this.ast.scenes || {};
          if (node.scene && scenes[node.scene]) {
            this.emitScene(scenes[node.scene]);
          } else if (!this.assigned) {
            const first = Object.keys(scenes)[0];
            if (first) {
              this.emitScene(scenes[first]);
            } else {
              this.emitImplicitVoices();
            }
          }
          const ctrl = node.loop ? 0x03 : 0x01; // loop + play or just play
          this.emit(IROpcode.WRITE, 0x1500, ctrl); // SEQ_CTRL
          this.emit(IROpcode.PLAY);
          break;
        }

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
      this.assigned = true;
    }

    // No scene and no voice assignments: map patterns named after a voice
    // ("kick" or "p_kick") straight onto that voice.
    emitImplicitVoices() {
      for (const name of Object.keys(this.patterns)) {
        const voice = name.replace(/^p_/, '');
        if (this.voiceBaseAddr(voice) !== null) {
          this.emitVoiceAssign(voice, name);
        }
      }
      this.assigned = true;
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

  // MTMC-16 Assembly Backend (x366)
  //
  // The MTMC-16 teaching computer runs x366, a 16-bit assembly modeled on x86
  // (github.com/msu/mtmc). REGISTER needs no new instructions there. The chip
  // watches memory, so a program plays a song with plain byte stores:
  // MOV [addr], imm. Those are the same POKEs as everywhere else in REGISTER.
  //
  // Layout: the chip sits in RAM at 0x1000-0x1FFF, so the program asks for
  // 16K. Code starts at 0x0020 and must end below 0x1000. The stack starts at
  // the top of memory, well above the chip. Bytes are written in address
  // order and SEQ_CTRL last, so nothing plays until the song is loaded.
  const X366_CORE_NAMES = [
    [0x1000, 'KICK_GATE'], [0x1010, 'KICK_PITCH'], [0x1020, 'SNARE_GATE'], [0x1030, 'SNARE_TONE'],
    [0x1040, 'SNARE_SNAP'], [0x1100, 'LEAD_GATE'], [0x1110, 'LEAD_ARP'], [0x1200, 'BASS_GATE'],
    [0x1210, 'BASS_FM'], [0x1220, 'BASS_FILT'], [0x1300, 'NOISE_GATE'], [0x1310, 'NOISE_DECAY'],
    [0x1320, 'NOISE_TYPE']
  ];
  const X366_REGISTER_NAMES = { 0x1500: 'SEQ_CTRL', 0x1501: 'SEQ_TEMPO', 0x1503: 'SEQ_SWING', 0x1504: 'SEQ_SCENE',
    0x1760: 'SONG_POS', 0x1761: 'SONG_POS hi', 0x1762: 'SONG_CTRL', 0x1763: 'SONG_COUNT' };
  const X366_CODE_LIMIT = 0x1000;

  function x366Name(addr) {
    if (X366_REGISTER_NAMES[addr]) return X366_REGISTER_NAMES[addr];
    for (const [base, name] of X366_CORE_NAMES) {
      if (addr >= base && addr < base + 16) return `${name}[${addr - base}]`;
    }
    if (addr >= 0x1770 && addr < 0x1800) return `SONG_EVENTS+${addr - 0x1770}`;
    if (addr >= 0x1800 && addr < 0x1900) return `SONG_BANK+${addr - 0x1800}`;
    return '';
  }

  // writes: [[addr, value], ...] in program order; the last write to an
  // address wins. Returns { output, error }.
  function toX366(writes, options = {}) {
    const title = String(options.title || 'Untitled').replace(/[\r\n]+/g, ' ');
    const image = new Map();
    for (const [addr, value] of writes) image.set(addr & 0xFFFF, value & 0xFF);
    const ctrl = image.has(0x1500) ? image.get(0x1500) : 0x03;
    image.delete(0x1500);
    // Memory starts at zero, so a zero byte needs no store
    const stores = [...image].filter(([, v]) => v !== 0).sort((a, b) => a[0] - b[0]);

    // MOV [addr], imm is 4 bytes; the ending is one more MOV and a JMP
    const codeEnd = 0x0020 + stores.length * 4 + 4 + 4;
    if (codeEnd > X366_CODE_LIMIT) {
      return { output: null, error: `Song needs ${stores.length} byte stores; x366 code must end below 0x1000, which fits ${Math.floor((X366_CODE_LIMIT - 0x0020 - 8) / 4)}` };
    }

    const hex = n => '0x' + n.toString(16).toUpperCase().padStart(4, '0');
    const store = (addr, v) => {
      const name = x366Name(addr);
      return `    MOV [${hex(addr)}], ${v}`.padEnd(28) + (name ? `; ${name}` : '').trimEnd();
    };
    const notes = (options.notes || []).map(n => `;   ${n}`).join('\n');

    let asm = `; ${title}
; REGISTER song for the MTMC-16 (x366 assembly)
;
; The REGISTER sound chip reads memory at 0x1000-0x1FFF. Writing a byte
; there is the whole interface: no sound instructions, no sound syscalls.
${notes ? notes + '\n' : ''};
; Run it, press quit to stop.

.MEMORY 16K

main:
`;
    for (const [addr, v] of stores) asm += store(addr, v) + '\n';
    asm += `
    ; Start the sequencer last, once the song is in memory
${store(0x1500, ctrl)} (bit 0 play, bit 1 loop)

    ; The chip plays on its own from here
hold:
    JMP hold
`;
    return { output: asm, error: null };
  }

  class MTMC16Backend {
    constructor(ir, options = {}) {
      this.ir = ir;
      this.title = options.title || 'Untitled';
      this.errors = [];
    }

    emit() {
      const writes = this.ir.filter(i => i.op === IROpcode.WRITE).map(i => [i.args[0], i.args[1]]);
      const { output, error } = toX366(writes, { title: this.title });
      if (error) this.errors.push({ line: 0, msg: error });
      return output;
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
;; Generated by REGISTER Compiler
;; Target: WebAssembly

(module
  ;; Memory: 64KB (1 page)
  (memory (export "memory") 1)

  ;; Audio MMIO region: 0x1000-0x1FFF (core 0x1000-0x15FF)

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

  ;; Voice base address lookup table (stored at 0x0F00-0x0F09)
  ;; voice 0=kick($1000), 1=snare($1020), 2=lead($1100), 3=bass($1200), 4=noise($1300)
  (data (i32.const 0x0F00) "\\00\\10")  ;; voice 0: $1000
  (data (i32.const 0x0F02) "\\20\\10")  ;; voice 1: $1020
  (data (i32.const 0x0F04) "\\00\\11")  ;; voice 2: $1100
  (data (i32.const 0x0F06) "\\00\\12")  ;; voice 3: $1200
  (data (i32.const 0x0F08) "\\00\\13")  ;; voice 4: $1300

  ;; Get voice base address from lookup table
  (func $voice_base (param $voice i32) (result i32)
    (i32.load16_u
      (i32.add
        (i32.const 0x0F00)
        (i32.mul (local.get $voice) (i32.const 2))
      )
    )
  )

  ;; Get gate value for voice at step
  (func (export "get_gate") (param $voice i32) (param $step i32) (result i32)
    (i32.load8_u
      (i32.add
        (call $voice_base (local.get $voice))
        (local.get $step)
      )
    )
  )

  ;; Set gate value for voice at step
  (func (export "set_gate") (param $voice i32) (param $step i32) (param $val i32)
    (i32.store8
      (i32.add
        (call $voice_base (local.get $voice))
        (local.get $step)
      )
      (local.get $val)
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
 * Generated by REGISTER Compiler
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
//! Generated by REGISTER Compiler
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
      const mem = new Uint8Array(0x1000); // 0x1000-0x1FFF: core plus packs

      for (const instr of this.ir) {
        if (instr.op === IROpcode.WRITE) {
          const addr = instr.args[0];
          if (addr >= 0x1000 && addr < 0x2000) {
            mem[addr - 0x1000] = instr.args[1];
          }
        }
      }

      // Output as Intel HEX format
      let hex = '';
      for (let addr = 0; addr < 0x1000; addr += 16) {
        const bytes = [];
        let hasData = false;
        for (let i = 0; i < 16 && addr + i < 0x1000; i++) {
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
          const stepCount = (node.data.match(/[A-Ga-g][#b]?\d|./g) || []).length;
          if (stepCount !== 16) {
            this.warnings.push({
              line: node.line,
              msg: `Pattern "${node.name}" has ${stepCount} steps (expected 16)`
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
          // Core is $1000-$15FF; packs extend it to $1FFF (see memory-map.json).
          // A pack address is fine: machines without that pack ignore it.
          if (node.addr < 0x1000 || node.addr >= 0x2000) {
            this.warnings.push({
              line: node.line,
              msg: `Address $${node.addr.toString(16)} outside the REGISTER map ($1000-$1FFF)`
            });
          } else if (node.addr >= 0x15F0 && node.addr <= 0x15F4) {
            this.warnings.push({
              line: node.line,
              msg: `Address $${node.addr.toString(16)} is read-only (CAPS / SPEC_VERSION); the machine sets it`
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
    if (irGen.errors.length) {
      result.errors.push(...irGen.errors.map(e => ({ ...e, phase: 'arranger' })));
      return result;
    }

    // Step 5: Backend
    let backend;
    const titleNode = ast.body.find(n => n.type === NodeType.TITLE);
    const tempoNode = ast.body.find(n => n.type === NodeType.TEMPO);
    const backendOpts = {
      title: options.title || (titleNode && titleNode.value) || 'Untitled',
      tempo: options.tempo || (tempoNode && tempoNode.value) || 120
    };

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
    if (backend.errors && backend.errors.length) {
      result.errors.push(...backend.errors.map(e => ({ ...e, phase: 'backend' })));
      return result;
    }
    result.success = true;

    return result;
  }

  // ============ PUBLIC API ============
  return {
    compile,
    toX366,
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
