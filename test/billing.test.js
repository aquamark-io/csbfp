/**
 * End-to-end tests for step 6 (payment, activation, renewals, cancellation, rejoining) against stand-ins for
 * Supabase and Stripe. Webhooks are signed and verified with the real Stripe library.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
  NODE_ENV: 'test',
  SITE_URL: 'https://csbfp-certification.org',
  SUPABASE_URL: 'http://fake.local',
  SUPABASE_SERVICE_KEY: 'fake',
  JWT_SECRET: 'b'.repeat(40),
  FIELD_ENCRYPTION_KEY: 'test-encryption-key-that-is-long-enough-1234',
  FIELD_HASH_KEY: 'test-hash-key-that-is-long-enough-and-different',
  PRE_LAUNCH: 'true',
  ADMIN_EMAILS: 'boss@example.com',
  PREVIEW_EMAILS: 'boss@example.com,pat@example.com,flag@example.com,new@example.com',
  POSTMARK_SERVER_TOKEN: '',
  STRIPE_SECRET_KEY: 'sk_test_fake',
});

const { createFake } = require('./fake-supabase');
const { createFakeStripe } = require('./fake-stripe');
const supa = require('../lib/supabase');
const S = require('../lib/stripe');
const { encrypt } = require('../lib/crypto');

const WH_SECRET = 'whsec_test_secret_for_tests';
const V = '99999999-9999-4999-8999-999999999999';
const MOD = 'aaaaaaaa-0000-4000-8000-000000000001';
const docs = ['terms', 'privacy', 'registration_agreement', 'automatic_renewal', 'disclaimer', 'acknowledgments', 'conduct_standards']
  .map(key => ({ key, version: 1, body_md: '- Statement.', status: 'published' }));

const fake = createFake({
  csbfp_legal_documents: docs,
  csbfp_job_titles: [], csbfp_financing_products: [{ id: 1, label: 'MCA', position: 1, active: true }],
  csbfp_curriculum_versions: [{ id: V, label: 'T', status: 'published', is_required: true, overview_md: '', completion_md: '' }],
  csbfp_modules: [{ id: MOD, curriculum_version_id: V, stable_key: 'm1', position: 1, title: 'M1', body_md: 'x' }],
  csbfp_assessment_settings: [{ curriculum_version_id: V, question_count: 1, pass_percent: 80, cooldown_minutes: 60, max_attempts_total: 10 }],
  csbfp_settings: [
    { key: 'stripe_test_price_id', value: 'price_test_99' },
    { key: 'stripe_test_portal_configuration_id', value: 'bpc_test_1' },
    { key: 'stripe_test_webhook_secret', value: encrypt(WH_SECRET) },
  ],
});
supa.db.set(fake);
const fs = createFakeStripe();
S.stripe.set(fs);

const sent = [];
const origLog = console.log;
console.log = (...args) => { const s = args.join(' '); if (s.includes('[email]')) sent.push(s); else origLog(...args); };
const origErr = console.error;

const app = require('../server');
let base;
let server;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { console.log = origLog; console.error = origErr; server.close(); });

function browser() {
  const jar = {};
  return {
    async req(path, form, headers0 = {}) {
      const headers = { cookie: Object.entries(jar).map(([k, val]) => `${k}=${val}`).join('; '), ...headers0 };
      let body;
      if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
      const res = await fetch(base + path, { method: form ? 'POST' : 'GET', headers, body, redirect: 'manual' });
      for (const c of res.headers.getSetCookie()) {
        const [k, ...val] = c.split(';')[0].split('=');
        if (/Expires=Thu, 01 Jan 1970/.test(c) || val.join('=') === '') delete jar[k]; else jar[k] = val.join('=');
      }
      return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    },
  };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function codeFor(email, after) {
  for (let i = 0; i < 50; i++) {
    const hit = sent.slice(after).reverse().find(s => s.includes(`to=${email}`) && /\n\d{6}\n/.test(s));
    if (hit) return hit.match(/\n(\d{6})\n/)[1];
    await wait(20);
  }
  throw new Error(`no code for ${email}`);
}
async function signUp(email, phone) {
  const b = browser();
  const mark = sent.length;
  await b.req('/portal/signup', { email, phone, agree: 'yes' });
  await b.req('/portal/verify', { code: await codeFor(email, mark) });
  return b;
}
const regOf = email => {
  const r = fake.tables.csbfp_registrants.find(x => x.email === email);
  return { r, reg: fake.tables.csbfp_registrations.find(x => x.registrant_id === r.id) };
};
// Everything before payment: profile, acknowledgments, training, passed assessment.
function makeReady(email) {
  const { r } = regOf(email);
  Object.assign(r, { legal_first_name: 'Pat', legal_last_name: 'Lee', dob_hash: 'h', dob_enc: 'v1:x', zip5: '94105', industry_start_month: '2020-01-01', employment_status: 'not_currently_employed' });
  fake.tables.csbfp_registrant_products = [...(fake.tables.csbfp_registrant_products || []), { registrant_id: r.id, product_id: 1 }];
  fake.tables.csbfp_legal_acceptances.push({ id: 900 + fake.tables.csbfp_legal_acceptances.length, registrant_id: r.id, document_key: 'acknowledgments', document_version: 1, context: 'acknowledgments', accepted_at: new Date().toISOString() });
  fake.tables.csbfp_training_progress = [...(fake.tables.csbfp_training_progress || []), { registrant_id: r.id, module_id: MOD, started_at: new Date().toISOString(), completed_at: new Date().toISOString() }];
  fake.tables.csbfp_assessment_attempts = [...(fake.tables.csbfp_assessment_attempts || []), { id: `att-${r.id}`, registrant_id: r.id, curriculum_version_id: V, started_at: new Date().toISOString(), submitted_at: new Date().toISOString(), passed: true, correct_count: 1, question_count: 1, questions_snapshot: [], pass_percent_applied: 80 }];
}
async function webhook(type, object, { secret = WH_SECRET, id } = {}) {
  const payload = JSON.stringify({ id: id || `evt_${Math.random().toString(36).slice(2)}`, object: 'event', type, data: { object } });
  const sig = fs.webhooks.generateTestHeaderString({ payload, secret });
  const res = await fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: payload });
  return { status: res.status, body: await res.json() };
}

let pat;
let session;

test('payment is locked until every earlier step is done', async () => {
  pat = await signUp('pat@example.com', '4155550303');
  const r = await pat.req('/portal/checkout');
  assert.match(r.text, /Payment becomes available once/);
  assert.match(r.text, /Pass the assessment/);
  const post = await pat.req('/portal/checkout', { agree_renewal: 'yes' });
  assert.equal(post.location, '/portal/checkout');
  assert.equal(Object.keys(fs.state.sessions).length, 0);
});

test('checkout needs the automatic-renewal consent, records it, and sends them to Stripe', async () => {
  makeReady('pat@example.com');
  let r = await pat.req('/portal/checkout');
  assert.match(r.text, /\$199 per year/);
  assert.match(r.text, /I authorize CSBFP to charge \$199 today/);
  assert.match(r.text, /each year until I cancel online\. Non-refundable/);
  assert.match(r.text, /Pay \$199/);
  r = await pat.req('/portal/checkout', {});
  assert.equal(r.status, 422);
  assert.match(r.text, /agree to automatic annual renewal/);
  r = await pat.req('/portal/checkout', { agree_renewal: 'yes' });
  assert.equal(r.status, 303);
  assert.match(r.location, /^https:\/\/checkout\.stripe\.com\//);
  session = Object.values(fs.state.sessions)[0];
  const { r: who, reg } = regOf('pat@example.com');
  assert.equal(session.client_reference_id, reg.id);
  assert.equal(session.metadata.app, 'csbfp');
  assert.ok(reg.stripe_customer_id);
  const consent = fake.tables.csbfp_legal_acceptances.filter(a => a.registrant_id === who.id && a.context === 'checkout').map(a => `${a.document_key}:${a.ref}`).sort();
  assert.deepEqual(consent, [`terms:${session.id}`]);
});

test('with screening off, paying issues a DEMO credential (DEMO- number, labeled not screened), valid for a year', async () => {
  fs.completeCheckout(session.id);
  const r = await pat.req(`/portal/checkout/return?session_id=${session.id}`);
  assert.match(r.text, /Demo Credential Issued/);
  assert.match(r.text, /DEMO \/ NOT SCREENED/);
  const { reg } = regOf('pat@example.com');
  assert.equal(reg.status, 'active');
  assert.equal(reg.is_demo, true);
  assert.ok(reg.paid_at && reg.approved_at);
  assert.match(reg.registration_number, /^DEMO-\d{8}$/);
  assert.equal((fake.tables.csbfp_screenings || []).length, 0, 'no screening record pretends a check happened');
  assert.ok(reg.first_activated_at);
  const days = (Date.parse(reg.expires_at) - Date.now()) / 864e5;
  assert.ok(days > 364 && days < 366, `valid ~1 year (${days})`);
  assert.equal(fake.tables.csbfp_registration_status_history.at(-1).reason, 'DEMO credential issued (background screening not enabled)');
  const pay = fake.tables.csbfp_payments.find(p => p.registration_id === reg.id);
  assert.equal(pay.status, 'paid');
  assert.equal(pay.amount_cents, 19900);
  assert.equal(pay.billing_reason, 'initial');
  await wait(50);
  assert.ok(sent.some(s => s.includes('to=pat@example.com') && s.includes(reg.registration_number)), 'activation email with number');
  const dash = await pat.req('/portal/dashboard');
  assert.match(dash.text, /<dt>Certification<\/dt><dd><span class="dstat">Certified/);
  assert.match(dash.text, /DEMO \/ NOT SCREENED/);
  const conf = await pat.req('/portal/confirmation');
  assert.match(conf.text, /Certificate/);
  assert.match(conf.text, /not a valid CSBFP certification/);
  const v = await pat.req(`/verify?number=${reg.registration_number}`);
  assert.match(v.text, /DEMO RECORD: NOT SCREENED/);
  assert.doesNotMatch(v.text, /verify-status ok/);
  assert.match(conf.text, /not a government license/);
});

test('the webhook for the same checkout changes nothing; duplicates and bad signatures are rejected', async () => {
  const { reg } = regOf('pat@example.com');
  const number = reg.registration_number;
  const historyLen = fake.tables.csbfp_registration_status_history.length;
  const evt = { id: session.id, object: 'checkout.session', mode: 'subscription', metadata: session.metadata };
  let r = await webhook('checkout.session.completed', evt, { id: 'evt_dup_1' });
  assert.equal(r.status, 200);
  r = await webhook('checkout.session.completed', evt, { id: 'evt_dup_1' });
  assert.equal(r.body.result, 'duplicate');
  assert.equal(regOf('pat@example.com').reg.registration_number, number);
  assert.equal(fake.tables.csbfp_registration_status_history.length, historyLen);
  assert.equal(fake.tables.csbfp_payments.filter(p => p.registration_id === reg.id).length, 1);
  r = await webhook('checkout.session.completed', evt, { secret: 'whsec_wrong' });
  assert.equal(r.status, 400);
  assert.equal((await pat.req('/portal/checkout', { agree_renewal: 'yes' })).location, '/portal/checkout', 'active: no second checkout');
});

test('cancel automatic renewal (stays active) and turn it back on', async () => {
  let r = await pat.req('/portal/billing');
  assert.match(r.text, /Automatic renewal<\/dt><dd>On/);
  r = await pat.req('/portal/billing/cancel');
  assert.match(r.text, /stays <strong>Active through/);
  await pat.req('/portal/billing/cancel', {});
  const sub = Object.values(fs.state.subscriptions)[0];
  assert.equal(sub.cancel_at_period_end, true);
  r = await pat.req('/portal/billing');
  assert.match(r.text, /Certification ends/);
  assert.equal(regOf('pat@example.com').reg.status, 'active');
  await pat.req('/portal/billing/resume', {});
  assert.equal(sub.cancel_at_period_end, false);
  r = await pat.req('/portal/billing/manage', {});
  assert.match(r.location, /^https:\/\/billing\.stripe\.com\//);
});

test('a failed renewal makes the registration Inactive; paying reactivates it and extends the date', async () => {
  const sub = Object.values(fs.state.subscriptions)[0];
  const before = regOf('pat@example.com').reg.expires_at;
  const inv = fs.renew(sub.id, { paid: false });
  let r = await webhook('invoice.payment_failed', inv);
  assert.equal(r.body.result, 'failed');
  assert.equal(regOf('pat@example.com').reg.status, 'inactive');
  assert.equal(fake.tables.csbfp_registration_status_history.at(-1).reason, 'Renewal payment failed');
  r = await pat.req('/portal/dashboard');
  assert.match(r.text, /<dt>Certification<\/dt><dd><span class="dstat">Inactive/);
  assert.match(r.text, /href="\/portal\/billing">Pay Now/);
  r = await pat.req('/portal/billing/pay');
  assert.equal(r.location, inv.hosted_invoice_url);

  fs.payInvoice(inv.id);
  r = await webhook('invoice.paid', fs.state.invoices[inv.id]);
  assert.equal(r.body.result, 'paid');
  const { reg } = regOf('pat@example.com');
  assert.equal(reg.status, 'active');
  assert.ok(Date.parse(reg.expires_at) > Date.parse(before) + 364 * 864e5, 'extended by a year');
  assert.equal(fake.tables.csbfp_registration_status_history.at(-1).reason, 'Renewal paid');
  assert.ok(fake.tables.csbfp_payments.some(p => p.stripe_invoice_id === inv.id && p.status === 'paid' && p.billing_reason === 'renewal'));
});

test('if the subscription ends while Inactive, they rejoin through checkout and keep their number', async () => {
  const sub = Object.values(fs.state.subscriptions)[0];
  const number = regOf('pat@example.com').reg.registration_number;
  const inv = fs.renew(sub.id, { paid: false });
  await webhook('invoice.payment_failed', inv);
  assert.equal(regOf('pat@example.com').reg.status, 'inactive');
  await webhook('customer.subscription.deleted', fs.endSubscription(sub.id));
  assert.equal(regOf('pat@example.com').reg.status, 'inactive', 'stays inactive');

  let r = await pat.req('/portal/checkout');
  assert.match(r.text, /Pay \$199/);
  r = await pat.req('/portal/checkout', { agree_renewal: 'yes' });
  const s2 = Object.values(fs.state.sessions).at(-1);
  fs.completeCheckout(s2.id);
  await webhook('checkout.session.completed', { id: s2.id, object: 'checkout.session', mode: 'subscription', metadata: s2.metadata });
  const { reg } = regOf('pat@example.com');
  assert.equal(reg.status, 'active');
  assert.equal(reg.registration_number, number, 'same number');
  assert.equal(Object.keys(fs.state.customers).length, 1, 'same Stripe customer');
});

test('an open duplicate flag or an admin hold blocks payment', async () => {
  const b = await signUp('flag@example.com', '4155550404');
  makeReady('flag@example.com');
  const { r, reg } = regOf('flag@example.com');
  fake.tables.csbfp_duplicate_flags = [...(fake.tables.csbfp_duplicate_flags || []), { id: 'f1', registrant_id: r.id, matched_registrant_id: regOf('pat@example.com').r.id, match_reason: 'phone', status: 'open' }];
  let page = await b.req('/portal/checkout');
  assert.match(page.text, /confirm a few details/);
  fake.tables.csbfp_duplicate_flags.find(f => f.id === 'f1').status = 'dismissed';
  reg.admin_hold = true;
  page = await b.req('/portal/checkout');
  assert.match(page.text, /application is on hold/);
  reg.admin_hold = false;
  page = await b.req('/portal/checkout');
  assert.match(page.text, /Pay \$199/);
});

test('a live Stripe key is refused while the site is in preview', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_live_should_not_be_used';
  try {
    assert.match(S.blockedReason(), /live Stripe key/);
    const r = await webhook('invoice.paid', {});
    assert.equal(r.status, 503);
  } finally {
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  }
});

test('admin: Stripe setup creates the product, price, portal and webhook once; payments are listed', async () => {
  const b = browser();
  const mark = sent.length;
  await b.req('/admin/login', { email: 'boss@example.com' });
  await b.req('/admin/login/verify', { code: await codeFor('boss@example.com', mark) });
  fake.tables.csbfp_settings = []; // as if never set up
  let r = await b.req('/admin/stripe');
  assert.match(r.text, /Test mode/);
  assert.match(r.text, /Set Up Stripe/);
  r = await b.req('/admin/stripe/setup', {});
  assert.match(decodeURIComponent(r.location), /Stripe is set up \(test mode\)/);
  assert.equal(fs.state.products.length, 1);
  assert.equal(fs.state.products[0].statement_descriptor, 'CSBFP CERTIFICATION');
  assert.equal(fs.state.prices[0].unit_amount, 19900);
  assert.equal(fs.state.prices[0].recurring.interval, 'year');
  assert.equal(fs.state.endpoints.length, 1);
  assert.equal(fs.state.endpoints[0].url, 'https://csbfp-certification.org/webhooks/stripe');
  const cfg = await S.stripeConfig();
  assert.ok(cfg.ready);
  assert.equal(cfg.webhookSecret, fs.state.endpoints[0].secret);
  await b.req('/admin/stripe/setup', {});
  assert.equal(fs.state.products.length, 1, 'no duplicate product');
  assert.equal(fs.state.prices.length, 1, 'no duplicate price');
  assert.equal(fs.state.endpoints.length, 1, 'no duplicate webhook');
  r = await b.req('/admin/payments');
  assert.match(r.text, /\$199\.00/);
  const pat = regOf('pat@example.com').r;
  r = await b.req(`/admin/registrants/${pat.id}`);
  assert.match(r.text, /Subscription <code>sub_/);
});

test('signed-in pages get the one-line footer; public pages keep the full one', async () => {
  const pub = await browser().req('/faq');
  assert.match(pub.text, /Industry Partners/);
  assert.doesNotMatch(pub.text, /footer-slim/);
  for (const path of ['/portal/dashboard', '/faq']) {
    const r = await pat.req(path);
    assert.match(r.text, /<footer class="footer footer-slim">/, path);
    assert.doesNotMatch(r.text, /Industry Partners/, path);
    assert.match(r.text, /href="\/legal\/terms">Program Terms/, path);
  }
});
