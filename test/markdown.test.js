const test = require('node:test');
const assert = require('node:assert/strict');

test('markdown tables render escaped, with a header row', () => {
  const { render } = require('../lib/markdown');
  const html = render('| Module | Description |\n|---|---|\n| One | a <b> |');
  assert.match(html, /<th>Module<\/th><th>Description<\/th>/);
  assert.match(html, /<td>a &lt;b&gt;<\/td>/);
});

test('training slides split at headings and keep callouts with their slide', () => {
  const { renderSlides } = require('../lib/markdown');
  const html = renderSlides('Goal: Learn.\n\n## Products\n\nIntro.\n\n### Loans\n\n- a\n\n### Remember\n\nBe careful.\n\n### Leases\n\nText');
  assert.equal((html.match(/<section class="slide/g) || []).length, 4);
  assert.match(html, /^<section class="slide" data-slide="1"><p class="goal">.*Learn.<\/p><\/section>/, 'opening text is a slide with no heading');
  assert.doesNotMatch(html, /In this module/);
  assert.match(html, /<h2>Loans<\/h2><ul><li>a<\/li><\/ul>\n?<aside class="callout callout-remember">/);
});

test('a section heading with nothing under it does not make an empty slide', () => {
  const { renderSlides } = require('../lib/markdown');
  const html = renderSlides('Goal: G.\n\n## Loans\n\n### Business loans\n\n- a\n\n### Terms\n\n- b');
  assert.equal((html.match(/<section class="slide/g) || []).length, 3);
  assert.doesNotMatch(html, /<h2>Loans<\/h2><\/section>/);
});

test('#### is a subheading inside the same slide', () => {
  const { renderSlides } = require('../lib/markdown');
  const html = renderSlides('## Loans\n\nIntro.\n\n#### Key Terms\n\n- a\n\n### Core Standard\n\nBe clear.\n\n## Leases\n\nText');
  assert.equal((html.match(/<section class="slide/g) || []).length, 2);
  assert.match(html, /<h3 class="subhead">Key Terms<\/h3>\n<ul><li>a<\/li><\/ul>\n<aside class="callout callout-core-standard">/);
});

test('https links render; other schemes stay as text', () => {
  const { render } = require('../lib/markdown');
  assert.match(render('See [Center](https://example.org/a/).'), /<a href="https:\/\/example.org\/a\/" target="_blank" rel="noopener noreferrer">Center<\/a>/);
  assert.doesNotMatch(render('[x](javascript:alert(1))'), /<a /);
  assert.doesNotMatch(render('[x](http://example.org)'), /<a /);
});
