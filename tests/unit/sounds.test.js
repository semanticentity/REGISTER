// Portable sounds (sounds.js): field names, voice as base address, blocks, skips.
const path = require('path');
const { test } = require('../lib');
const root = path.join(__dirname, '..', '..');
require(path.join(root, 'sounds.js'));
const S = globalThis.RegisterSounds;
const map = require(path.join(root, 'memory-map.json'));

const IDS = { kick: ['kick', 'kick808', 'kick909', 'wave', 'pokey'], snare: ['snare', 'clap', 'rim', 'wave', 'pokey'], lead: ['lead', 'fm', 'sid', 'lpc', 'wave', 'pokey'], bass: ['bass', 'sid', 'lpc', 'wave', 'pokey'], noise: ['noise', 'wave', 'pokey'] };
const eo = v => IDS[v];
const ix = S.buildIndex(map);

function machine() {
  const mem = new Uint8Array(65536);
  const caps = 0xC04003FF;   // what the sequencer declares
  mem[0x15F0] = caps & 255; mem[0x15F1] = (caps >> 8) & 255; mem[0x15F2] = (caps >> 16) & 255; mem[0x15F3] = caps >>> 24;
  mem[0x15F5] = 3;           // CAPS_EXT: XBUS, XPOKEY
  return mem;
}

function leadOnSid() {
  const mem = machine();
  mem[0x115A] = 2;                          // lead engine: sid
  mem.set([10, 40, 128, 60], 0x1068);       // envelope
  mem[0x105C] = 18; mem[0x105D] = 5;        // unison
  mem[0x10B7] = (-20) & 255;                // pan
  mem[0x10A5] = 128 + 7;                    // fine tune +7
  mem[0x1A00] = 1; mem[0x1A04] = 1; mem[0x1A06] = 128 + 7;
  return mem;
}

test('blocks come from the map: what every voice has, and what only some have', t => {
  t.equal([...ix.everyVoice].sort(), ['A', 'D', 'ENGINE', 'FINE_TUNE', 'PAN', 'R', 'S', 'VEL', 'VOL']);
  const chip = slot => Object.values(ix.engineBanks).includes(slot.pack);
  const block2 = v => Object.entries(ix.voiceFields[v]).filter(([g, slot]) => !ix.everyVoice.has(g) && !chip(slot)).map(([g]) => g);
  t.equal(block2('lead'), ['UNISON_SPREAD', 'UNISON_COUNT']);
  t.equal(block2('kick'), ['DECAY', 'SWEEP', 'CLICK', 'SUB']);
  // Block 3 can also be a voice's own channel on a chip: every voice has POKEY settings
  t.equal(Object.entries(ix.voiceFields.noise).filter(([, slot]) => chip(slot)).map(([g]) => g), ['POKEY_POLY', 'POKEY_DIV', 'POKEY_VOL']);
});

test('capture writes names and readable values, ENGINE first', t => {
  const txt = S.capture(ix, leadOnSid(), 'lead', { engineOptions: eo, name: 'Test Lead' });
  const lines = txt.split('\n');
  t.equal(lines[0], 'SOUND Test Lead');
  t.ok(lines.indexOf('ENGINE = sid') < lines.indexOf('A = 10'), 'ENGINE comes first');
  for (const want of ['PAN = -20', 'FINE_TUNE = 7', 'UNISON_SPREAD = 18', 'OSC1_WAVE = saw', 'OSC2_DETUNE = 7']) t.ok(lines.includes(want), want);
});

test('a lead sound lands on bass addresses, engine number remapped', t => {
  const src = leadOnSid();
  const txt = S.capture(ix, src, 'lead', { engineOptions: eo });
  const mem = new Uint8Array(src);
  const r = S.apply(ix, mem, txt, 'bass', { engineOptions: eo });
  t.equal(r.skipped, []);
  t.equal(mem[0x125A], 1, 'bass engine sid is index 1 on bass');
  t.equal([...mem.slice(0x106C, 0x1070)], [10, 40, 128, 60], 'bass envelope');
  t.equal(mem[0x105E], 18, 'bass unison');
  t.equal(mem[0x10B8], (-20) & 255, 'bass pan');
  t.equal(mem[0x10A6], 135, 'bass fine tune');
});

test('on the kick: the basics land, the rest is skipped with reasons, the shared SID patch is untouched', t => {
  const src = leadOnSid();
  const txt = S.capture(ix, src, 'lead', { engineOptions: eo });
  const mem = new Uint8Array(src); mem[0x1A00] = 0;
  const r = S.apply(ix, mem, txt, 'kick', { engineOptions: eo });
  t.equal(mem[0x1060], 10, 'kick attack');
  t.equal(mem[0x10B5], (-20) & 255, 'kick pan');
  t.ok(r.skipped.some(s => s.field === 'ENGINE' && /kick has no sid engine/.test(s.why)), 'engine skipped');
  t.ok(r.skipped.some(s => s.field === 'UNISON_SPREAD' && /lead, bass do/.test(s.why)), 'unison skipped, names who has it');
  t.equal(mem[0x1A00], 0, 'SID bank not written');
  t.ok(/OSC1_WAVE and 15 more/.test(S.summary(r, 'kick')), 'summary groups the bank');
});

test('CAPS decide which packs count: a core-only machine skips PAN', t => {
  const core = new Uint8Array(65536); core[0x15F0] = 1;
  const r = S.resolve(ix, 'SOUND x\nPAN = -10\nA = 5', 'lead', { engineOptions: eo, mem: core });
  t.ok(r.skipped.some(s => s.field === 'PAN' && /no XMIXER/.test(s.why)));
  t.ok(r.skipped.some(s => s.field === 'A' && /no XENV/.test(s.why)));
});

test('CAPS_EXT counts too: a machine without the second word skips POKEY settings', t => {
  const buzz = S.STARTERS.find(x => x.startsWith('SOUND POKEY Buzz Bass'));
  const old = machine(); old[0x15F5] = 0;
  const r = S.resolve(ix, buzz, 'bass', { engineOptions: eo, mem: old });
  t.ok(r.skipped.some(s => s.field === 'POKEY_POLY' && /no XPOKEY/.test(s.why)), 'skipped with a reason');
  const ok = S.resolve(ix, buzz, 'bass', { engineOptions: eo, mem: machine() });
  t.equal(ok.skipped, []);
  t.ok(ok.writes.some(([a, v]) => a === 0x1A59 && v === 2), 'BASS_POKEY_POLY = 4-bit lands at the bass channel');
});

test('bad lines are reported, not guessed', t => {
  const r = S.resolve(ix, 'SOUND x\nA = 300\nPAN = left\nOSC9 = 1\nwhat is this', 'lead', { engineOptions: eo, mem: machine() });
  t.equal(r.skipped.map(s => s.field), ['A', 'PAN', 'OSC9', 'what is this']);
});

test('AS POKES compiles names to one voice\'s addresses', t => {
  const txt = S.capture(ix, leadOnSid(), 'lead', { engineOptions: eo });
  const pk = S.toPokes(ix, txt, 'bass', { engineOptions: eo, mem: machine() });
  t.ok(/POKE \$125A, 1 +; BASS_ENGINE/.test(pk) && /POKE \$105E, 18/.test(pk), pk.slice(0, 300));
});

test('every starter applies cleanly where its fields exist', t => {
  for (const st of S.STARTERS) {
    const r = S.resolve(ix, st, 'lead', { engineOptions: eo, mem: machine() });
    t.equal(r.skipped, [], `${S.parse(st).name} on lead`);
  }
});

test('share links round trip, including non-ASCII text', t => {
  const txt = 'SOUND Pad\nA = 5\n; ¢ and ☺';
  t.equal(S.sharedFromHash('#sound=' + S.encodeShare(txt)), txt);
});

test('preset pokes become portable sounds; per-step bytes are ignored', t => {
  const fp = S.fromPokes(ix, [[0x1058, 1], [0x1054, 120], [0x1055, 100], [0x1010, 32]], { name: 'TR-808', engineOptions: eo });
  t.equal(fp.map(s => s.voice), ['kick', 'snare']);
  t.ok(/ENGINE = kick808/.test(fp[0].text));
  t.ok(/BODY_DECAY = 120/.test(fp[1].text));
});

test('a wave sound carries its 32-byte table as hex and lands on the bass', t => {
  const mem = machine();
  mem[0x115A] = 4;                                   // lead engine: wave
  for (let i = 0; i < 32; i++) mem[0x1A20 + i] = (i * 8) & 255;
  const txt = S.capture(ix, mem, 'lead', { engineOptions: eo });
  t.ok(/WAVE_TABLE = 00 08 10 18/.test(txt), 'table as hex');
  const m2 = machine();
  const r = S.apply(ix, m2, txt, 'bass', { engineOptions: eo });
  t.equal(r.skipped, []);
  t.equal([m2[0x125A], m2[0x1A21], m2[0x1A3F]], [3, 8, 248], 'bass on wave (engine 3), table copied');
  const bad = S.resolve(ix, 'SOUND x\nENGINE = wave\nWAVE_TABLE = 00 11', 'lead', { engineOptions: eo, mem: machine() });
  t.ok(bad.skipped.some(s => s.field === 'WAVE_TABLE' && /32 hex bytes/.test(s.why)), 'a short table is reported');
});
