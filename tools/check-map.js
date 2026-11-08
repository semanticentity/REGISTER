#!/usr/bin/env node
// Checks typed memory maps and every file that uses them.
//
//   node tools/check-map.js            check every *-map.json in the repo root
//   node tools/check-map.js --write    also regenerate each map's .js copy
//
// For each map:
// 1. Regions in order, no overlaps, no gaps across the map's whole space.
// 2. Typed fields add up to exactly their region's size; every pack has a CAPS bit
//    (bits 32-63 live in the second CAPS word at caps_ext_addr).
// 3. The generated .js copy (for pages opened from disk) matches the JSON.
// 2b. Packs with no defined bytes are marked planned.
// 4. Every address in the map's space mentioned by its check_files lands in an
//    assigned region, not RESERVED space.
// Exits 1 on any problem so it can gate a commit or CI run.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const write = process.argv.includes('--write');
const mapFiles = fs.readdirSync(root).filter(f => f === 'memory-map.json' || f.endsWith('-map.json')).sort();

const ONE_BYTE = new Set(['u8', 's8', 'enum', 'engine', 'cents128', 'bits']);
const fieldSize = f => {
  if (ONE_BYTE.has(f.type)) return 1;
  if (f.type === 'u16') return 2;
  if (f.type === 'steps') return 16;
  if (f.type === 'readonly' || f.type === 'table') return f.size || 1;
  return null;
};

let failed = false;

for (const file of mapFiles) {
  const problems = [];
  const map = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  for (const key of ['name', 'space', 'caps_addr', 'js_name', 'caps_bits', 'regions']) {
    if (!(key in map)) problems.push(`missing "${key}"`);
  }
  if (problems.length) { report(file, problems); continue; }

  const lo = parseInt(map.space[0], 16), hi = parseInt(map.space[1], 16);
  const regions = map.regions.map(r => ({ ...r, s: parseInt(r.start, 16), e: parseInt(r.end, 16) }));

  // 1. Shape
  let expect = lo;
  for (const r of regions) {
    if (r.e < r.s) problems.push(`${r.name}: end before start`);
    if (r.s < expect) problems.push(`${r.name} at ${r.start} overlaps the region before it`);
    if (r.s > expect) problems.push(`gap from $${expect.toString(16).toUpperCase()} to ${r.start}`);
    expect = r.e + 1;
  }
  if (expect !== hi + 1) problems.push(`map ends at $${(expect - 1).toString(16).toUpperCase()}, expected ${map.space[1]}`);
  const names = new Set();
  for (const r of regions) {
    if (names.has(r.name)) problems.push(`duplicate region name ${r.name}`);
    names.add(r.name);
  }
  const capsAddr = parseInt(map.caps_addr, 16);
  const capsRegion = regions.find(r => capsAddr >= r.s && capsAddr <= r.e);
  if (!capsRegion || capsRegion.s !== capsAddr || capsRegion.e - capsRegion.s !== 3) {
    problems.push(`caps_addr ${map.caps_addr} must start a 4-byte region`);
  }
  // A second CAPS word holds bits 32-63, like an extended CPUID leaf
  const extAddr = map.caps_ext_addr ? parseInt(map.caps_ext_addr, 16) : null;
  if (extAddr !== null) {
    const extRegion = regions.find(r => extAddr >= r.s && extAddr <= r.e);
    if (!extRegion || extRegion.s !== extAddr || extRegion.e - extRegion.s !== 3) problems.push(`caps_ext_addr ${map.caps_ext_addr} must start a 4-byte region`);
  }
  for (const bit of Object.keys(map.caps_bits)) {
    const n = Number(bit);
    if (!Number.isInteger(n) || n < 0 || n > 63) problems.push(`caps bit ${bit} is not 0-63`);
    else if (n > 31 && extAddr === null) problems.push(`caps bit ${bit} needs caps_ext_addr`);
  }

  // 2. Types and CAPS bits
  const packsWithBits = new Set(Object.values(map.caps_bits));
  for (const r of regions) {
    if (!['RESERVED', 'USER'].includes(r.pack) && !packsWithBits.has(r.pack)) {
      problems.push(`${r.name}: pack ${r.pack} has no CAPS bit`);
    }
    if (!r.fields) continue;
    let total = 0;
    for (const f of r.fields) {
      const size = fieldSize(f);
      if (size === null) { problems.push(`${r.name}.${f.name}: unknown type "${f.type}"`); continue; }
      if (f.type === 'enum' && !(Array.isArray(f.options) && f.options.length)) problems.push(`${r.name}.${f.name}: enum needs options`);
      if (f.type === 'bits' && !(Array.isArray(f.bits) && f.bits.length && f.bits.length <= 8)) problems.push(`${r.name}.${f.name}: bits needs 1-8 names`);
      if ('min' in f && 'max' in f && f.min > f.max) problems.push(`${r.name}.${f.name}: min above max`);
      total += size;
    }
    if (total !== r.e - r.s + 1) problems.push(`${r.name}: fields cover ${total} bytes, region is ${r.e - r.s + 1}`);
  }

  // 2b. Every region either defines its bytes, is reserved or user space, is
  // spare room inside a pack that defines bytes elsewhere, or says it is planned.
  // A planned pack defines no bytes, so no machine can honestly claim it in CAPS.
  const definedPacks = new Set(regions.filter(r => r.fields).map(r => r.pack));
  for (const r of regions) {
    if (r.fields || ['RESERVED', 'USER'].includes(r.pack)) continue;
    if (r.status === 'planned') {
      if (definedPacks.has(r.pack)) problems.push(`${r.name}: pack ${r.pack} defines bytes elsewhere, so it is not planned`);
      continue;
    }
    if (!definedPacks.has(r.pack)) problems.push(`${r.name}: pack ${r.pack} defines no bytes; mark it "status": "planned"`);
  }

  // 3. Generated copy
  const jsFile = file.replace(/\.json$/, '.js');
  const generated = `// Generated from ${file} by tools/check-map.js --write. Do not edit.\n` +
    `window.${map.js_name} = ${JSON.stringify(map)};\n`;
  if (write) {
    fs.writeFileSync(path.join(root, jsFile), generated);
  } else if (!fs.existsSync(path.join(root, jsFile)) || fs.readFileSync(path.join(root, jsFile), 'utf8') !== generated) {
    problems.push(`${jsFile} is out of date: run node tools/check-map.js --write`);
  }

  // 4. Addresses used in code and docs
  const find = a => regions.find(r => a >= r.s && a <= r.e);
  const re = /(?:0x|\$)([0-9A-Fa-f]{4})\b/g;
  let refs = 0;
  for (const f of map.check_files || []) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) { problems.push(`missing file ${f}`); continue; }
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(re)) {
        const a = parseInt(m[1], 16);
        if (a < lo || a > hi) continue;
        // The end of a written range ("$1000-$15FF", "0x1000, 0x1400") is a bound, not a use
        const before = line.slice(Math.max(0, m.index - 4), m.index);
        if (/[-–]\s*$|\.\.\s*$|,\s*$/.test(before) && /(?:0x|\$)[0-9A-Fa-f]{4}/.test(line.slice(Math.max(0, m.index - 14), m.index))) continue;
        refs++;
        const r = find(a);
        if (r && r.pack === 'RESERVED') problems.push(`${f}:${i + 1} $${m[1].toUpperCase()} is in unassigned space (${r.name})`);
      }
    });
  }

  report(file, problems, `${regions.length} regions, ${refs} address references checked${write ? `, wrote ${jsFile}` : ''}`);
}

function report(file, problems, ok) {
  if (problems.length) {
    failed = true;
    console.error(`${file}: ${problems.length} problem(s)`);
    for (const p of problems) console.error('  ' + p);
  } else {
    console.log(`${file}: ok (${ok})`);
  }
}

process.exit(failed ? 1 : 0);
