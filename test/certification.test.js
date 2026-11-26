/**
 * Certification lifecycle with background screening ENABLED (provider not integrated, so a reviewer records each
 * screening step): payment -> pending screening -> reviewer approves screening -> under review -> approve -> certified,
 * then suspend / reinstate / revoke, not approved, appeals, and the rules that stop shortcuts.
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
  PREVIEW_EMAILS: 'boss@example.com,ann@example.com,bo@example.com',
  POSTMARK_SERVER_TOKEN: '',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  BACKGROUND_SCREENING_ENABLED: 'true',
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


const admin = browser();
async function adminSignIn() {
  const mark = sent.length;
  await admin.req('/admin/login', { email: 'boss@example.com' });
  await admin.req('/admin/login/verify', { code: await codeFor('boss@example.com', mark) });
}
const act = (who, form) => admin.req(`/admin/registrants/${who}/decision`, form);
const msgOf = r => decodeURIComponent((r.location || '').replace(/.*\?(msg|err)=/, '').replace(/#.*/, ''));
async function payFor(email) {
  const b = await signUp(email, email === 'ann@example.com' ? '4155550901' : '4155550902');
  makeReady(email);
  await b.req('/portal/checkout', { agree_renewal: 'yes' });
  const sess = Object.values(fs.state.sessions).find(s => s.client_reference_id === regOf(email).reg.id);
  fs.completeCheckout(sess.id);
  const ret = await b.req(`/portal/checkout/return?session_id=${sess.id}`);
  return { b, ret };
}

let ann;

test('with screening enabled, payment holds the application in Pending Screening; no number is issued', async () => {
  await adminSignIn();
  const { b, ret } = await payFor('ann@example.com');
  ann = b;
  assert.match(ret.text, /Application Complete/);
  const { reg } = regOf('ann@example.com');
  assert.equal(reg.status, 'pending_screening');
  assert.ok(!reg.registration_number);
  assert.ok(reg.paid_at);
  assert.equal(reg.is_demo, false);
  const sc = fake.tables.csbfp_screenings.find(s => s.registration_id === reg.id);
  assert.equal(sc.status, 'awaiting_authorization');
  assert.equal(sc.provider, 'checkr');
  assert.ok(!('ssn' in sc) && !('report' in sc), 'no sensitive screening data stored');
  assert.match(ret.text, /href="\/portal\/background-check">Start Your Background Check/);
  const dash = await ann.req('/portal/dashboard');
  assert.doesNotMatch(dash.text, /class="tracker"/, 'no stage tracker: the step list shows progress');
  assert.match(dash.text, /href="\/portal\/background-check"/);
  await wait(30);
  assert.ok(sent.some(s => s.includes('to=ann@example.com') && s.includes('template=application_received')));
});

test('background check page: state from ZIP, exact name and email, private per-state Checkr link', async () => {
  // No link for California yet
  let page = await ann.req('/portal/background-check');
  assert.equal(page.status, 200);
  assert.match(page.text, /California/);
  assert.match(page.text, /ann@example.com/);
  assert.match(page.text, /Pat Lee/);
  assert.match(page.text, /isn't available yet/);
  assert.equal((await ann.req('/portal/background-check/go')).location, '/portal/background-check');

  // Admin sets links; a non-https link is refused and nothing is saved
  let r = await admin.req('/admin/background-checks', { link_CA: 'http://insecure.example/ca', link_TX: 'https://checkr.example/tx' });
  assert.match(msgOf(r), /need a full https/);
  r = await admin.req('/admin/background-checks', { link_CA: 'https://checkr.example/apply/ca', link_TX: 'https://checkr.example/apply/tx' });
  assert.match(msgOf(r), /2 of 51 links set/);
  assert.ok(fake.tables.csbfp_admin_audit_log.some(a => a.action === 'checkr_links_updated'));

  page = await ann.req('/portal/background-check');
  assert.match(page.text, />Go to Checkr<\/a>/);
  assert.match(page.text, /I've Completed It/);
  assert.doesNotMatch(page.text, /checkr\.example/, 'the link itself is not printed on the page');
  const go = await ann.req('/portal/background-check/go');
  assert.equal(go.location, 'https://checkr.example/apply/ca');
  const { reg } = regOf('ann@example.com');
  const sc = fake.tables.csbfp_screenings.find(s => s.registration_id === reg.id);
  assert.equal(sc.state, 'CA');
  assert.ok(sc.link_opened_at);
  assert.match((await admin.req('/admin/review')).text, /Opened Checkr link \(CA\)/);
  let dash = (await ann.req('/portal/dashboard')).text;
  assert.match(dash, /<dt>Fee<\/dt><dd><span class="dstat">Paid/);
  assert.match(dash, /<dt>Background<\/dt><dd><span class="dstat">Started/);
  assert.match(dash, /href="\/portal\/background-check">Continue/, 'they can get back to the background check');
  assert.match((await ann.req('/portal/background-check')).text, /<dt>Status<\/dt><dd>Started /);

  // Phase 1: the applicant marks the Checkr form complete (no callback from Checkr yet)
  const done = await ann.req('/portal/background-check/done', {});
  assert.equal(done.location, '/portal/dashboard');
  assert.equal(fake.tables.csbfp_screenings.find(s => s.registration_id === reg.id).status, 'in_progress');
  dash = (await ann.req('/portal/dashboard')).text;
  assert.match(dash, /<dt>Background<\/dt><dd><span class="dstat">Submitted/);
  assert.match(dash, /Submitted <span class="dhint">\(allow 1–3 days\)/);
  assert.doesNotMatch(dash, /Results usually take/);
  assert.doesNotMatch(dash, /href="\/portal\/background-check"/);
  assert.match((await ann.req('/portal/background-check')).text, /marked your background check complete/);

  // Not available to anyone who isn't a paid applicant waiting on the check, and never public
  assert.equal((await browser().req('/portal/background-check')).status, 303);
});

test('reminder email 3 days after payment if the Checkr link was never opened (once)', async () => {
  const jobs = require('../lib/jobs');
  const fresh = { id: 'sc-old', registrant_id: regOf('ann@example.com').r.id, registration_id: regOf('ann@example.com').reg.id,
    status: 'awaiting_authorization', created_at: new Date(Date.now() - 4 * 864e5).toISOString(), link_opened_at: null };
  fake.tables.csbfp_screenings.push(fresh);
  const before = sent.filter(s => s.includes('template=background_check_reminder')).length;
  await jobs.runTasks(new Date());
  await jobs.runTasks(new Date());
  const after = sent.filter(s => s.includes('template=background_check_reminder')).length;
  assert.equal(after - before, 1);
  fake.tables.csbfp_screenings = fake.tables.csbfp_screenings.filter(s => s.id !== 'sc-old');
});

test('an application cannot be approved before a reviewer approves the screening', async () => {
  const { r, reg } = regOf('ann@example.com');
  let res = await act(r.id, { action: 'approve', reason: 'looks fine' });
  assert.match(msgOf(res), /not allowed|Only applications under review/);
  assert.equal(regOf('ann@example.com').reg.status, 'pending_screening');
  res = await admin.req(`/admin/registrants/${r.id}/screening`, { status: 'approved', reason: '' });
  assert.match(msgOf(res), /note is required/);
  res = await admin.req(`/admin/registrants/${r.id}/screening`, { status: 'review_required', reason: 'Possible record; checking identity match' });
  assert.equal(fake.tables.csbfp_screenings.find(s => s.registration_id === reg.id).status, 'review_required');
  assert.equal(regOf('ann@example.com').reg.status, 'pending_screening', 'a screening flag decides nothing by itself');
});

test('reviewer approves screening -> Under Review -> approval issues the permanent number and starts the term', async () => {
  const { r, reg } = regOf('ann@example.com');
  await admin.req(`/admin/registrants/${r.id}/screening`, { status: 'approved', reason: 'No disqualifying records after review' });
  const sc = fake.tables.csbfp_screenings.find(s => s.registration_id === reg.id);
  assert.equal(sc.decision, 'approved');
  assert.ok(sc.reviewer_id);
  assert.equal(regOf('ann@example.com').reg.status, 'under_review');
  assert.match((await admin.req('/admin/review')).text, /Under Review/);

  const res = await act(r.id, { action: 'approve', reason: 'All initial requirements met' });
  assert.match(msgOf(res), /Certification issued/);
  const after = regOf('ann@example.com').reg;
  assert.equal(after.status, 'active');
  assert.match(after.registration_number, /^CSBFP-\d{8}$/);
  assert.equal(after.is_demo, false);
  assert.ok(after.approved_at && after.approved_by);
  const days = (Date.parse(after.expires_at) - Date.now()) / 864e5;
  assert.ok(days > 364 && days < 366, 'term starts on approval');
  const v = await ann.req(`/verify?number=${after.registration_number}`);
  assert.match(v.text, /verify-status ok[^]*Certified/);
  assert.doesNotMatch(v.text, /DEMO/);
  assert.ok(fake.tables.csbfp_admin_audit_log.some(a => a.action === 'certification_approve'));
});

test('suspend needs a reason and evidence; public lookup shows Suspended without the reason', async () => {
  const { r } = regOf('ann@example.com');
  let res = await act(r.id, { action: 'suspend', reason: 'Complaint received' });
  assert.match(msgOf(res), /evidence or case reference is required/);
  res = await act(r.id, { action: 'suspend', reason: 'Complaint received about misrepresentation', evidence_ref: 'CASE-1001', effective_date: '2026-12-01' });
  assert.match(msgOf(res), /suspended/);
  const reg = regOf('ann@example.com').reg;
  assert.equal(reg.status, 'suspended');
  const h = fake.tables.csbfp_registration_status_history.at(-1);
  assert.equal(h.evidence_ref, 'CASE-1001');
  assert.equal(h.actor_type, 'admin');
  assert.match(h.effective_at, /^2026-12-01/);
  const v = await ann.req(`/verify?number=${reg.registration_number}`);
  assert.match(v.text, /Suspended/);
  assert.doesNotMatch(v.text, /misrepresentation|CASE-1001/);
});

test('a renewal payment while suspended extends the date but does not lift the suspension', async () => {
  const sub = Object.values(fs.state.subscriptions).find(s => s.metadata.registration_id === regOf('ann@example.com').reg.id);
  const inv = fs.renew(sub.id, { paid: true });
  await webhook('invoice.paid', inv);
  assert.equal(regOf('ann@example.com').reg.status, 'suspended');
});

test('reinstate returns to Certified; revoke needs REVOKE, stops renewal, and is final for non-admins', async () => {
  const { r } = regOf('ann@example.com');
  await act(r.id, { action: 'reinstate', reason: 'Complaint not substantiated' });
  assert.equal(regOf('ann@example.com').reg.status, 'active');
  let res = await act(r.id, { action: 'revoke', reason: 'Fraud finding', evidence_ref: 'CASE-1002' });
  assert.match(msgOf(res), /Type REVOKE/);
  res = await act(r.id, { action: 'revoke', reason: 'Fraud finding', evidence_ref: 'CASE-1002', confirm: 'REVOKE' });
  const reg = regOf('ann@example.com').reg;
  assert.equal(reg.status, 'revoked');
  const sub = Object.values(fs.state.subscriptions).find(s => s.metadata.registration_id === reg.id);
  assert.equal(sub.status, 'canceled', 'automatic renewal stopped');
  assert.match((await ann.req(`/verify?number=${reg.registration_number}`)).text, /Revoked/);
  // A late payment event cannot reactivate a revoked certification.
  const inv = fs.renew(sub.id, { paid: true });
  await webhook('invoice.paid', inv);
  assert.equal(regOf('ann@example.com').reg.status, 'revoked');
  const number = reg.registration_number;
  assert.equal(regOf('ann@example.com').reg.registration_number, number, 'number is never reassigned');
});

test('not approved, then an appeal and reconsideration', async () => {
  await payFor('bo@example.com');
  const { r, reg } = regOf('bo@example.com');
  assert.equal(reg.status, 'pending_screening');
  await act(r.id, { action: 'not_approve', reason: 'Disqualifying fraud conviction confirmed by reviewer', evidence_ref: 'CASE-2001' });
  assert.equal(regOf('bo@example.com').reg.status, 'not_approved');
  assert.match((await browser().req('/verify?number=CSBFP-00000000')).text, /No certification was found/);
  await admin.req(`/admin/registrants/${r.id}/appeals`, { kind: 'dispute', subject: 'screening', statement: 'The record belongs to someone else.' });
  const appeal = fake.tables.csbfp_appeals.find(a => a.registrant_id === r.id);
  assert.equal(appeal.status, 'open');
  assert.equal(fake.tables.csbfp_screenings.find(s => s.registration_id === reg.id).status, 'disputed');
  assert.match((await admin.req('/admin/review')).text, /dispute/);
  await admin.req(`/admin/appeals/${appeal.id}`, { status: 'reversed', decision_note: 'Identity mismatch confirmed' });
  assert.equal(fake.tables.csbfp_appeals.find(a => a.id === appeal.id).decided_by != null, true);
  await act(r.id, { action: 'send_to_review', reason: 'Reconsideration after dispute' });
  assert.equal(regOf('bo@example.com').reg.status, 'under_review');
});

test('only an admin can make adverse or reviewer decisions (database rules)', async () => {
  const { transitionAllowed } = require('./fake-supabase');
  assert.equal(transitionAllowed('active', 'revoked', 'stripe'), false);
  assert.equal(transitionAllowed('active', 'suspended', 'system'), false);
  assert.equal(transitionAllowed('revoked', 'active', 'stripe'), false);
  assert.equal(transitionAllowed('pending', 'active', 'stripe'), true);
  assert.equal(transitionAllowed('pending_screening', 'active', 'admin'), false, 'no skipping review');
  const screening = require('../lib/screening');
  await assert.rejects(screening.setStatus({ id: 'x', status: 'review_required' }, 'approved', { actorType: 'provider' }), /authorized reviewer/);
});
