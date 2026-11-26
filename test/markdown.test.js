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

test('= Term | definition lines make a key terms list; retired layout markers stay plain text', () => {
  const { render } = require('../lib/markdown');
  assert.equal(render('= Remittance | Collected <daily>.\n= Reconciliation | Adjusts.'),
    '<dl class="terms"><div><dt>Remittance</dt><dd>Collected &lt;daily&gt;.</dd></div><div><dt>Reconciliation</dt><dd>Adjusts.</dd></div></dl>');
  assert.equal(render('$ Price | $5 | x'), '<p>$ Price | $5 | x</p>');
});

test('employment offers only brokerage and funder/lender company types; older types still have labels', () => {
  const v = require('../lib/validate');
  assert.deepEqual(Object.keys(v.COMPANY_TYPES), ['broker', 'funder_lender', 'funder_with_sales', 'broker_with_funding']);
  const base = { relationship_type: 'employee', company_name: 'Acme', start_month: '1', start_year: '2020', work_arrangement: 'remote', primary_role: 'sales_bizdev' };
  assert.ok(v.validateRelationship({ ...base, company_type: 'service_provider' }).errors.company_type);
  assert.ok(!v.validateRelationship({ ...base, company_type: 'broker' }).errors.company_type);
  assert.ok(!v.validateRelationship({ ...base, company_type: 'broker_with_funding' }).errors.company_type);
  assert.equal(v.COMPANY_TYPE_LABELS.technology_provider, 'Technology / Software Provider');
});

test('slide rows with "year: subject" labels stack the label above the text; plain labels stay side by side', () => {
  const { renderSlides } = require('../lib/markdown');
  const html = renderSlides('## A\n\n= Pre-2008: Early Foundations | Rooted in factoring.\n\n## B\n\n= Speed | Fast.');
  assert.match(html, /<dl class="terms stacked"><div><dt>Pre-2008: Early Foundations<\/dt><dd>Rooted in factoring\.<\/dd>/);
  assert.match(html, /<dl class="terms"><div><dt>Speed<\/dt>/);
});

test('a numbered list of "Step | description" items renders as a process timeline', () => {
  const { renderSlides } = require('../lib/markdown');
  const html = renderSlides('## P\n\n1. Request | The business asks.\n2. Funding | Money is sent.');
  assert.match(html, /<ol class="process"><li><strong>Request<\/strong><span>The business asks\.<\/span><\/li><li><strong>Funding<\/strong>/);
  assert.match(renderSlides('## Q\n\n1. One\n2. Two'), /<ol><li>One<\/li>/, 'plain numbered lists unchanged');
});
