/**
 * End-to-end tests for step 3 (admin area), against the in-memory stand-in.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
  NODE_ENV: 'test',
  SUPABASE_URL: 'http://fake.local',
  SUPABASE_SERVICE_KEY: 'fake',
  JWT_SECRET: 'y'.repeat(40),
  FIELD_ENCRYPTION_KEY: 'test-encryption-key-that-is-long-enough-1234',
  FIELD_HASH_KEY: 'test-hash-key-that-is-long-enough-and-different',
  PRE_LAUNCH: 'true',
  ADMIN_EMAILS: 'boss@example.com',
  PREVIEW_EMAILS: 'boss@example.com,jane@example.com,jake@example.com',
  POSTMARK_SERVER_TOKEN: '',
});

const { createFake } = require('./fake-supabase');
const supa = require('../lib/supabase');
const { encrypt, blindIndex } = require('../lib/crypto');
const config = require('../lib/config');

const docs = ['terms', 'privacy', 'registration_agreement', 'automatic_renewal', 'disclaimer'].map(key => ({ key, version: 1, body_md: 'x', status: 'published' }));
docs.push({ key: 'acknowledgments', version: 1, status: 'published', body_md: '- One.' });

const JANE = '11111111-1111-4111-8111-111111111111';
const JAKE = '22222222-2222-4222-8222-222222222222';
const fake = createFake({
  csbfp_legal_documents: docs,
  csbfp_job_titles: [{ id: 1, label: 'Sales Representative', position: 1, active: true }, { id: 2, label: 'Other', position: 2, active: true }],
  csbfp_financing_products: [{ id: 1, label: 'MCA', position: 1, active: true }],
  csbfp_registrants: [
    { id: JANE, email: 'jane@example.com', email_verified_at: '2026-11-01T00:00:00Z', account_status: 'active', legal_first_name: 'Jane', legal_last_name: 'Smith',
      dob_enc: encrypt('1990-05-17'), dob_hash: blindIndex('dob:1990-05-17'), zip5: '94105', phone_e164: '+14155551212', created_at: '2026-11-01T00:00:00Z' },
    { id: JAKE, email: 'jake@example.com', email_verified_at: '2026-11-02T00:00:00Z', account_status: 'active', legal_first_name: 'Jake', legal_last_name: 'Jones',
      zip5: '10001', phone_e164: '+12125550000', created_at: '2026-11-02T00:00:00Z' },
  ],
  csbfp_registrations: [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', registrant_id: JANE, status: 'active', registration_number: 'CSBFP-48213907', admin_hold: false },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', registrant_id: JAKE, status: 'pending', admin_hold: false },
  ],
  csbfp_duplicate_flags: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', registrant_id: JAKE, matched_registrant_id: JANE, match_reason: 'phone', status: 'open' }],
});
supa.db.set(fake);

const sent = [];
const origLog = console.log;
console.log = (...args) => { const s = args.join(' '); if (s.includes('[email]')) sent.push(s); else origLog(...args); };

const app = require('../server');
let base;
let server;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { console.log = origLog; server.close(); });

function browser() {
  const jar = {};
  return {
    async req(path, form) {
      const headers = { cookie: Object.entries(jar).map(([k, val]) => `${k}=${val}`).join('; ') };
      let body;
      if (form) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(form).toString();
      }
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
  return null;
}

async function adminBrowser() {
  const b = browser();
  const mark = sent.length;
  const r = await b.req('/admin/login', { email: 'boss@example.com' });
  assert.equal(r.location, '/admin/login/verify');
  const code = await codeFor('boss@example.com', mark);
  assert.ok(code, 'admin code emailed');
  const v = await b.req('/admin/login/verify', { code });
  assert.equal(v.location, '/admin/registrants');
  return b;
}

let boss;

test('admin pages require an admin sign-in', async () => {
  for (const p of ['/admin', '/admin/registrants', `/admin/registrants/${JANE}`, '/admin/duplicates', '/admin/lists', '/admin/audit']) {
    const r = await browser().req(p);
    assert.equal(r.status, 303, p);
    assert.equal(r.location, '/admin/login', p);
  }
});

test('emails not on ADMIN_EMAILS never get a code, and the screen is the same', async () => {
  const mark = sent.length;
  const r = await browser().req('/admin/login', { email: 'jane@example.com' });
  assert.equal(r.location, '/admin/login/verify');
  await wait(80);
  assert.equal(sent.slice(mark).length, 0);
  assert.equal((fake.tables.csbfp_admin_users || []).length, 0);
});

test('a registrant session does not open the admin area', async () => {
  const b = browser();
  const mark = sent.length;
  await b.req('/portal', { email: 'jane@example.com' });
  const code = await codeFor('jane@example.com', mark);
  await b.req('/portal/verify', { code });
  assert.equal((await b.req('/portal/account')).status, 200);
  assert.equal((await b.req('/admin/registrants')).location, '/admin/login');
});

test('admin signs in with an emailed code; the sign-in is audited', async () => {
  boss = await adminBrowser();
  const page = await boss.req('/admin/registrants');
  assert.equal(page.status, 200);
  assert.match(page.text, /Jane Smith/);
  assert.match(page.text, /Jake Jones/);
  assert.ok(fake.tables.csbfp_admin_audit_log.some(a => a.action === 'admin_login'));
});

test('search by name, email and registration number', async () => {
  let r = await boss.req('/admin/registrants?q=smith');
  assert.match(r.text, /Jane Smith/);
  assert.doesNotMatch(r.text, /Jake Jones/);
  r = await boss.req('/admin/registrants?q=jake%40example');
  assert.match(r.text, /Jake Jones/);
  assert.doesNotMatch(r.text, /Jane Smith/);
  r = await boss.req('/admin/registrants?q=CSBFP-48213907');
  assert.match(r.text, /Jane Smith/);
  r = await boss.req('/admin/registrants?q=48213907');
  assert.match(r.text, /Jane Smith/);
  r = await boss.req('/admin/registrants?q=jane%20smith');
  assert.match(r.text, /Jane Smith/);
  r = await boss.req('/admin/registrants?q=nobody');
  assert.match(r.text, /No registrants found/);
});

test('registrant page shows details with DOB masked; revealing it is logged and never in a URL', async () => {
  let r = await boss.req(`/admin/registrants/${JANE}`);
  assert.equal(r.status, 200);
  assert.match(r.text, /On file \(age \d+\)/);
  assert.doesNotMatch(r.text, /1990/);
  assert.match(r.text, /CSBFP-48213907/);
  assert.match(r.text, /This account is not blocked/, 'the matched (older) account is not the blocked one');
  assert.doesNotMatch(r.text, /this account's payment is blocked/);
  assert.match((await boss.req(`/admin/registrants/${JAKE}`)).text, /this account's payment is blocked/);
  r = await boss.req(`/admin/registrants/${JANE}/reveal-dob`, {});
  assert.equal(r.status, 200, 'rendered directly, not redirected');
  assert.match(r.text, /05\/17\/1990/);
  assert.ok(fake.tables.csbfp_admin_audit_log.some(a => a.action === 'dob_viewed' && a.target_id === JANE));
});

test('corrections need a reason, are applied, and are audited by field name only', async () => {
  let r = await boss.req(`/admin/registrants/${JANE}/edit`, { legal_first_name: 'Janet', legal_last_name: 'Smith', zip5: '94105', reason: '' });
  assert.match(decodeURIComponent(r.location), /reason is required/);
  assert.equal(fake.tables.csbfp_registrants.find(x => x.id === JANE).legal_first_name, 'Jane');

  r = await boss.req(`/admin/registrants/${JANE}/edit`, { legal_first_name: 'Janet', middle_name: '', legal_last_name: 'Smith', zip5: '94105', phone: '(415) 555-1212',
    email: 'jane@example.com', dob: '1990-05-18', reason: 'Registrant emailed a correction' });
  assert.match(decodeURIComponent(r.location), /Saved: legal_first_name, dob/);
  const jane = fake.tables.csbfp_registrants.find(x => x.id === JANE);
  assert.equal(jane.legal_first_name, 'Janet');
  assert.equal(jane.dob_hash, blindIndex('dob:1990-05-18'));
  const entry = fake.tables.csbfp_admin_audit_log.find(a => a.action === 'registrant_edited');
  assert.deepEqual(entry.detail.fields, ['legal_first_name', 'dob']);
  assert.equal(entry.reason, 'Registrant emailed a correction');
  assert.doesNotMatch(JSON.stringify(fake.tables.csbfp_admin_audit_log), /1990/);

  r = await boss.req(`/admin/registrants/${JANE}/edit`, { email: 'jake@example.com', legal_first_name: 'Janet', legal_last_name: 'Smith', reason: 'test' });
  assert.match(decodeURIComponent(r.location), /already uses that email/);
});

test('hold: placed and released with reasons, recorded in status history', async () => {
  let r = await boss.req(`/admin/registrants/${JANE}/hold`, { action: 'place', reason: '' });
  assert.match(decodeURIComponent(r.location), /reason is required/);
  r = await boss.req(`/admin/registrants/${JANE}/hold`, { action: 'place', reason: 'Checking identity' });
  const reg = fake.tables.csbfp_registrations.find(x => x.registrant_id === JANE);
  assert.equal(reg.admin_hold, true);
  assert.equal(reg.status, 'active', 'status itself unchanged');
  assert.match((await boss.req(`/admin/registrants/${JANE}`)).text, /On hold/);
  await boss.req(`/admin/registrants/${JANE}/hold`, { action: 'release', reason: 'Confirmed' });
  assert.equal(fake.tables.csbfp_registrations.find(x => x.registrant_id === JANE).admin_hold, false);
  const hist = fake.tables.csbfp_registration_status_history.filter(h => h.registration_id === reg.id).map(h => h.hold_change);
  assert.deepEqual(hist, ['placed', 'released']);
});

test('locking an account ends the registrant\'s access at once', async () => {
  const jake = browser();
  const mark = sent.length;
  await jake.req('/portal', { email: 'jake@example.com' });
  await jake.req('/portal/verify', { code: await codeFor('jake@example.com', mark) });
  const acct = await jake.req('/portal/account');
  assert.equal(acct.status, 200);
  assert.match(acct.text, /Edit your application/);
  const bill = await jake.req('/portal/billing');
  assert.ok([200, 302, 303].includes(bill.status), 'billing page works before payment');
  for (const path of ['personal', 'employment', 'products', 'billing']) assert.match(acct.text, new RegExp(`href="/portal/${path}"`));

  await boss.req(`/admin/registrants/${JAKE}/lock`, { action: 'lock', reason: 'Suspicious sign-ups' });
  assert.equal(fake.tables.csbfp_registrants.find(x => x.id === JAKE).account_status, 'locked');
  assert.equal((await jake.req('/portal/dashboard')).location, '/portal');

  await boss.req(`/admin/registrants/${JAKE}/lock`, { action: 'unlock', reason: 'Cleared' });
  assert.equal(fake.tables.csbfp_registrants.find(x => x.id === JAKE).account_status, 'active');
});

test('duplicate flags: listed, need an outcome and a note, then leave the open list', async () => {
  let r = await boss.req('/admin/duplicates');
  assert.match(r.text, /Same mobile number/);
  assert.match(r.text, /Jake Jones/);
  const flagId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  r = await boss.req(`/admin/duplicates/${flagId}`, { outcome: 'different_people', note: '' });
  assert.equal(fake.tables.csbfp_duplicate_flags.find(f => f.id === flagId).status, 'open');
  await boss.req(`/admin/duplicates/${flagId}`, { outcome: 'different_people', note: 'Shared family phone; different people' });
  const flag = fake.tables.csbfp_duplicate_flags.find(f => f.id === flagId);
  assert.equal(flag.status, 'dismissed');
  assert.ok(flag.reviewed_by);
  assert.match((await boss.req('/admin/duplicates')).text, /Nothing here/);
});

test('lists: add, rename, hide; hidden items leave the products form', async () => {
  await boss.req('/admin/lists/products', { label: 'SBA Loans' });
  const added = fake.tables.csbfp_financing_products.find(t => t.label === 'SBA Loans');
  assert.ok(added);
  let r = await boss.req('/admin/lists/products', { label: 'SBA Loans' });
  assert.match(decodeURIComponent(r.location), /already exists/);
  await boss.req('/admin/lists/products/1', { label: 'Merchant Cash Advances', position: '1', active: 'yes' });
  assert.equal(fake.tables.csbfp_financing_products.find(t => t.id === 1).label, 'Merchant Cash Advances');
  await boss.req(`/admin/lists/products/${added.id}`, { label: 'SBA Loans', position: '3' }); // unchecked = hidden
  assert.equal(fake.tables.csbfp_financing_products.find(t => t.id === added.id).active, false);

  const jake = browser();
  const mark = sent.length;
  await jake.req('/portal', { email: 'jake@example.com' });
  await jake.req('/portal/verify', { code: await codeFor('jake@example.com', mark) });
  r = await jake.req('/portal/products');
  assert.match(r.text, /Merchant Cash Advances/);
  assert.doesNotMatch(r.text, /SBA Loans/);
});


test('audit log lists admin actions with reasons', async () => {
  const r = await boss.req('/admin/audit');
  for (const s of ['admin login', 'dob viewed', 'registrant edited', 'hold placed', 'account locked', 'duplicate resolved', 'list item added']) {
    assert.match(r.text, new RegExp(s), s);
  }
  assert.match(r.text, /Registrant emailed a correction/);
});

test('removing an admin from ADMIN_EMAILS ends their access immediately', async () => {
  const saved = config.adminEmails.slice();
  config.adminEmails.length = 0;
  try {
    assert.equal((await boss.req('/admin/registrants')).location, '/admin/login');
  } finally {
    config.adminEmails.push(...saved);
  }
});
