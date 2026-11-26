/**
 * Tests for steps 8-9: editable email templates, lifecycle emails, the daily job, Postmark tracking, email change.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
  NODE_ENV: 'test', SITE_URL: 'https://csbfp-certification.org', SUPABASE_URL: 'http://fake.local', SUPABASE_SERVICE_KEY: 'fake',
  JWT_SECRET: 'e'.repeat(40), FIELD_ENCRYPTION_KEY: 'test-encryption-key-that-is-long-enough-1234',
  FIELD_HASH_KEY: 'test-hash-key-that-is-long-enough-and-different', PRE_LAUNCH: 'true', ADMIN_EMAILS: 'boss@example.com',
  PREVIEW_EMAILS: 'boss@example.com,ann@example.com', POSTMARK_SERVER_TOKEN: '', STRIPE_SECRET_KEY: 'sk_test_fake',
});

const { createFake } = require('./fake-supabase');
const { createFakeStripe } = require('./fake-stripe');
const supa = require('../lib/supabase');
const S = require('../lib/stripe');
const { encrypt } = require('../lib/crypto');
const jobs = require('../lib/jobs');

const DAY = 864e5;
const iso = ms => new Date(ms).toISOString();
const docs = ['terms', 'privacy', 'registration_agreement', 'automatic_renewal', 'disclaimer', 'acknowledgments']
  .map(key => ({ key, version: 1, body_md: '- x', status: 'published' }));
const reg = (id, rid, status, expiresIn, extra = {}) => ({ id, registrant_id: rid, registration_number: `CSBFP-0000000${id.slice(-1)}`, status, admin_hold: false,
  expires_at: iso(Date.now() + expiresIn), first_activated_at: iso(Date.now() - 300 * DAY), ...extra });
const person = (id, first) => ({ id, email: `${first.toLowerCase()}@example.com`, email_verified_at: iso(Date.now()), account_status: 'active', legal_first_name: first });
const sub = (id, rid, gid, cancel, status = 'active') => ({ id: `s-${id}`, registrant_id: rid, registration_id: gid, stripe_customer_id: 'cus_x', stripe_subscription_id: id,
  stripe_status: status, cancel_at_period_end: cancel, created_at: iso(Date.now() - 300 * DAY) });

const fake = createFake({
  csbfp_legal_documents: docs,
  csbfp_registrants: [person('p1', 'Rita'), person('p2', 'Carl'), person('p3', 'Ed'), person('p4', 'Fay'), person('p5', 'Gus'), person('p6', 'Ann')],
  csbfp_registrations: [
    reg('g1', 'p1', 'active', 20 * DAY),                       // renews in 20 days -> reminder
    reg('g2', 'p2', 'active', 20 * DAY),                       // canceled auto-renewal -> no reminder
    reg('g3', 'p3', 'active', -1 * DAY),                       // canceled and past date -> expire
    reg('g4', 'p4', 'active', -1 * DAY),                       // auto-renew on, 1 day over -> leave for Stripe
    reg('g5', 'p5', 'inactive', -5 * DAY),                     // failed renewal 4 days ago -> payment reminder
    reg('g6', 'p6', 'pending', 0, { registration_number: null, expires_at: null, first_activated_at: null }),
  ],
  csbfp_subscriptions: [sub('sub_1', 'p1', 'g1', false), sub('sub_2', 'p2', 'g2', true), sub('sub_3', 'p3', 'g3', true), sub('sub_4', 'p4', 'g4', false), sub('sub_5', 'p5', 'g5', false, 'past_due')],
  csbfp_payments: [{ id: 'pay5', registrant_id: 'p5', registration_id: 'g5', stripe_invoice_id: 'in_failed_5', status: 'failed', billing_reason: 'renewal', amount_cents: 9900, created_at: iso(Date.now() - 4 * DAY) }],
  csbfp_settings: [{ key: 'stripe_test_price_id', value: 'price_x' }, { key: 'stripe_test_portal_configuration_id', value: 'bpc_x' }, { key: 'stripe_test_webhook_secret', value: encrypt('whsec_e') },
    { key: 'postmark_webhook_token', value: encrypt('pm-token-123') }],
});
supa.db.set(fake);
const fs = createFakeStripe();
S.stripe.set(fs);

const sent = [];
const origLog = console.log;
console.log = (...args) => { const s = args.join(' '); if (s.includes('[email]')) sent.push(s); else origLog(...args); };
const app = require('../server');
let base; let server;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { console.log = origLog; server.close(); });

const mails = (to, tpl) => sent.filter(s => s.includes(`to=${to}`) && (!tpl || s.includes(`template=${tpl}`)));
const wait = ms => new Promise(r => setTimeout(r, ms));
function browser() {
  const jar = {};
  return {
    async req(path, form) {
      const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
      let body;
      if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
      const res = await fetch(base + path, { method: form ? 'POST' : 'GET', headers, body, redirect: 'manual' });
      for (const c of res.headers.getSetCookie()) { const [k, ...v] = c.split(';')[0].split('='); if (/Expires=Thu, 01 Jan 1970/.test(c) || v.join('=') === '') delete jar[k]; else jar[k] = v.join('='); }
      return { status: res.status, location: res.headers.get('location'), text: await res.text(), headers: res.headers };
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

test('daily job: reminders, expiry, payment reminders; running again sends nothing twice', async () => {
  const r1 = await jobs.runTasks(new Date());
  assert.equal(r1.renewal_reminders.reminded, 1);
  assert.equal(mails('rita@example.com', 'renewal_reminder').length, 1);
  assert.match(mails('rita@example.com', 'renewal_reminder')[0], /renews automatically on/);
  assert.equal(mails('carl@example.com').length, 0, 'auto-renewal canceled: no reminder');

  assert.equal(fake.tables.csbfp_registrations.find(r => r.id === 'g3').status, 'expired');
  assert.equal(mails('ed@example.com', 'registration_expired').length, 1);
  assert.equal(fake.tables.csbfp_registrations.find(r => r.id === 'g4').status, 'active', 'auto-renewing: left for Stripe');
  assert.equal(mails('fay@example.com').length, 0);
  assert.equal(mails('gus@example.com', 'payment_method_reminder').length, 1);

  const summary = mails('boss@example.com', 'admin_daily_summary');
  assert.equal(summary.length, 1, 'one daily summary to the admin');
  assert.match(summary[0], /Certified: \d+/);
  assert.equal(r1.admin_summary.sent, 1);

  await jobs.runTasks(new Date());
  assert.equal(mails('rita@example.com').length, 1);
  assert.equal(mails('ed@example.com').length, 1);
  assert.equal(mails('gus@example.com').length, 1);
  assert.equal(mails('boss@example.com', 'admin_daily_summary').length, 1, 'summary not sent twice on the same day');
});

test('daily job: an overdue auto-renewal is re-checked with Stripe (failed -> Inactive)', async () => {
  const g4 = fake.tables.csbfp_registrations.find(r => r.id === 'g4');
  g4.expires_at = iso(Date.now() - 3 * DAY);
  const now = Math.floor(Date.now() / 1000);
  fs.state.subscriptions.sub_4 = { id: 'sub_4', status: 'past_due', customer: 'cus_x', metadata: { app: 'csbfp', registration_id: 'g4' }, cancel_at_period_end: false,
    items: { data: [{ current_period_start: now - 3 * 86400, current_period_end: now + 362 * 86400 }] }, latest_invoice: 'in_4' };
  fs.state.invoices.in_4 = { id: 'in_4', status: 'open', attempt_count: 1, billing_reason: 'subscription_cycle', amount_due: 9900, created: now,
    parent: { subscription_details: { subscription: 'sub_4' } }, lines: { data: [{ period: { start: now - 3 * 86400, end: now + 362 * 86400 } }] }, hosted_invoice_url: 'https://invoice.stripe.com/i/4' };
  await jobs.runTasks(new Date());
  assert.equal(g4.status, 'inactive');
  assert.equal(mails('fay@example.com', 'renewal_failed').length, 1);
});

test('the daily job runs once per Pacific day, after 6 AM', async () => {
  const early = new Date('2026-12-01T12:00:00Z'); // 4 AM Pacific
  const later = new Date('2026-12-01T16:00:00Z'); // 8 AM Pacific
  assert.equal(await jobs.runIfDue(early), null);
  assert.ok(await jobs.runIfDue(later));
  assert.equal(await jobs.runIfDue(new Date('2026-12-01T20:00:00Z')), null, 'already ran today');
  assert.equal(fake.tables.csbfp_job_runs.filter(r => r.run_date === '2026-12-01').length, 1);
});

test('renewal webhooks send the receipt, the failure notice and the cancellation notice', async () => {
  const { notify } = require('../lib/billing');
  const g1 = fake.tables.csbfp_registrations.find(r => r.id === 'g1');
  await notify(g1, 'renewal_succeeded', 'renewal_paid:in_test', { receipt_url: 'https://invoice.stripe.com/i/abc' });
  assert.match(mails('rita@example.com', 'renewal_succeeded')[0], /invoice\.stripe\.com\/i\/abc/);
  // Cancel through the billing page path: subscription upsert sees the change and emails once.
  const now = Math.floor(Date.now() / 1000);
  fs.state.subscriptions.sub_1 = { id: 'sub_1', status: 'active', customer: 'cus_x', metadata: { app: 'csbfp', registration_id: 'g1' }, cancel_at_period_end: false,
    items: { data: [{ current_period_start: now - 345 * 86400, current_period_end: now + 20 * 86400 }] } };
  const billing = require('../lib/billing');
  await billing.setAutoRenew('p1', false);
  await billing.setAutoRenew('p1', true);
  await billing.setAutoRenew('p1', false);
  assert.equal(mails('rita@example.com', 'auto_renewal_canceled').length, 1, 'one notice per period');
});

let boss;
test('admin can reword an email; new emails use it; restoring brings the default back', async () => {
  boss = browser();
  const mark = sent.length;
  await boss.req('/admin/login', { email: 'boss@example.com' });
  await boss.req('/admin/login/verify', { code: await codeFor('boss@example.com', mark) });
  let r = await boss.req('/admin/emails');
  assert.match(r.text, /Renewal reminder \(30 days\)/);
  r = await boss.req('/admin/emails/t/renewal_reminder/preview');
  assert.match(r.text, /November 21, 2027/);
  assert.match(r.headers.get('content-security-policy'), /unsafe-inline/);
  r = await boss.req('/admin/emails/t/sign_in_code', { subject: 'Code', body_md: '# Hi\n\nNo code here' });
  assert.match(decodeURIComponent(r.location), /must keep the \{\{code\}\} line/);
  await boss.req('/admin/emails/t/welcome', { subject: 'Welcome aboard, {{first_name}}', body_md: '# Hello\n\nCustom welcome text.' });
  const { renderEmail } = require('../lib/email');
  let out = await renderEmail('welcome', { first_name: 'Zoe' });
  assert.equal(out.subject, 'Welcome aboard, Zoe');
  assert.match(out.text, /Custom welcome text/);
  assert.equal(out.version, 1);
  await boss.req('/admin/emails/t/welcome/reset', {});
  out = await renderEmail('welcome', { first_name: 'Zoe' });
  assert.equal(out.subject, 'Your CSBFP account is ready');
  r = await boss.req('/admin/emails/t/welcome/test', {});
  assert.match(decodeURIComponent(r.location), /Test sent/);
  assert.ok(fake.tables.csbfp_admin_audit_log.some(a => a.action === 'email_template_updated'));
});

test('Postmark webhooks need the token and update delivery status', async () => {
  fake.tables.csbfp_email_messages.push({ id: 'm1', dedupe_key: 'x1', template_key: 'welcome', to_email: 'a@b.com', status: 'sent', postmark_message_id: 'pm-1' },
    { id: 'm2', dedupe_key: 'x2', template_key: 'welcome', to_email: 'c@d.com', status: 'sent', postmark_message_id: 'pm-2' });
  const post = (token, body) => fetch(`${base}/webhooks/postmark?token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('wrong', { RecordType: 'Delivery', MessageID: 'pm-1' })).status, 401);
  // Postmark's verification of a new webhook: an empty POST and a GET both succeed with the right token.
  assert.equal((await fetch(`${base}/webhooks/postmark?token=pm-token-123`, { method: 'POST' })).status, 200);
  assert.equal((await fetch(`${base}/webhooks/postmark?token=pm-token-123`)).status, 200);
  assert.equal((await fetch(`${base}/webhooks/postmark?token=nope`)).status, 401);
  assert.equal((await post('pm-token-123', { RecordType: 'Delivery', MessageID: 'pm-1' })).status, 200);
  await post('pm-token-123', { RecordType: 'Bounce', MessageID: 'pm-2', Type: 'HardBounce', Description: 'Mailbox does not exist' });
  await post('pm-token-123', { RecordType: 'Delivery', MessageID: 'pm-2' });
  assert.equal(fake.tables.csbfp_email_messages.find(m => m.id === 'm1').status, 'delivered');
  const m2 = fake.tables.csbfp_email_messages.find(m => m.id === 'm2');
  assert.equal(m2.status, 'bounced', 'a later delivery report never hides a bounce');
  assert.match(m2.error, /HardBounce/);
  const r = await boss.req('/admin/emails/log?status=bounced');
  assert.match(r.text, /Mailbox does not exist/);
});

test('changing email: code to the new address, old address notified, sign-in moves over', async () => {
  const ann = browser();
  let mark = sent.length;
  await ann.req('/portal', { email: 'ann@example.com' });
  await ann.req('/portal/verify', { code: await codeFor('ann@example.com', mark) });
  let r = await ann.req('/portal/account/email', { new_email: 'rita@example.com' });
  assert.match(r.text, /can&#39;t be used/);
  mark = sent.length;
  r = await ann.req('/portal/account/email', { new_email: 'ann.new@example.com' });
  assert.equal(r.location, '/portal/account/email/verify');
  const code = await codeFor('ann.new@example.com', mark);
  r = await ann.req('/portal/account/email/verify', { code: code === '000000' ? '111111' : '000000' });
  assert.equal(r.status, 401);
  r = await ann.req('/portal/account/email/verify', { code });
  assert.match(decodeURIComponent(r.location), /has been changed/);
  assert.equal(fake.tables.csbfp_registrants.find(x => x.id === 'p6').email, 'ann.new@example.com');
  await wait(50);
  assert.equal(mails('ann@example.com', 'email_changed').length, 1);
  assert.match(mails('ann@example.com', 'email_changed')[0], /ann\.new@example\.com/);
});

test('active registrants get an "information updated" email, at most once a day', async () => {
  const rita = browser();
  const mark = sent.length;
  process.env.PREVIEW_EMAILS += ',rita@example.com';
  require('../lib/config').previewEmails.push('rita@example.com');
  await rita.req('/portal', { email: 'rita@example.com' });
  await rita.req('/portal/verify', { code: await codeFor('rita@example.com', mark) });
  fake.tables.csbfp_financing_products = [{ id: 1, label: 'MCA', position: 1, active: true }];
  await rita.req('/portal/products', { products: '1' });
  await rita.req('/portal/products', { products: '1', products_other: 'Equipment leases' });
  await wait(50);
  assert.equal(mails('rita@example.com', 'registration_info_updated').length, 1);
  Object.assign(fake.tables.csbfp_registrants.find(x => x.email === 'rita@example.com'), { legal_first_name: 'Rita', legal_last_name: 'Lee', dob_hash: 'h', zip5: '94105', industry_start_month: '2020-01-01', phone_e164: '+14155550199' });
  const dash = await rita.req('/portal/dashboard');
  assert.match(dash.text, /Annual review/);
  await rita.req('/portal/confirm-info', {});
  assert.doesNotMatch((await rita.req('/portal/dashboard')).text, /Annual review/);
});
