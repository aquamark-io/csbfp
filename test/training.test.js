/**
 * End-to-end tests for steps 4-5 (training and assessment), with a small made-up course.
 * (The real curriculum and answer key are loaded into the database only, never into the code.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
  NODE_ENV: 'test',
  SUPABASE_URL: 'http://fake.local',
  SUPABASE_SERVICE_KEY: 'fake',
  JWT_SECRET: 'z'.repeat(40),
  FIELD_ENCRYPTION_KEY: 'test-encryption-key-that-is-long-enough-1234',
  FIELD_HASH_KEY: 'test-hash-key-that-is-long-enough-and-different',
  PRE_LAUNCH: 'true',
  ADMIN_EMAILS: 'boss@example.com',
  PREVIEW_EMAILS: 'boss@example.com,amy@example.com,ben@example.com',
  POSTMARK_SERVER_TOKEN: '',
});

const { createFake } = require('./fake-supabase');
const supa = require('../lib/supabase');

const V1 = '99999999-9999-4999-8999-999999999999';
const docs = ['terms', 'privacy', 'registration_agreement', 'automatic_renewal', 'disclaimer'].map(key => ({ key, version: 1, body_md: 'x', status: 'published' }));
docs.push({ key: 'acknowledgments', version: 1, status: 'published', body_md: '- One.' });
docs.push({ key: 'conduct_standards', version: 1, status: 'published', body_md: 'Before:\n\n- I will be honest.\n- I will protect data.' });

// 5 questions; correct answers are the options whose text starts with "Right".
const questions = [];
const options = [];
for (let n = 1; n <= 5; n++) {
  const qid = `00000000-0000-4000-8000-00000000000${n}`;
  questions.push({ id: qid, curriculum_version_id: V1, position: n, prompt: `Question ${n}?`, explanation: `Because ${n}.`, active: true });
  ['Wrong A', `Right ${n}`, 'Wrong C', 'Wrong D'].forEach((t, i) => options.push({ id: `${qid.slice(0, -2)}${n}${i}`, question_id: qid, text: t, is_correct: t.startsWith('Right'), position: i + 1 }));
}

const fake = createFake({
  csbfp_legal_documents: docs,
  csbfp_job_titles: [{ id: 1, label: 'Other', position: 1, active: true }],
  csbfp_financing_products: [{ id: 1, label: 'MCA', position: 1, active: true }],
  csbfp_curriculum_versions: [{ id: V1, label: 'Test 1', status: 'published', is_required: true, overview_md: '## Welcome\n\nIntro text.', completion_md: 'All done here.' }],
  csbfp_modules: [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', curriculum_version_id: V1, stable_key: 'intro', position: 1, title: 'Intro', body_md: 'Goal: Learn.\n\n### Remember\n\nBe accurate.', estimated_minutes: 5 },
    { id: 'aaaaaaaa-0000-4000-8000-000000000002', curriculum_version_id: V1, stable_key: 'conduct', position: 2, title: 'Conduct', body_md: '## Two\n\nText.', estimated_minutes: 8 },
  ],
  csbfp_assessment_settings: [{ curriculum_version_id: V1, question_count: 5, pass_percent: 80, cooldown_minutes: 60, max_attempts_total: 3 }],
  csbfp_questions: questions,
  csbfp_question_options: options,
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
async function admin() {
  const b = browser();
  const mark = sent.length;
  await b.req('/admin/login', { email: 'boss@example.com' });
  await b.req('/admin/login/verify', { code: await codeFor('boss@example.com', mark) });
  return b;
}

// Answer form for the open attempt: `rightCount` correct answers, the rest wrong.
function answersFor(html, rightCount) {
  const form = {};
  const groups = {};
  for (const m of html.matchAll(/name="(q_[0-9a-f-]+)" value="([0-9a-f-]+)"[^>]*><span class="opt-letter">[A-H]<\/span><span class="opt-text">([^<]+)</g)) {
    (groups[m[1]] ||= []).push({ id: m[2], text: m[3] });
  }
  Object.entries(groups).forEach(([name, opts], i) => {
    form[name] = (i < rightCount ? opts.find(o => o.text.startsWith('Right')) : opts.find(o => o.text.startsWith('Wrong'))).id;
  });
  return form;
}
const lastAttempt = email => {
  const r = fake.tables.csbfp_registrants.find(x => x.email === email);
  return fake.tables.csbfp_assessment_attempts.filter(a => a.registrant_id === r.id).sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0];
};
// Pretend the cooldown has passed.
const ageAttempts = email => {
  const r = fake.tables.csbfp_registrants.find(x => x.email === email);
  for (const a of fake.tables.csbfp_assessment_attempts.filter(x => x.registrant_id === r.id)) {
    a.started_at = new Date(Date.parse(a.started_at) - 2 * 3600e3).toISOString();
    if (a.submitted_at) a.submitted_at = new Date(Date.parse(a.submitted_at) - 2 * 3600e3).toISOString();
  }
};

let amy;
let boss;

test('modules open in order; completing them leads to the completion page and one email', async () => {
  amy = await signUp('amy@example.com', '4155550101');
  let r = await amy.req('/portal/training');
  assert.equal(r.status, 200);
  assert.match(r.text, /Intro text/);
  assert.match(r.text, /class="locked"/);
  assert.equal((await amy.req('/portal/training/conduct')).location, '/portal/training', 'module 2 locked');
  assert.equal((await amy.req('/portal/assessment/start', {})).location, '/portal/assessment', 'assessment locked');

  r = await amy.req('/portal/training/intro');
  assert.match(r.text, /class="goal"/);
  assert.match(r.text, /callout-remember/);
  r = await amy.req('/portal/training/intro/complete', {});
  assert.equal(r.location, '/portal/training?done=intro', 'back to the training list after each module');
  assert.match((await amy.req(r.location)).text, /You completed/);
  r = await amy.req('/portal/training/conduct/complete', {});
  assert.equal(r.location, '/portal/training/complete');
  assert.match((await amy.req('/portal/training/complete')).text, /All done here/);
  await amy.req('/portal/training/conduct/complete', {}); // repeat: no second email
  await wait(60);
  assert.equal(fake.tables.csbfp_email_messages.filter(m => m.template_key === 'training_completed').length, 1);
  assert.match((await amy.req('/portal/dashboard')).text, /2 of 2 modules/);
});

test('the assessment starts directly (no separate acknowledgment; the professional standards cover it)', async () => {
  let r = await amy.req('/portal/assessment');
  assert.doesNotMatch(r.text, /I will be honest/);
  assert.match(r.text, /Begin the Assessment/);
  r = await amy.req('/portal/assessment/start', {});
  assert.equal(r.location, '/portal/assessment/attempt');
});

test('questions appear in fixed order without the answer key; every question must be answered', async () => {
  const r = await amy.req('/portal/assessment/attempt');
  const order = [...r.text.matchAll(/Question (\d)\?/g)].map(m => m[1]).join('');
  assert.equal(order, '12345');
  assert.doesNotMatch(r.text, /Because \d/, 'no explanations before submitting');
  assert.doesNotMatch(r.text, /is_correct|correct"/);
  const partial = answersFor(r.text, 5);
  delete partial[Object.keys(partial)[0]];
  const s = await amy.req('/portal/assessment/submit', partial);
  assert.equal(s.status, 422);
  assert.match(s.text, /1 is unanswered/);
});

test('a failing attempt shows the score only, emails the result, and starts the wait', async () => {
  const page = await amy.req('/portal/assessment/attempt');
  const r = await amy.req('/portal/assessment/submit', answersFor(page.text, 3)); // 3 of 5 = 60%
  assert.match(r.location, /\/portal\/assessment\/result\//);
  const res = await amy.req(r.location);
  assert.match(res.text, /Not passed/);
  assert.match(res.text, /3 of 5/);
  assert.doesNotMatch(res.text, /Right \d|Because \d/, 'no answers revealed after failing');
  await wait(60);
  assert.ok(sent.some(s => s.includes('to=amy@example.com') && /Assessment not passed/.test(s)));
  const again = await amy.req('/portal/assessment');
  assert.match(again.text, /You can take the assessment again after/);
  assert.equal((await amy.req('/portal/assessment/start', {})).location, '/portal/assessment');
});

test('after the attempt limit, an admin reset allows another attempt', async () => {
  for (let i = 0; i < 2; i++) {
    ageAttempts('amy@example.com');
    await amy.req('/portal/assessment/start', {});
    const page = await amy.req('/portal/assessment/attempt');
    await amy.req('/portal/assessment/submit', answersFor(page.text, 1));
  }
  ageAttempts('amy@example.com');
  let r = await amy.req('/portal/assessment');
  assert.match(r.text, /used all of your attempts/);

  boss = await admin();
  const amyId = fake.tables.csbfp_registrants.find(x => x.email === 'amy@example.com').id;
  r = await boss.req(`/admin/registrants/${amyId}`);
  assert.match(r.text, /0 attempts left/);
  r = await boss.req(`/admin/registrants/${amyId}/reset-attempts`, { reason: '' });
  assert.match(decodeURIComponent(r.location), /reason is required/);
  await boss.req(`/admin/registrants/${amyId}/reset-attempts`, { reason: 'Asked for another try' });
  assert.ok(fake.tables.csbfp_admin_audit_log.some(a => a.action === 'assessment_attempts_reset' && a.reason === 'Asked for another try'));
  r = await amy.req('/portal/assessment/start', {});
  assert.equal(r.location, '/portal/assessment/attempt');
});

test('a passing attempt shows the score only, never the answer key; dashboard shows Passed', async () => {
  const page = await amy.req('/portal/assessment/attempt');
  const r = await amy.req('/portal/assessment/submit', answersFor(page.text, 4)); // 80%
  const res = await amy.req(r.location);
  assert.match(res.text, /Passed/);
  assert.match(res.text, /4 of 5/);
  assert.doesNotMatch(res.text, /Because \d|Correct answer|Right \d/, 'no answer key after passing');
  await wait(60);
  assert.ok(sent.some(s => s.includes('to=amy@example.com') && /Assessment passed/.test(s)));
  assert.match((await amy.req('/portal/dashboard')).text, /Passed/);
  assert.equal((await amy.req('/portal/assessment/start', {})).location, '/portal/assessment', 'no attempts after passing');
});

test("people can't see someone else's results", async () => {
  const ben = await signUp('ben@example.com', '4155550202');
  const id = lastAttempt('amy@example.com').id;
  assert.equal((await ben.req(`/portal/assessment/result/${id}`)).status, 404);
});

test('admin edits to a question never change past results', async () => {
  const qid = questions[0].id;
  let r = await boss.req(`/admin/training/v/${V1}/questions/${qid}`);
  assert.match(r.text, /Question 1\?/);
  await boss.req(`/admin/training/v/${V1}/questions/${qid}`, { prompt: 'Edited question?', option_0: 'Yes', option_1: 'No', correct: '0', explanation: 'New', active: 'yes', position: '1' });
  assert.equal(fake.tables.csbfp_questions.find(q => q.id === qid).prompt, 'Edited question?');
  const snap = lastAttempt('amy@example.com').questions_snapshot;
  assert.ok(snap.some(q => q.prompt === 'Question 1?') && !snap.some(q => q.prompt === 'Edited question?'), 'saved attempt keeps the original question');
  r = await boss.req(`/admin/training/v/${V1}/questions/${qid}`, { prompt: 'X', option_0: 'Yes', option_1: '', correct: '0' });
  assert.match(decodeURIComponent(r.location), /at least two answer choices/);
});

test('admin: module editing, video links, reordering', async () => {
  const mid = 'aaaaaaaa-0000-4000-8000-000000000002';
  let r = await boss.req(`/admin/training/v/${V1}/modules/${mid}`, { title: 'Conduct', body_md: '## Two\n\nUpdated.', video_url: 'https://evil.example/v', summary: 'Ethics' });
  assert.match(decodeURIComponent(r.location), /YouTube or Vimeo/);
  await boss.req(`/admin/training/v/${V1}/modules/${mid}`, { title: 'Conduct', body_md: '## Two\n\nUpdated.', video_url: 'https://youtu.be/dQw4w9WgXcQ', summary: 'Ethics' });
  r = await amy.req('/portal/training/conduct');
  assert.match(r.text, /Updated\./);
  assert.match(r.text, /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
  await boss.req(`/admin/training/v/${V1}/modules/${mid}/move`, { dir: 'up' });
  const order = fake.tables.csbfp_modules.filter(m => m.curriculum_version_id === V1).sort((a, b) => a.position - b.position).map(m => m.stable_key);
  assert.deepEqual(order, ['conduct', 'intro']);
});

test('admin: copy to a draft, then publishing requires confirmation and replaces the current version', async () => {
  let r = await boss.req(`/admin/training/v/${V1}/copy`, { label: 'Test 2' });
  const v2 = fake.tables.csbfp_curriculum_versions.find(v => v.label === 'Test 2');
  assert.ok(v2);
  assert.equal(v2.status, 'draft');
  assert.equal(fake.tables.csbfp_modules.filter(m => m.curriculum_version_id === v2.id).length, 2);
  assert.equal(fake.tables.csbfp_questions.filter(q => q.curriculum_version_id === v2.id).length, 5);
  assert.match((await amy.req('/portal/training')).text, /Test|Intro/); // registrants still on Test 1

  r = await boss.req(`/admin/training/v/${v2.id}/publish`, {});
  assert.match(decodeURIComponent(r.location), /confirmation/);
  r = await boss.req(`/admin/training/v/${v2.id}/publish`, { confirm: 'yes' });
  assert.equal(fake.tables.csbfp_curriculum_versions.find(v => v.id === v2.id).is_required, true);
  assert.equal(fake.tables.csbfp_curriculum_versions.find(v => v.id === V1).is_required, false);
  // Ben (not yet passed) now sees the new version from the start.
  const ben = browser();
  const mark = sent.length;
  await ben.req('/portal', { email: 'ben@example.com' });
  await ben.req('/portal/verify', { code: await codeFor('ben@example.com', mark) });
  assert.match((await ben.req('/portal/dashboard')).text, /0 of 2 modules/);
});

test('admin results list shows attempts', async () => {
  const r = await boss.req('/admin/training/results');
  assert.match(r.text, /4 of 5/);
  assert.match(r.text, /Not passed/);
});
