/**
 * End-to-end tests for step 2 (accounts and registration information), against the in-memory stand-in.
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
  NODE_ENV: 'test',
  SUPABASE_URL: 'http://fake.local',
  SUPABASE_SERVICE_KEY: 'fake',
  JWT_SECRET: 'x'.repeat(40),
  FIELD_ENCRYPTION_KEY: 'test-encryption-key-that-is-long-enough-1234',
  FIELD_HASH_KEY: 'test-hash-key-that-is-long-enough-and-different',
  PRE_LAUNCH: 'true',
  PREVIEW_EMAILS: 'jane@example.com,john@example.com,dupe@example.com',
  POSTMARK_SERVER_TOKEN: '',
});

const { createFake } = require('./fake-supabase');
const supa = require('../lib/supabase');

const LEGAL = ['terms', 'privacy', 'registration_agreement', 'automatic_renewal', 'disclaimer'].map(key => ({
  id: key, key, version: 1, title: key, body_md: 'Placeholder.', status: 'published', published_at: new Date().toISOString(),
}));
LEGAL.push({ id: 'ack', key: 'acknowledgments', version: 1, title: 'Acknowledgments', status: 'published', published_at: new Date().toISOString(),
  body_md: 'By confirming:\n\n- One.\n- Two.\n- Three.\n- Four.\n- Five.\n- Six.' });

const fake = createFake({
  csbfp_legal_documents: LEGAL,
  csbfp_job_titles: ['Sales Representative', 'Account Executive', 'Other'].map((label, i) => ({ id: i + 1, label, position: i + 1, active: true })),
  csbfp_financing_products: ['MCA', 'Equipment', 'Not directly involved with financing products'].map((label, i) => ({ id: i + 1, label, position: i + 1, active: true })),
});
supa.db.set(fake);

// Capture emails (printed to the log when Postmark isn't configured).
const sent = [];
const origLog = console.log;
console.log = (...args) => {
  const s = args.join(' ');
  if (s.includes('[email]')) sent.push(s); else origLog(...args);
};

const app = require('../server');
let base;
let server;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => { console.log = origLog; server.close(); });

// Minimal browser: keeps cookies, sends forms, doesn't follow redirects.
function browser() {
  const jar = {};
  return {
    jar,
    async req(path, form, extra = {}) {
      const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...extra };
      let body;
      if (form) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        const p = new URLSearchParams();
        for (const [k, v] of Object.entries(form)) for (const x of [].concat(v)) p.append(k, x);
        body = p.toString();
      }
      const res = await fetch(base + path, { method: form ? 'POST' : 'GET', headers, body, redirect: 'manual' });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const [k, ...v] = pair.split('=');
        if (/Expires=Thu, 01 Jan 1970/.test(c) || v.join('=') === '') delete jar[k]; else jar[k] = v.join('=');
      }
      return { status: res.status, location: res.headers.get('location'), text: await res.text() };
    },
  };
}

const wait = ms => new Promise(r => setTimeout(r, ms));
async function codeFor(email, after = 0) {
  for (let i = 0; i < 50; i++) {
    const hit = sent.slice(after).reverse().find(s => s.includes(`to=${email}`) && /\b\d{6}\b/.test(s));
    if (hit) return hit.match(/\n(\d{6})\n/)[1];
    await wait(20);
  }
  throw new Error(`no code email for ${email}`);
}

async function signUpAndVerify(b, email, phone = '4155551212') {
  const mark = sent.length;
  const r = await b.req('/portal/signup', { email, phone, agree: 'yes', website: '' });
  assert.equal(r.status, 303);
  assert.equal(r.location, '/portal/verify');
  const code = await codeFor(email, mark);
  const v = await b.req('/portal/verify', { code });
  assert.equal(v.status, 303, v.text.slice(0, 300));
  assert.equal(v.location, '/portal/dashboard');
}

test('public pages still work and the portal pages render', async () => {
  const b = browser();
  for (const p of ['/', '/faq', '/verify', '/legal/terms', '/portal', '/portal/signup']) {
    const r = await b.req(p);
    assert.equal(r.status, 200, p);
  }
  assert.match((await b.req('/legal/terms')).text, /Placeholder/);
});

test('pre-launch: emails not on the preview list cannot sign up or sign in', async () => {
  const b = browser();
  const r = await b.req('/portal/signup', { email: 'stranger@example.com', phone: '4155550000', agree: 'yes' });
  assert.equal(r.status, 403);
  assert.match(r.text, /not yet open/);
  const s = await b.req('/portal', { email: 'stranger@example.com' });
  assert.equal(s.status, 403);
  assert.equal((fake.tables.csbfp_registrants || []).filter(x => x.email === 'stranger@example.com').length, 0);
});

test('sign-up validation messages', async () => {
  const b = browser();
  const r = await b.req('/portal/signup', { email: 'not-an-email', phone: '123', website: '' });
  assert.equal(r.status, 422);
  assert.match(r.text, /valid email address/);
  assert.match(r.text, /10-digit U.S. mobile number/);
  assert.match(r.text, /agree to the Program Terms/);
});

test('honeypot: a filled hidden field creates nothing', async () => {
  const b = browser();
  const before = (fake.tables.csbfp_registrants || []).length;
  await b.req('/portal/signup', { email: 'jane@example.com', phone: '4155551212', agree: 'yes', website: 'spam.com' });
  assert.equal((fake.tables.csbfp_registrants || []).length, before);
});

test('full journey: sign up, verify email, complete every form', async () => {
  const b = browser();
  await signUpAndVerify(b, 'jane@example.com');

  const jane = fake.tables.csbfp_registrants.find(r => r.email === 'jane@example.com');
  assert.ok(jane.email_verified_at, 'email verified');
  assert.equal(jane.phone_e164, '+14155551212');
  assert.equal(fake.tables.csbfp_registrations.find(r => r.registrant_id === jane.id).status, 'pending');
  const acc = fake.tables.csbfp_legal_acceptances.filter(a => a.registrant_id === jane.id).map(a => `${a.document_key}@${a.document_version}`);
  assert.deepEqual(acc.sort(), ['privacy@1', 'terms@1']);
  await wait(50);
  assert.ok(fake.tables.csbfp_email_messages.some(m => m.dedupe_key === `welcome:${jane.id}`), 'welcome email logged');

  // First visit: personal information comes before the dashboard.
  let d = await b.req('/portal/dashboard');
  assert.equal(d.status, 303);
  assert.equal(d.location, '/portal/personal');
  const first = await b.req('/portal/personal');
  assert.match(first.text, /<h1>Before You Get Started<\/h1>/);
  assert.match(first.text, />Continue<\/button>/);
  assert.doesNotMatch(first.text, /← Dashboard/);

  // Personal: under 18 is refused.
  let p = await b.req('/portal/personal', { legal_first_name: 'Jane', legal_last_name: 'Smith', dob: '2015-01-01', zip5: '94105', phone: '(415) 555-1212', industry_start_month: '3', industry_start_year: '2019' });
  assert.equal(p.status, 422);
  assert.match(p.text, /18 or older/);

  p = await b.req('/portal/personal', { legal_first_name: '  Jane ', middle_name: '', legal_last_name: 'Smith', dob: '1990-05-17', zip5: '94105', phone: '(415) 555-1212', industry_start_month: '3', industry_start_year: '2019' });
  assert.equal(p.status, 303);
  const j2 = fake.tables.csbfp_registrants.find(r => r.id === jane.id);
  assert.equal(j2.legal_first_name, 'Jane');
  assert.equal(j2.industry_start_month, '2019-03-01');
  assert.ok(j2.dob_enc.startsWith('v1:') && !j2.dob_enc.includes('1990'), 'DOB stored encrypted');
  assert.ok(j2.dob_hash && !JSON.stringify(fake.tables.csbfp_events).includes('1990'), 'DOB never in the activity log');
  const pv = await b.req('/portal/personal?saved=1');
  assert.match(pv.text, /value="1990-05-17"/, 'DOB shown back to its owner');

  // Employment
  const e = await b.req('/portal/employment/new', { relationship_type: 'employee', company_name: 'Acme Funding', company_website: 'acmefunding.com/about',
    start_month: '6', start_year: '2021', work_arrangement: 'hybrid', company_type: '', primary_role: '' });
  assert.equal(e.status, 422, 'company type and role are required pick lists');
  assert.match(e.text, /choose the company type/);
  assert.match(e.text, /choose your primary role/);
  const e2 = await b.req('/portal/employment/new', { relationship_type: 'employee', company_name: 'Acme Funding', company_website: 'acmefunding.com/about',
    start_month: '6', start_year: '2021', work_arrangement: 'hybrid', company_type: 'funder_lender', primary_role: 'underwriting_credit' });
  assert.equal(e2.status, 303);
  const rel = fake.tables.csbfp_employment_relationships.find(r => r.registrant_id === jane.id);
  assert.equal(rel.company_website, 'https://acmefunding.com');
  assert.equal(fake.tables.csbfp_registrants.find(r => r.id === jane.id).employment_status, 'working');
  const el = await b.req('/portal/employment');
  assert.match(el.text, /Acme Funding/);
  assert.match(el.text, /Lender only/);
  assert.match(el.text, /Underwriting \/ Credit/);
  assert.doesNotMatch((await b.req('/portal/employment/new')).text, /Job title/);
  assert.equal(rel.primary_role, 'underwriting_credit');

  // Products
  const px = await b.req('/portal/products', { products: ['1', '3'] });
  assert.equal(px.status, 422, '"Not directly involved" cannot be combined with products');
  const pr = await b.req('/portal/products', { products: ['1', '2'], products_other: '' });
  assert.equal(pr.status, 303);
  assert.ok(fake.tables.csbfp_registrants.find(r => r.id === jane.id).profile_completed_at, 'profile marked complete');

  // Acknowledgments: all six required
  const a1 = await b.req('/portal/acknowledgments', { ack_0: 'yes', ack_1: 'yes' });
  assert.equal(a1.status, 422);
  const a2 = await b.req('/portal/acknowledgments', Object.fromEntries([0, 1, 2, 3, 4, 5].map(i => [`ack_${i}`, 'yes'])));
  assert.equal(a2.status, 303);
  assert.ok(fake.tables.csbfp_legal_acceptances.some(a => a.registrant_id === jane.id && a.document_key === 'acknowledgments' && a.context === 'acknowledgments'));

  d = await b.req('/portal/dashboard');
  assert.match(d.text, /<span>Training modules<\/span><a class="button gold small" href="\/portal\/(training\/|assessment)/);
  assert.doesNotMatch(d.text, /<span>Personal information<\/span>/, "application steps done");
  assert.doesNotMatch(d.text, /demo record only/, "preview note removed from the dashboard");
  const pp = await b.req('/portal/personal');
  assert.match(pp.text, /href="\/portal\/dashboard">← Dashboard</);
  assert.doesNotMatch(d.text, /← Dashboard/);
  assert.match(d.text, /href="\/portal\/account">Account Settings</);
  assert.match(d.text, /action="\/portal\/logout"/);

  // Sign out, sign back in with a fresh code
  const out = await b.req('/portal/logout', {});
  assert.equal(out.location, '/portal');
  assert.equal((await b.req('/portal/dashboard')).location, '/portal');
  const mark = sent.length;
  await b.req('/portal', { email: 'jane@example.com' });
  const code = await codeFor('jane@example.com', mark);
  assert.match(sent[sent.length - 1], /sign-in code/i);
  const v = await b.req('/portal/verify', { code });
  assert.equal(v.location, '/portal/dashboard');
});

test('codes: wrong code, single use, lockout after 5 attempts', async () => {
  fake.tables.csbfp_login_codes = []; require('../routes/portal').resetCodeRequests(); // as if 15 minutes have passed (max 3 codes per 15 minutes)
  const b = browser();
  const mark = sent.length;
  await b.req('/portal', { email: 'jane@example.com' });
  const code = await codeFor('jane@example.com', mark);
  const wrong = code === '000000' ? '111111' : '000000';
  let r = await b.req('/portal/verify', { code: wrong });
  assert.equal(r.status, 401);
  assert.match(r.text, /incorrect or has expired/);
  r = await b.req('/portal/verify', { code });
  assert.equal(r.location, '/portal/dashboard');

  // Reused code fails
  const b2 = browser();
  await b2.req('/portal', { email: 'jane@example.com' });
  await wait(60);
  r = await b2.req('/portal/verify', { code });
  assert.equal(r.status, 401);

  // An email with no account gets a "no account found" email, not a code.
  const b3 = browser();
  const m3 = sent.length;
  await b3.req('/portal', { email: 'john@example.com' });
  await wait(60);
  assert.ok(sent.slice(m3).some(s => s.includes('to=john@example.com') && /No account found/.test(s)), 'no-account email instead of a code');

  // Five wrong tries locks the code: even the right code fails afterwards.
  fake.tables.csbfp_login_codes = []; require('../routes/portal').resetCodeRequests();
  const b4 = browser();
  const m4 = sent.length;
  await b4.req('/portal/resend', {}); // no login cookie yet -> back to sign in
  await b4.req('/portal', { email: 'jane@example.com' });
  const code4 = await codeFor('jane@example.com', m4);
  const bad = code4 === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await b4.req('/portal/verify', { code: bad });
  r = await b4.req('/portal/verify', { code: code4 });
  assert.equal(r.status, 401);
  assert.match(r.text, /incorrect or has expired|Too many/);
});

test('at most 3 codes per account per 15 minutes; the 4th request says to wait', async () => {
  fake.tables.csbfp_login_codes = []; require('../routes/portal').resetCodeRequests();
  const m = sent.length;
  const res = [];
  for (let i = 0; i < 5; i++) res.push(await browser().req('/portal', { email: 'jane@example.com' }));
  await wait(150);
  assert.equal(sent.slice(m).filter(s => s.includes('to=jane@example.com')).length, 3);
  assert.deepEqual(res.map(r => r.status), [303, 303, 303, 429, 429]);
  assert.match(res[3].text, /Too many codes have been requested for this email address/);
  // Same answer for an address with no account, so the message doesn't reveal who has one.
  const none = [];
  for (let i = 0; i < 4; i++) none.push(await browser().req('/portal', { email: 'john@example.com' }));
  assert.deepEqual(none.map(r => r.status), [303, 303, 303, 429]);
  fake.tables.csbfp_login_codes = []; require('../routes/portal').resetCodeRequests();
});

test('the screen never reveals whether an account exists', async () => {
  const a = await browser().req('/portal', { email: 'jane@example.com' });
  const b = await browser().req('/portal', { email: 'john@example.com' });
  assert.equal(a.status, b.status);
  assert.equal(a.location, b.location);
  const s1 = await browser().req('/portal/signup', { email: 'jane@example.com', phone: '4155551212', agree: 'yes' });
  assert.equal(s1.location, '/portal/verify', 'existing email: same response as new');
});

test('people can only see and change their own records', async () => {
  const john = browser();
  await signUpAndVerify(john, 'john@example.com', '3055550000');
  const janeRel = fake.tables.csbfp_employment_relationships.find(r => r.company_name === 'Acme Funding');
  const view = await john.req(`/portal/employment/${janeRel.id}`);
  assert.equal(view.status, 404);
  const edit = await john.req(`/portal/employment/${janeRel.id}`, { company_name: 'Hacked' });
  assert.equal(edit.status, 404);
  const del = await john.req(`/portal/employment/${janeRel.id}/delete`, {});
  assert.equal(del.status, 404);
  assert.equal(fake.tables.csbfp_employment_relationships.find(r => r.id === janeRel.id).company_name, 'Acme Funding');
  const dash = await john.req('/portal/dashboard');
  assert.doesNotMatch(dash.text, /Jane|Acme/);
});

test('forms posted from another website are blocked', async () => {
  let r = await browser().req('/portal', { email: 'jane@example.com' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  r = await browser().req('/portal', { email: 'jane@example.com' }, { 'sec-fetch-site': 'cross-site', origin: 'null' });
  assert.equal(r.status, 403);
  r = await browser().req('/portal', { email: 'jane@example.com' }, { 'sec-fetch-site': 'same-origin', origin: 'null' });
  assert.notEqual(r.status, 403, 'same-site form posts work even when Origin is null');
});

test('possible duplicates are flagged for review, not blocked from signing in', async () => {
  const b = browser();
  await signUpAndVerify(b, 'dupe@example.com', '7865550000');
  await b.req('/portal/personal', { legal_first_name: 'JANE', legal_last_name: 'smith', dob: '1990-05-17', zip5: '94105', phone: '7865550000', industry_start_month: '1', industry_start_year: '2020' });
  const dupe = fake.tables.csbfp_registrants.find(r => r.email === 'dupe@example.com');
  const flags = fake.tables.csbfp_duplicate_flags.filter(f => f.registrant_id === dupe.id);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].match_reason, 'dob_last_name_zip');
  const d = await b.req('/portal/dashboard');
  assert.match(d.text, /confirm a few details/);
});

test('signed-out visitors are sent to sign in', async () => {
  for (const p of ['/portal/dashboard', '/portal/personal', '/portal/employment', '/portal/products', '/portal/acknowledgments']) {
    const r = await browser().req(p);
    assert.equal(r.status, 303, p);
    assert.equal(r.location, '/portal', p);
  }
});
