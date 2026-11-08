#!/usr/bin/env node
// Runs every test in tests/unit and tests/browser.
//
//   npm test                     everything
//   node tests/run.js unit       only the Node tests (no browser needed)
//   node tests/run.js sounds     only files whose name contains "sounds"
//
// Browser tests serve the repo over http on a free port (some features, like
// the bitcrush worklet, need http) and drive headless Chromium with Playwright.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { tests, helpers, setFile } = require('./lib');

const root = path.join(__dirname, '..');
const filter = process.argv[2] || '';

const files = ['unit', 'browser'].flatMap(dir =>
  fs.readdirSync(path.join(__dirname, dir)).filter(f => f.endsWith('.test.js')).map(f => path.join(dir, f)));
for (const f of files) {
  if (filter && !f.includes(filter)) continue;
  setFile(f);
  require(path.join(__dirname, f));
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.md': 'text/markdown' };
function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(root, rel);
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const needBrowser = tests.some(t => t.browser);
  const env = { root, contexts: [] };
  let server = null;
  if (needBrowser) {
    const { chromium, devices } = require('playwright');
    server = await serve();
    env.url = `http://127.0.0.1:${server.address().port}/`;
    env.browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    env.devices = devices;
  }

  let passed = 0, failed = 0;
  const started = Date.now();
  let lastFile = '';
  for (const t of tests) {
    if (t.file !== lastFile) { console.log(`\n${t.file}`); lastFile = t.file; }
    const h = helpers(t.browser ? env : {});
    try {
      await Promise.race([
        t.fn(h),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 90 s')), 90000))
      ]);
      passed++;
      console.log(`  ok    ${t.name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${t.name}\n        ${String(e.message).split('\n').join('\n        ')}`);
    } finally {
      for (const c of env.contexts.splice(0)) await c.close().catch(() => {});
    }
  }
  if (env.browser) await env.browser.close();
  if (server) server.close();
  console.log(`\n${passed} passed, ${failed} failed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  process.exit(failed ? 1 : 0);
})();
