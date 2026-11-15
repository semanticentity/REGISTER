// Every term is defined where it is first used, links out, and is recapped.
// The rules are in docs/PEDAGOGY.md; the terms are in glossary.json.
const fs = require('fs');
const path = require('path');
const { test } = require('../lib');
const root = path.join(__dirname, '..', '..');

const { terms } = JSON.parse(fs.readFileSync(path.join(root, 'glossary.json'), 'utf8'));
const lessonFile = n => path.join(root, `lesson${n}.html`);
const lessons = [];
for (let n = 1; fs.existsSync(lessonFile(n)); n++) lessons.push(n);
const taught = [...new Set(terms.map(t => t.lesson))];

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The term or an alias, plural or not, as a whole word
const wordsFor = t => new RegExp(`\\b(${[t.term, ...t.aliases].map(escape).join('|')})(s|es)?\\b`, 'i');

// The body a learner reads, as one string the same length as the HTML: tags,
// the head, scripts, headings and the objectives box are blanked out, so an
// index in it is an index in the HTML.
function readable(html) {
  const blank = m => m.replace(/[^\n]/g, ' ');
  return html
    .replace(/<head>[\s\S]*?<\/head>/, blank)
    .replace(/<script[\s\S]*?<\/script>/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<h([1-6])[^>]*>[\s\S]*?<\/h\1>/g, blank)
    .replace(/<aside[^>]*data-terms-ok[^>]*>[\s\S]*?<\/aside>/g, blank)
    .replace(/<[^>]+>/g, blank);
}

const html = {};
for (const n of lessons) html[n] = fs.readFileSync(lessonFile(n), 'utf8');

test('every term in the glossary is complete and links somewhere real', t => {
  for (const term of terms) {
    t.ok(term.term && term.define && Number.isInteger(term.lesson), `${term.term}: needs term, define and lesson`);
    t.ok(['music', 'computer'].includes(term.kind), `${term.term}: kind is music or computer`);
    t.ok(/^https:\/\/\S+$/.test(term.more), `${term.term}: a "more" link`);
    t.ok(lessons.includes(term.lesson), `${term.term}: lesson ${term.lesson} exists`);
  }
  t.equal(new Set(terms.map(x => x.term.toLowerCase())).size, terms.length, 'no term is listed twice');
});

for (const n of taught) {
  const page = html[n];
  const text = readable(page);
  const mine = terms.filter(x => x.lesson === n);

  test(`lesson ${n}: each term is defined where it is first used, and links out`, t => {
    for (const term of mine) {
      const at = page.indexOf(`<dfn data-term="${term.term}">`);
      t.ok(at >= 0, `"${term.term}" has a <dfn data-term> in lesson ${n}`);
      const first = text.search(wordsFor(term));
      t.ok(first >= at, `"${term.term}" is used before it is defined: "${text.slice(Math.max(0, first - 40), first + 30).replace(/\s+/g, ' ').trim()}"`);
      const end = page.slice(at).search(/<\/(p|li|td)>/);
      t.ok(page.slice(at, at + end).includes(`href="${term.more}"`), `"${term.term}" links to ${term.more} in the same paragraph`);
    }
  });

  test(`lesson ${n}: every <dfn> is in the glossary, and the recap lists every term`, t => {
    const known = new Set(terms.map(x => x.term));
    for (const [, name] of page.matchAll(/<dfn data-term="([^"]+)">/g)) t.ok(known.has(name), `"${name}" is in glossary.json`);
    const recap = page.slice(page.indexOf('id="recap"'));
    t.ok(page.includes('id="recap"'), 'the lesson has a recap with id="recap"');
    for (const term of mine) t.ok(wordsFor(term).test(readable(recap)), `the recap lists "${term.term}"`);
  });

  test(`lesson ${n}: no earlier lesson uses its terms`, t => {
    for (const m of lessons.filter(m => m < n)) {
      const earlier = readable(html[m]);
      for (const term of mine) {
        const i = earlier.search(wordsFor(term));
        t.ok(i < 0, `lesson ${m} uses "${term.term}", which lesson ${n} teaches`);
      }
    }
  });
}
