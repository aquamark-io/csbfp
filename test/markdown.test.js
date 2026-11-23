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
  assert.match(html, /^<section class="slide slide-letter" data-slide="1"><div class="letter">.*<p class="goal">.*Learn.<\/p><\/div><\/section>/, 'opening text is a letter slide with no heading');
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

test('> makes a highlighted statement', () => {
  const { render } = require('../lib/markdown');
  assert.equal(render('> With opportunity comes <b>responsibility</b>.'), '<p class="statement">With opportunity comes &lt;b&gt;responsibility&lt;/b&gt;.</p>');
});

test('@icon lines make an icon row; unknown icons show just the label', () => {
  const { render } = require('../lib/markdown');
  const html = render('@cash Working capital\n@nope Payroll <x>');
  assert.match(html, /^<ul class="icon-row"><li><span class="icon-tile"><svg viewBox="0 0 24 24" aria-hidden="true">.*<\/svg><\/span><span>Working capital<\/span><\/li>/);
  assert.match(html, /<li><span class="icon-tile"><\/span><span>Payroll &lt;x&gt;<\/span><\/li><\/ul>$/);
});

test('a table with an empty first header cell is a comparison with row labels and header icons', () => {
  const { render } = require('../lib/markdown');
  const html = render('| | @bank Bank | Other |\n|---|---|---|\n| Speed | Weeks | Days |\n\n~ Terms matter.');
  assert.match(html, /<table class="md-table md-compare">/);
  assert.match(html, /<th scope="col"><span class="icon-tile"><svg[^>]*>.*<\/svg><\/span>Bank<\/th><th scope="col">Other<\/th>/);
  assert.match(html, /<tr><th scope="row">Speed<\/th><td data-label="Bank">Weeks<\/td><td data-label="Other">Days<\/td><\/tr>/);
  assert.match(html, /<p class="note">Terms matter.<\/p>$/);
});

test('+ Title | text lines make columns with header bands', () => {
  const { render } = require('../lib/markdown');
  const html = render('+ Funder | Provides **capital**.\n+ Broker | Helps <you>.');
  assert.equal(html, '<ul class="columns cols-2"><li><p class="columns-head">Funder</p><p>Provides <strong>capital</strong>.</p></li><li><p class="columns-head">Broker</p><p>Helps &lt;you&gt;.</p></li></ul>');
});
