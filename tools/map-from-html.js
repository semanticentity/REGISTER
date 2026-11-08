#!/usr/bin/env node
// Drafts a REGISTER memory map for any instrument whose settings are HTML
// controls (range inputs, selects, checkboxes, number inputs).
//
//   node tools/map-from-html.js instrument.html config.json > name-map.json
//
// The config names the machine, its address space, and groups controls into
// packs by id pattern. Each control becomes one typed byte bound to that
// control ("control": {...}), so dom-bridge.js can drive the instrument the
// same way its own UI does. Steps (sequencer tracks) bind to an array.
//
// A byte has 256 steps. A wide frequency range (max / min of 20 or more, with
// min above 0) gets a log curve, so the byte spends its steps evenly by ear.
const fs = require('fs');

const [htmlPath, configPath] = process.argv.slice(2);
if (!htmlPath || !configPath) {
  console.error('usage: node tools/map-from-html.js instrument.html config.json');
  process.exit(1);
}
const html = fs.readFileSync(htmlPath, 'utf8');
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const markup = cfg.markupEnd ? html.slice(0, html.indexOf(cfg.markupEnd)) : html;

const hex = n => '0x' + n.toString(16).toUpperCase().padStart(4, '0');
const attr = (s, k) => { const m = s.match(new RegExp(`\\b${k}="([^"]*)"`)); return m ? m[1] : null; };
const snake = id => id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();

// Every control with an id, its label, and its range or options
const controls = new Map();
for (const m of markup.matchAll(/<(input|select)\b([^>]*)>/g)) {
  const [whole, tag, attrs] = m;
  const id = attr(attrs, 'id');
  if (!id) continue;
  const c = { tag, id, type: attr(attrs, 'type') || (tag === 'select' ? 'select' : 'text') };
  c.min = attr(attrs, 'min'); c.max = attr(attrs, 'max'); c.step = attr(attrs, 'step');
  if (tag === 'select') {
    const end = markup.indexOf('</select>', m.index);
    // An option's value is its value attribute, or its text when it has none
    c.options = [...markup.slice(m.index, end).matchAll(/<option\b([^>]*)>([^<]*)/g)]
      .map(o => { const v = attr(o[1], 'value'); return v !== null ? v : o[2].trim(); });
  }
  // Label: <label for="id">, or the nearest label text before the control
  const lf = markup.match(new RegExp(`<label[^>]*for="${id}"[^>]*>([\\s\\S]*?)</label>`));
  const before = markup.slice(Math.max(0, m.index - 300), m.index);
  const near = [...before.matchAll(/<label[^>]*>([^<]{1,40})<\/label>/g)].pop();
  const raw = lf ? lf[1] : near ? near[1] : '';
  c.label = raw.replace(/<[^>]+>/g, ' ').replace(/[:\s]+$/, '').replace(/\s+/g, ' ').trim();
  controls.set(id, c);
}

// Controls the page creates with JavaScript at startup are not in the markup;
// the config lists them ("extraControls") with the same attributes.
for (const x of cfg.extraControls || []) controls.set(x.id, { tag: x.tag || 'input', type: x.type || 'range', ...x, min: String(x.min), max: String(x.max), step: x.step !== undefined ? String(x.step) : null });

function fieldFor(c, group) {
  const name = snake(c.id);
  if (c.tag === 'select') {
    if (!c.options || !c.options.length) return null;
    return { name, type: 'enum', options: c.options, control: { id: c.id }, about: c.label };
  }
  if (c.type === 'checkbox') return { name, type: 'bits', bits: [c.label || c.id], control: { id: c.id } };
  if (c.type !== 'range' && c.type !== 'number') return null;
  const min = Number(c.min ?? 0), max = Number(c.max ?? 100), step = c.step ? Number(c.step) : 1;
  const control = { id: c.id, min, max, step };
  // Small whole-number ranges store the value itself, no scaling
  if (Number.isInteger(min) && Number.isInteger(max) && step === 1 && min >= 0 && max <= 255) {
    return { name, type: 'u8', min, max, control: { ...control, raw: true }, about: c.label };
  }
  if (min > 0 && max / min >= 20) control.curve = 'log';
  const shown = n => String(+n.toFixed(4));
  if (min < 0 && max > 0 && !control.curve) {
    return { name, type: 'u8', min: 0, max: 255, control, about: c.label, note: `0 = ${shown(min)}, 128 = 0, 255 = ${shown(max)}` };
  }
  return {
    name, type: 'u8', min: 0, max: 255, control,
    about: c.label,
    note: `0-255 = ${shown(min)} to ${shown(max)}${control.curve ? ' (log)' : ''}`
  };
}

const map = {
  spec: `${cfg.name} memory map`,
  name: cfg.name,
  version: 1,
  space: [hex(cfg.space[0]), hex(cfg.space[1])],
  caps_addr: hex(cfg.caps),
  js_name: cfg.jsName,
  generated: `Drafted from ${cfg.source || 'the instrument HTML'} by tools/map-from-html.js; edit freely`,
  check_files: cfg.checkFiles || [],
  rules: [
    'Every setting is a byte bound to the instrument\'s own control. Writing the byte moves the control; moving the control rewrites the byte.',
    'A byte has 256 steps: the control\'s range is spread across them, on a log curve for wide frequency ranges.',
    'Capabilities are declared in CAPS like any REGISTER machine.'
  ],
  caps_bits: {},
  regions: []
};

const used = new Set();
let at = cfg.space[0];
const pad = (to, name) => { if (to > at) { map.regions.push({ start: hex(at), end: hex(to - 1), pack: 'RESERVED', name, about: 'Unassigned' }); at = to; } };

let bit = 0;
cfg.groups.forEach(g => {
  if (!g.caps) map.caps_bits[String(bit++)] = g.pack;
  if (g.at !== undefined) pad(g.at, `RESERVED_${at.toString(16).toUpperCase()}`);
  if (g.caps) {
    pad(cfg.caps, `RESERVED_${at.toString(16).toUpperCase()}`);
    map.regions.push({ start: hex(at), end: hex(at + 3), pack: g.pack, name: 'CAPS', about: 'Read-only, 32-bit little-endian bitmask of implemented packs', fields: [{ name: 'CAPS', type: 'readonly', size: 4 }] });
    map.regions.push({ start: hex(at + 4), end: hex(at + 4), pack: g.pack, name: 'SPEC_VERSION', about: 'Read-only, map version', fields: [{ name: 'SPEC_VERSION', type: 'readonly' }] });
    at += 5;
    return;
  }
  const fields = [];
  if (g.sequences) {
    for (const s of g.sequences) {
      for (let off = 0; off < (s.length || 16); off += 16) {
        fields.push({ name: `${s.name}_STEPS_${off + 1}_${off + 16}`, type: 'steps', of: 'gate', control: { array: s.array, offset: off } });
      }
    }
  }
  for (const sel of g.selectors || []) {
    fields.push({ name: sel.name, type: 'u8', min: sel.min, max: sel.max, control: { selector: sel.selector, min: sel.min, max: sel.max, step: 1, raw: true }, about: sel.about });
  }
  if (g.checkboxes) {
    fields.push({ name: g.checkboxes.name, type: 'bits', bits: g.checkboxes.bits.map(b => b.label), control: { checkboxes: g.checkboxes.bits.map(b => b.selector) }, about: g.checkboxes.about });
  }
  // Literal fields from the config, for state that is not a control
  // (custom bindings handled by an adapter, see dom-bridge.js "custom")
  for (const f of g.fields || []) fields.push({ ...f });
  const re = new RegExp(g.match || '^$');
  for (const [id, c] of controls) {
    if (used.has(id) || !re.test(id) || (cfg.exclude && new RegExp(cfg.exclude).test(id))) continue;
    const f = fieldFor(c, g);
    if (!f) continue;
    used.add(id);
    fields.push(f);
  }
  if (!fields.length) return;
  const size = fields.reduce((n, f) => n + (f.type === 'steps' ? 16 : 1), 0);
  const start = at;
  // One region per field keeps every address self-describing in the console
  for (const f of fields) {
    const n = f.type === 'steps' ? 16 : 1;
    map.regions.push({ start: hex(at), end: hex(at + n - 1), pack: g.pack, name: f.name, about: f.about || g.about || f.name, fields: [Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'about'))] });
    at += n;
  }
  if (g.size) pad(start + g.size, `RESERVED_${(start + size).toString(16).toUpperCase()}`);
});
pad(cfg.space[1] + 1, `RESERVED_${at.toString(16).toUpperCase()}`);

const skipped = [...controls.keys()].filter(id => !used.has(id));
process.stderr.write(`${used.size} controls mapped; not mapped: ${skipped.join(', ')}\n`);
process.stdout.write(JSON.stringify(map, null, 2) + '\n');
