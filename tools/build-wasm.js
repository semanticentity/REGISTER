#!/usr/bin/env node
// Builds each chip's .wasm from its .wat and embeds it in the pages that use it,
// so those pages work from a plain file:// double-click (fetch is blocked there).
//
//   npm install            (installs wabt from package.json)
//   node tools/build-wasm.js          build and embed
//   node tools/build-wasm.js --check  only check that every .wasm and embedded
//                                     copy matches its .wat (exits 1 if not)
//
// Run it after any change to a .wat file.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

// Each chip: source, output, and the <script id> it is embedded under in each page
const CHIPS = [
  { wat: 'runtime.wat', wasm: 'runtime.wasm', tag: 'wasm-core', pages: ['tweet.html', 'pixel.html'] },
  { wat: 'pixel.wat', wasm: 'pixel.wasm', tag: 'pixel-core', pages: ['pixel.html'] }
];
const END = '</script>';
const check = process.argv.includes('--check');
let stale = [];

let wabtFactory;
try {
  wabtFactory = require('wabt');
} catch (e) {
  console.error('wabt is not installed. Run: npm install');
  process.exit(1);
}

wabtFactory().then(wabt => {
  for (const chip of CHIPS) {
    const mod = wabt.parseWat(chip.wat, fs.readFileSync(path.join(root, chip.wat), 'utf8'));
    mod.validate();
    const { buffer } = mod.toBinary({});
    mod.destroy();
    const b64 = Buffer.from(buffer).toString('base64');
    const begin = `<script id="${chip.tag}" type="application/octet-stream;base64">`;
    if (check) {
      const onDisk = fs.existsSync(path.join(root, chip.wasm)) ? fs.readFileSync(path.join(root, chip.wasm)) : null;
      if (!onDisk || !onDisk.equals(Buffer.from(buffer))) stale.push(`${chip.wasm} does not match ${chip.wat}`);
      for (const page of chip.pages) {
        const html = fs.readFileSync(path.join(root, page), 'utf8');
        const i = html.indexOf(begin);
        const embedded = i < 0 ? null : html.slice(i + begin.length, html.indexOf(END, i + begin.length)).trim();
        if (embedded !== b64) stale.push(`${page}: embedded ${chip.tag} does not match ${chip.wat}`);
      }
      continue;
    }
    fs.writeFileSync(path.join(root, chip.wasm), Buffer.from(buffer));
    console.log(`${chip.wasm}  ${buffer.length} bytes`);

    for (const page of chip.pages) {
      const p = path.join(root, page);
      const html = fs.readFileSync(p, 'utf8');
      const i = html.indexOf(begin);
      if (i < 0) throw new Error(`${page}: <script id="${chip.tag}"> not found`);
      const j = html.indexOf(END, i + begin.length);
      fs.writeFileSync(p, html.slice(0, i + begin.length) + b64 + html.slice(j));
      console.log(`  embedded in ${page}`);
    }
  }
  if (check) {
    stale.forEach(m => console.error(m));
    if (stale.length) { console.error('Run: node tools/build-wasm.js'); process.exit(1); }
    console.log(`wasm ok: ${CHIPS.length} chips match their .wat`);
  }
}).catch(err => {
  console.error('build failed:', err.message);
  process.exit(1);
});
