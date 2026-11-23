/**
 * Tests for step 8b and 10-11: support, data deletion, identity review, announcements, reports, legal documents,
 * launch checklist and preview-data removal.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
  NODE_ENV: 'test', SITE_URL: 'https://csbfp-certification.org', SUPABASE_URL: 'http://fake.local', SUPABASE_SERVICE_KEY: 'fake',
  JWT_SECRET: 's'.repeat(40), FIELD_ENCRYPTION_KEY: 'test-encryption-key-that-is-long-enough-1234',
  FIELD_HASH_KEY: 'test-hash-key-that-is-long-enough-and-different', PRE_LAUNCH: 'true', ADMIN_EMAILS: 'boss@example.com',
  PREVIEW_EMAILS: 'boss@example.com,dee@example.com', POSTMARK_SERVER_TOKEN: '', STRIPE_SECRET_KEY: 'sk_test_fake',
});

const { createFake } = require('./fake-supabase');
const { createFakeStripe } = require('./fake-stripe');
const supa = require('../lib/supabase');
const S = require('../lib/stripe');

const iso = ms => new Date(ms).toISOString();
const docs = ['terms', 'privacy', 'registration_agreement', 'automatic_renewal', 'disclaimer', 'acknowledgments']
  .map(key => ({ key, version: 1, title: key, body_md: key === 'acknowledgments' ? '- One.' : 'Placeholder.', status: 'published', published_at: iso(Date.now()) }));
const DEE = '11111111-1111-4111-8111-111111111111';
const fake = createFake({
  csbfp_legal_documents: docs,
  csbfp_registrants: [
    { id: DEE, email: 'dee@example.com', email_verified_at: iso(Date.now()), account_status: 'active', legal_first_name: 'Dee', legal_last_name: 'Lane', dob_enc: 'v1:x', dob_hash: 'h', zip5: '94105', phone_e164: '+14155550909', created_at: iso(Date.now() - 40 * 864e5) },
    { id: 'p2', email: 'old@example.com', email_verified_at: iso(Date.now()), account_status: 'active', legal_first_name: 'Old', created_at: iso(Date.now() - 400 * 864e5) },
  ],
  csbfp_registrations: [
    { id: 'g1', registrant_id: DEE, registration_number: 'CSBFP-12121212', status: 'active', admin_hold: false, expires_at: iso(Date.now() + 200 * 864e5), first_activated_at: iso(Date.now() - 30 * 864e5), stripe_customer_id: 'cus_d', created_at: iso(Date.now()) },
    { id: 'g2', registrant_id: 'p2', registration_number: 'CSBFP-34343434', status: 'expired', admin_hold: false, expires_at: iso(Date.now() - 30 * 864e5), first_activated_at: iso(Date.now() - 395 * 864e5), created_at: iso(Date.now()) },
  ],
  csbfp_subscriptions: [{ id: 's1', registrant_id: DEE, registration_id: 'g1', stripe_customer_id: 'cus_d', stripe_subscription_id: 'sub_d', stripe_status: 'active', cancel_at_period_end: false, created_at: iso(Date.now()) }],
  csbfp_payments: [{ id: 'pay1', registrant_id: DEE, registration_id: 'g1', stripe_invoice_id: 'in_d', status: 'paid', billing_reason: 'initial', amount_cents: 9900, paid_at: iso(Date.now() - 30 * 864e5), created_at: iso(Date.now() - 30 * 864e5) }],
  csbfp_employment_relationships: [{ id: 'e1', registrant_id: DEE, company_name: 'Acme', city: 'Miami', state: 'FL' }],
  csbfp_legal_acceptances: [{ id: 1, registrant_id: DEE, document_key: 'automatic_renewal', document_version: 1, context: 'checkout', accepted_at: iso(Date.now()) }],
  csbfp_settings: [{ key: 'stripe_test_price_id', value: 'p' }],
});
supa.db.set(fake);
const fs = createFakeStripe();
fs.state.subscriptions.sub_d = { id: 'sub_d', status: 'active', customer: 'cus_d', cancel_at_period_end: false, metadata: { app: 'csbfp', registration_id: 'g1' },
  items: { data: [{ current_period_start: 0, current_period_end: Math.floor(Date.now() / 1000) + 200 * 86400 }] } };
S.stripe.set(fs);

const sent = [];
const origLog = console.log;
console.log = (...args) => { const s = args.join(' '); if (s.includes('[email]')) sent.push(s); else origLog(...args); };
const app = require('../server');
let base; let server;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { console.log = origLog; server.close(); });

const wait = ms => new Promise(r => setTimeout(r, ms));
const mails = (to, tpl) => sent.filter(s => s.includes(`to=${to}`) && (!tpl || s.includes(`template=${tpl}`)));
function browser() {
  const jar = {};
  return {
    async req(path, form) {
      const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
      let body;
      if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
      const res = await fetch(base + path, { method: form ? 'POST' : 'GET', headers, body, redirect: 'manual' });
      for (const c of res.headers.getSetCookie()) { const [k, ...v] = c.split(';')[0].split('='); if (/Expires=Thu, 01 Jan 1970/.test(c) || v.join('=') === '') delete jar[k]; else jar[k] = v.join('='); }
      return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    },
  };
}
async function codeFor(email, after) {
  for (let i = 0; i < 50; i++) {
    const hit = sent.slice(after).reverse().find(s => s.includes(`to=${email}`) && /\n\d{6}\n/.test(s));
    if (hit) return hit.match(/\n(\d{6})\n/)[1];
    await wait(20);
  }
  throw new Error(`no code for ${email}`);
}
async function signIn(email, path = '/portal') {
  const b = browser();
  const mark = sent.length;
  if (path === '/admin') {
    await b.req('/admin/login', { email });
    await b.req('/admin/login/verify', { code: await codeFor(email, mark) });
  } else {
    await b.req('/portal', { email });
    await b.req('/portal/verify', { code: await codeFor(email, mark) });
  }
  return b;
}

let boss;
test('contact form: request saved with a reference, confirmation to sender, alert to admins (no message text)', async () => {
  let r = await browser().req('/support', { name: 'Sam Q', email: 'bad', category: 'billing', message: 'hi there' });
  assert.equal(r.status, 422);
  r = await browser().req('/support', { name: 'Sam Q', email: 'sam@example.com', category: 'billing', message: 'Question about my renewal date' });
  assert.match(r.text, /reference <strong>SR-[0-9A-F]{6}<\/strong>/);
  const sr = fake.tables.csbfp_support_requests[0];
  assert.equal(sr.category, 'billing');
  assert.match(sr.message, /From: Sam Q/);
  await wait(50);
  assert.equal(mails('sam@example.com', 'support_request_received').length, 1);
  assert.equal(mails('boss@example.com', 'admin_support_alert').length, 1);
  assert.doesNotMatch(mails('boss@example.com', 'admin_support_alert')[0], /renewal date/);
});

test('admin support queue: read, note, close', async () => {
  boss = await signIn('boss@example.com', '/admin');
  const sr = fake.tables.csbfp_support_requests[0];
  let r = await boss.req('/admin/support');
  assert.match(r.text, /billing or payment/);
  r = await boss.req(`/admin/support/${sr.id}`);
  assert.match(r.text, /Question about my renewal date/);
  await boss.req(`/admin/support/${sr.id}`, { status: 'closed', admin_note: 'Replied by email' });
  assert.equal(sr.status, 'closed');
  assert.ok(sr.closed_at);
});

test('"delete my data": request turns off auto-renewal and reaches the admin queue', async () => {
  const dee = await signIn('dee@example.com');
  let r = await dee.req('/portal/account/delete', {});
  assert.equal(r.status, 422);
  r = await dee.req('/portal/account/delete', { confirm: 'yes' });
  assert.match(decodeURIComponent(r.location), /deletion request was received/);
  assert.equal(fake.tables.csbfp_registrants.find(x => x.id === DEE).account_status, 'deletion_requested');
  assert.equal(fs.state.subscriptions.sub_d.cancel_at_period_end, true);
  assert.ok(fake.tables.csbfp_support_requests.some(s => s.category === 'data_deletion' && s.registrant_id === DEE));
  assert.match((await boss.req(`/admin/registrants/${DEE}`)).text, /asked for their data to be deleted/);
});

test('identity review email', async () => {
  await boss.req(`/admin/registrants/${DEE}/identity-review`, { note: 'Please confirm your ZIP code.' });
  await wait(30);
  assert.match(mails('dee@example.com', 'identity_review_required')[0], /Please confirm your ZIP code/);
});

test('admin deletion: personal data gone, number retired (verification says not found), payment and consent kept', async () => {
  let r = await boss.req(`/admin/registrants/${DEE}/delete-data`, { confirm: 'delete', reason: 'SR request' });
  assert.match(decodeURIComponent(r.location), /Type DELETE/);
  assert.match((await browser().req('/verify?number=CSBFP-12121212')).text, /Dee Lane/);
  r = await boss.req(`/admin/registrants/${DEE}/delete-data`, { confirm: 'DELETE', reason: 'Deletion requested' });
  assert.match(decodeURIComponent(r.location), /number is retired/);
  const p = fake.tables.csbfp_registrants.find(x => x.id === DEE);
  assert.equal(p.account_status, 'deleted');
  for (const f of ['email', 'legal_first_name', 'legal_last_name', 'dob_enc', 'dob_hash', 'zip5', 'phone_e164']) assert.equal(p[f], null, f);
  assert.equal(fake.tables.csbfp_employment_relationships.filter(x => x.registrant_id === DEE).length, 0);
  assert.equal(fake.tables.csbfp_email_messages.filter(x => x.registrant_id === DEE).length, 0);
  assert.equal(fs.state.subscriptions.sub_d.status, 'canceled', 'no more charges');
  assert.ok(fake.tables.csbfp_registrations.find(x => x.id === 'g1').retired_at);
  assert.equal(fake.tables.csbfp_registrations.find(x => x.id === 'g1').registration_number, 'CSBFP-12121212', 'number kept so it is never reissued');
  assert.equal(fake.tables.csbfp_payments.filter(x => x.registrant_id === DEE).length, 1, 'payment record kept');
  assert.equal(fake.tables.csbfp_legal_acceptances.filter(x => x.registrant_id === DEE).length, 1, 'consent record kept');
  assert.match((await browser().req('/verify?number=CSBFP-12121212')).text, /No certification was found/);
  assert.equal(mails('dee@example.com', 'data_deleted').length, 1, 'told before the address was removed');
  assert.ok(fake.tables.csbfp_admin_audit_log.some(a => a.action === 'registrant_data_deleted'));
});

test('announcements: test to self, then send to the chosen audience once', async () => {
  let r = await boss.req('/admin/announce');
  assert.match(r.text, /Active registrations only \(0\)/);
  assert.match(r.text, /Everyone who has ever been registered.*\(1\)/);
  await boss.req('/admin/announce/test', { subject: 'Training update', message: 'New module coming.', audience: 'registered' });
  assert.equal(mails('boss@example.com', 'program_update').length, 1);
  r = await boss.req('/admin/announce/send', { subject: 'Training update', message: 'New module coming.', audience: 'registered' });
  assert.match(decodeURIComponent(r.location), /Tick the confirmation/);
  r = await boss.req('/admin/announce/send', { subject: 'Training update', message: 'New **module** coming.', audience: 'registered', confirm: 'yes' });
  assert.match(decodeURIComponent(r.location), /Sending to 1 person/);
  await wait(80);
  assert.equal(mails('old@example.com', 'program_update').length, 1);
  assert.match(mails('old@example.com', 'program_update')[0], /Training update/);
});

test('reports page shows counts without personal information', async () => {
  const r = await boss.req('/admin/reports');
  assert.equal(r.status, 200);
  assert.match(r.text, /Expired<\/p><p class="stat-value">1/);
  assert.match(r.text, /\$99\.00/);
  assert.doesNotMatch(r.text, /old@example\.com/);
});

test('legal documents: publishing a new version updates the site and keeps history', async () => {
  let r = await boss.req('/admin/legal');
  assert.match(r.text, /Placeholder/);
  assert.equal((await browser().req('/legal/automatic-renewal')).location, '/legal/terms#6-certification-term-and-automatic-renewal');
  r = await boss.req('/admin/legal/terms', { body_md: '## 1. Agreement\n\nThese are the real terms.', confirm: 'yes' });
  assert.match(decodeURIComponent(r.location), /Version 2 is published/);
  r = await browser().req('/legal/terms');
  assert.match(r.text, /These are the real terms/);
  assert.doesNotMatch(r.text, /Version 2/, 'the internal version number is not shown publicly');
  r = await boss.req('/admin/legal/acknowledgments', { body_md: 'No list here', confirm: 'yes' });
  assert.match(decodeURIComponent(r.location), /statement line/);
});

test('launch checklist, and removing preview data keeps setup but clears accounts', async () => {
  let r = await boss.req('/admin/launch');
  assert.match(r.text, /Still draft or placeholder/);
  assert.match(r.text, /Remove Preview Data/);
  r = await boss.req('/admin/launch/reset', { confirm: 'yes' });
  assert.match(decodeURIComponent(r.location), /Type REMOVE PREVIEW DATA/);
  r = await boss.req('/admin/launch/reset', { confirm: 'REMOVE PREVIEW DATA' });
  assert.match(decodeURIComponent(r.location), /Removed preview data/);
  assert.equal(fake.tables.csbfp_registrants.length, 0);
  assert.equal(fake.tables.csbfp_registrations.length, 0);
  assert.equal(fake.tables.csbfp_payments.length, 0);
  assert.ok(fake.tables.csbfp_legal_documents.length >= 7, 'legal documents kept');
  assert.ok(fake.tables.csbfp_settings.length >= 1, 'settings kept');
  assert.ok(fake.tables.csbfp_admin_audit_log.some(a => a.action === 'preview_data_removed'), 'audit kept');
  assert.equal((await boss.req('/admin/registrants')).status, 200, 'admin still signed in');
});
