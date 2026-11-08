// Tiny test harness: no framework, so a student can read all of it.
//   test('name', async (t) => { t.ok(cond, 'what'); t.equal(a, b, 'what'); })
// Browser tests get t.page(path, opts) for a fresh page on the local server.
const assert = require('assert');

const tests = [];
function test(name, fn, opts = {}) { tests.push({ name, fn, browser: !!opts.browser, file: currentFile }); }
let currentFile = '';
function setFile(f) { currentFile = f; }

function helpers(env) {
  const t = {
    ok(cond, msg) { if (!cond) throw new assert.AssertionError({ message: msg || 'expected true' }); },
    equal(a, b, msg) { assert.deepStrictEqual(a, b, msg); },
    near(a, b, tol, msg) {
      if (!(Math.abs(a - b) <= tol)) throw new assert.AssertionError({ message: `${msg || 'near'}: ${a} is not within ${tol} of ${b}` });
    },
    below(a, b, msg) { if (!(a < b)) throw new assert.AssertionError({ message: `${msg || 'below'}: ${a} is not below ${b}` }); },
    above(a, b, msg) { if (!(a > b)) throw new assert.AssertionError({ message: `${msg || 'above'}: ${a} is not above ${b}` }); }
  };
  if (env.browser) {
    // A fresh page. Counts oscillators so a test can tell a voice made sound.
    t.page = async (path, opts = {}) => {
      const ctx = await env.browser.newContext(opts.device ? { ...env.devices[opts.device] } : {});
      env.contexts.push(ctx);
      const page = await ctx.newPage();
      page.errors = [];
      page.on('pageerror', e => page.errors.push(e.message));
      await page.addInitScript(() => {
        const Real = window.AudioContext;
        window.__osc = 0;
        window.AudioContext = class extends Real {
          constructor(...a) {
            super(...a);
            const make = this.createOscillator.bind(this);
            this.createOscillator = (...x) => { window.__osc++; return make(...x); };
          }
        };
      });
      const base = opts.file ? 'file://' + env.root + '/' : env.url;
      await page.goto(base + path);
      await page.waitForTimeout(opts.wait || 900);
      return page;
    };
  }
  return t;
}

module.exports = { test, tests, helpers, setFile };
