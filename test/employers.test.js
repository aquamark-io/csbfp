/**
 * Employer certification credits: request an Employer ID, buy credits (Stripe one-time payment), employees pay with
 * the ID, balance tracking, employer-paid year with no auto-renewal (add a card later), reminder, admin adjust/reissue.
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
  PREVIEW_EMAILS: 'boss@example.com,emp1@example.com,emp2@example.com,emp3@example.com',
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


const form = async (path, data, b = browser()) => b.req(path, data);
let employer;

test('request an Employer ID: live immediately, shown and emailed', async () => {
  let r = await form('/employers/request', { company_name: 'ABC Funding', contact_name: 'Ann Boss', email: 'bad' });
  assert.equal(r.status, 422);
  r = await form('/employers/request', { company_name: 'ABC Funding', contact_name: 'Ann Boss', email: 'Owner@ABC.com' });
  assert.equal(r.status, 200);
  employer = fake.tables.csbfp_employers[0];
  assert.match(employer.employer_number, /^ER-[A-Z2-9]{6}$/);
  assert.equal(employer.email, 'owner@abc.com');
  assert.match(r.text, new RegExp(employer.employer_number));
  await wait(30);
  assert.ok(sent.some(s => s.includes('to=owner@abc.com') && s.includes('template=employer_welcome') && s.includes(employer.employer_number)));
  assert.match((await browser().req('/employers')).text, /For Employers/);
  assert.match((await browser().req('/')).text, /href="\/employers"/, 'nav link');
});

test('buy credits: ID + email on file, quantity, Stripe one-time payment; credits added once', async () => {
  let r = await form('/employers/buy', { employer_number: employer.employer_number, email: 'someone@else.com', quantity: '3' });
  assert.match(r.text, /don.{1,5}t match our records/);
  r = await form('/employers/buy', { employer_number: employer.employer_number, email: 'owner@abc.com', quantity: '0' });
  assert.match(r.text, /quantity from 1 to 500/);
  r = await form('/employers/buy', { employer_number: employer.employer_number.toLowerCase().replace('-', ''), email: 'owner@abc.com', quantity: '2' });
  assert.equal(r.status, 303);
  assert.match(r.location, /^https:\/\/checkout\.stripe\.com\//);
  const sess = Object.values(fs.state.sessions).find(s => s.mode === 'payment');
  assert.equal(sess.line_items[0].quantity, 2);
  assert.equal(sess.line_items[0].price_data.unit_amount, 19900);
  assert.equal(sess.metadata.kind, 'employer_credits');
  fs.completePayment(sess.id);
  r = await browser().req(`/employers/purchase/return?session_id=${sess.id}`);
  assert.match(r.text, /2 credits added/);
  assert.match(r.text, /Credits remaining<\/dt><dd><strong>2/);
  const w = await webhook('checkout.session.completed', { id: sess.id, object: 'checkout.session', mode: 'payment', metadata: sess.metadata });
  assert.equal(w.body.result, 'employer credits: nothing to add', 'webhook after return page adds nothing');
  assert.equal(fake.tables.csbfp_employers[0].credits_purchased, 2);
  await wait(30);
  assert.equal(sent.filter(s => s.includes('template=employer_credits_added')).length, 1);
  r = await form('/employers/balance', { employer_number: employer.employer_number, email: 'owner@abc.com' });
  assert.match(r.text, /Credits remaining<\/dt><dd><strong>2/);
});

let emp1;
test('an employee pays with the Employer ID: one credit used, no card, no subscription', async () => {
  emp1 = await signUp('emp1@example.com', '4155550601');
  makeReady('emp1@example.com');
  let r = await emp1.req('/portal/checkout');
  assert.match(r.text, /My employer is paying/);
  r = await emp1.req('/portal/checkout', { method: 'employer', employer_number: 'ER-ZZZZZZ', agree_terms: 'yes' });
  assert.equal(r.status, 422);
  assert.match(r.text, /couldn.{1,5}t find that Employer ID/);
  r = await emp1.req('/portal/checkout', { method: 'employer', employer_number: employer.employer_number });
  assert.match(r.text, /agree to the Program Terms/);
  r = await emp1.req('/portal/checkout', { method: 'employer', employer_number: employer.employer_number, agree_terms: 'yes' });
  assert.equal(r.location, '/portal/checkout/return');
  const { reg } = regOf('emp1@example.com');
  assert.equal(reg.status, 'active');
  assert.equal(reg.is_demo, true, 'screening off: demo credential, same as card');
  assert.equal(reg.paid_by_employer_id, employer.id);
  const days = (Date.parse(reg.expires_at) - Date.now()) / 864e5;
  assert.ok(days > 364 && days < 366);
  assert.equal(fake.tables.csbfp_employers[0].credits_used, 1);
  assert.equal(Object.values(fs.state.subscriptions).filter(s => (s.metadata || {}).registration_id === reg.id).length, 0);
  assert.ok(fake.tables.csbfp_legal_acceptances.some(a => a.registrant_id === regOf('emp1@example.com').r.id && a.context === 'checkout'));
});

test('employer-paid: add a card later; billing starts when the paid year ends', async () => {
  const { reg } = regOf('emp1@example.com');
  let r = await emp1.req('/portal/checkout');
  assert.match(r.text, /Your employer paid for your certification through/);
  r = await emp1.req('/portal/checkout', { agree_renewal: 'yes' });
  assert.match(r.location, /^https:\/\/checkout\.stripe\.com\//);
  const sess = Object.values(fs.state.sessions).filter(s => s.client_reference_id === reg.id).at(-1);
  assert.equal(sess._trialEnd, Math.floor(Date.parse(reg.expires_at) / 1000), 'first charge on the paid-through date');
  fs.completeCheckout(sess.id);
  await emp1.req(`/portal/checkout/return?session_id=${sess.id}`);
  const after = regOf('emp1@example.com').reg;
  assert.equal(after.status, 'active');
  assert.equal(after.expires_at, reg.expires_at, 'valid-through unchanged');
  assert.equal(fake.tables.csbfp_subscriptions.find(s => s.registration_id === reg.id).stripe_status, 'trialing');
  r = await emp1.req('/portal/checkout');
  assert.doesNotMatch(r.text, /Add a Card Securely/, 'card now on file');
});

test('30 days before an employer-paid year ends with no card: reminder to add one (once)', async () => {
  const emp2 = await signUp('emp2@example.com', '4155550602');
  makeReady('emp2@example.com');
  await emp2.req('/portal/checkout', { method: 'employer', employer_number: employer.employer_number, agree_terms: 'yes' });
  const reg = regOf('emp2@example.com').reg;
  reg.expires_at = new Date(Date.now() + 20 * 864e5).toISOString();
  const jobs = require('../lib/jobs');
  await jobs.runTasks(new Date());
  await jobs.runTasks(new Date());
  await wait(30);
  assert.equal(sent.filter(s => s.includes('to=emp2@example.com') && s.includes('template=renewal_add_card')).length, 1);
  assert.equal(sent.filter(s => s.includes('to=emp1@example.com') && s.includes('template=renewal_add_card')).length, 0, 'emp1 has a card on file');
});

test('out of credits: clear message, pay by card instead', async () => {
  assert.equal(fake.tables.csbfp_employers[0].credits_purchased - fake.tables.csbfp_employers[0].credits_used, 0);
  const emp3 = await signUp('emp3@example.com', '4155550603');
  makeReady('emp3@example.com');
  const r = await emp3.req('/portal/checkout', { method: 'employer', employer_number: employer.employer_number, agree_terms: 'yes' });
  assert.match(r.text, /no certification credits left/);
  assert.equal(regOf('emp3@example.com').reg.status, 'pending');
});

test('admin: list, adjust with reason, reissue retires the old ID and moves the balance', async () => {
  const b = browser();
  const mark = sent.length;
  await b.req('/admin/login', { email: 'boss@example.com' });
  await b.req('/admin/login/verify', { code: await codeFor('boss@example.com', mark) });
  let r = await b.req('/admin/employers');
  assert.match(r.text, new RegExp(employer.employer_number));
  r = await b.req(`/admin/employers/${employer.id}`);
  assert.match(r.text, /Pat Lee/, 'who used credits');
  r = await b.req(`/admin/employers/${employer.id}/adjust`, { amount: '3', reason: '' });
  assert.match(decodeURIComponent(r.location), /reason is required/);
  await b.req(`/admin/employers/${employer.id}/adjust`, { amount: '3', reason: 'Goodwill credits' });
  assert.equal(fake.tables.csbfp_employers[0].credits_adjusted, 3);
  r = await b.req(`/admin/employers/${employer.id}/reissue`, { reason: 'ID posted publicly' });
  const fresh = fake.tables.csbfp_employers.find(e => e.id !== employer.id);
  assert.match(decodeURIComponent(r.location), new RegExp(fresh.employer_number));
  assert.equal(fake.tables.csbfp_employers.find(e => e.id === employer.id).active, false);
  assert.equal(fresh.credits_purchased + fresh.credits_adjusted - fresh.credits_used, 3);
  const emp3 = browser();
  const m2 = sent.length;
  await emp3.req('/portal', { email: 'emp3@example.com' });
  await emp3.req('/portal/verify', { code: await codeFor('emp3@example.com', m2) });
  r = await emp3.req('/portal/checkout', { method: 'employer', employer_number: employer.employer_number, agree_terms: 'yes' });
  assert.match(r.text, /couldn.{1,5}t find that Employer ID/, 'old ID no longer works');
  r = await emp3.req('/portal/checkout', { method: 'employer', employer_number: fresh.employer_number, agree_terms: 'yes' });
  assert.equal(r.location, '/portal/checkout/return');
  assert.ok(fake.tables.csbfp_admin_audit_log.some(a => a.action === 'employer_id_reissued'));
});
