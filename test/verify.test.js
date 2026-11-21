/**
 * Tests for step 7: the public registration lookup.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
  NODE_ENV: 'test', SUPABASE_URL: 'http://fake.local', SUPABASE_SERVICE_KEY: 'fake', JWT_SECRET: 'v'.repeat(40),
  FIELD_ENCRYPTION_KEY: 'test-encryption-key-that-is-long-enough-1234', FIELD_HASH_KEY: 'test-hash-key-that-is-long-enough-and-different',
  PRE_LAUNCH: 'true', ADMIN_EMAILS: 'boss@example.com',
});

const { createFake } = require('./fake-supabase');
const supa = require('../lib/supabase');
const { normalize } = require('../routes/verify');

const person = (id, first, last, extra = {}) => ({ id, email: `${id}@x.com`, account_status: 'active', legal_first_name: first, middle_name: 'Quincy',
  legal_last_name: last, zip5: '94105', phone_e164: '+14155550000', dob_enc: 'v1:secret', ...extra });
const future = new Date(Date.now() + 200 * 864e5).toISOString();
const past = new Date(Date.now() - 10 * 864e5).toISOString();
const fake = createFake({
  br_registrants: [person('r1', 'Jane', 'Smith'), person('r2', 'Old', 'Timer'), person('r3', 'Lapsed', 'Card'), person('r4', 'On', 'Hold'),
    person('r5', 'Not', 'Paid'), person('r6', 'Gone', 'Away', { account_status: 'deleted' }), person('r7', 'Job', 'Late')],
  br_registrations: [
    { id: 'g1', registrant_id: 'r1', registration_number: 'BR-48213907', status: 'active', expires_at: future, admin_hold: false },
    { id: 'g2', registrant_id: 'r2', registration_number: 'BR-11111111', status: 'expired', expires_at: past, admin_hold: false },
    { id: 'g3', registrant_id: 'r3', registration_number: 'BR-22222222', status: 'inactive', expires_at: past, admin_hold: false },
    { id: 'g4', registrant_id: 'r4', registration_number: 'BR-33333333', status: 'active', expires_at: future, admin_hold: true },
    { id: 'g5', registrant_id: 'r5', registration_number: null, status: 'pending', admin_hold: false },
    { id: 'g6', registrant_id: 'r6', registration_number: 'BR-44444444', status: 'expired', expires_at: past, admin_hold: false, retired_at: past },
    { id: 'g7', registrant_id: 'r7', registration_number: 'BR-55555555', status: 'active', expires_at: past, admin_hold: false },
  ],
  br_employment_relationships: [{ id: 'e1', registrant_id: 'r1', company_name: 'Acme Funding', city: 'Miami', state: 'FL' }],
});
supa.db.set(fake);

const app = require('../server');
let base; let server;
test.before(() => new Promise(r => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
test.after(() => server.close());
const get = async (q, ip = '1.1.1.1') => {
  const res = await fetch(`${base}/verify?number=${encodeURIComponent(q)}`, { headers: { 'x-forwarded-for': ip } });
  return { status: res.status, text: await res.text() };
};

test('number formats are normalized', () => {
  assert.equal(normalize('BR-48213907'), 'BR-48213907');
  assert.equal(normalize('br48213907'), 'BR-48213907');
  assert.equal(normalize(' 4821 3907 '), 'BR-48213907');
  assert.equal(normalize('BR-482'), null);
  assert.equal(normalize('jane smith'), null);
});

test('an active registration shows only number, name, status and valid-through date', async () => {
  const r = await get('br 4821-3907');
  assert.equal(r.status, 200);
  assert.match(r.text, /BR-48213907/);
  assert.match(r.text, /Jane Smith/);
  assert.match(r.text, /Active/);
  assert.match(r.text, /Valid Through/);
  for (const secret of ['Quincy', 'Acme', '94105', '4155550000', 'r1@x.com', 'secret', 'Miami']) assert.doesNotMatch(r.text, new RegExp(secret), `must not show ${secret}`);
});

test('expired and inactive registrations are shown as such', async () => {
  let r = await get('BR-11111111');
  assert.match(r.text, /Old Timer/);
  assert.match(r.text, /Expired On/);
  r = await get('BR-22222222');
  assert.match(r.text, /Inactive/);
});

test('an active registration past its date shows Expired even before the daily job runs', async () => {
  const r = await get('BR-55555555');
  assert.match(r.text, /Expired/);
  assert.doesNotMatch(r.text, /verify-status ok/);
});

test('on hold, deleted, pending and unknown numbers all get the same "not found"', async () => {
  for (const n of ['BR-33333333', 'BR-44444444', 'BR-99999999']) {
    const r = await get(n);
    assert.match(r.text, /No registration was found/, n);
    assert.doesNotMatch(r.text, /Hold|Gone|Away/);
  }
  const bad = await get('Jane Smith');
  assert.match(bad.text, /format BR-12345678/);
});

test('lookups are logged without the number or the IP', async () => {
  const logs = fake.tables.br_verify_lookups;
  assert.ok(logs.length >= 6);
  assert.ok(logs.every(l => /^[0-9a-f]{64}$/.test(l.ip_hash) && !('number' in l)));
  assert.ok(logs.some(l => l.found) && logs.some(l => !l.found));
});

test('lookups are rate-limited per network', async () => {
  let last;
  for (let i = 0; i < 21; i++) last = await get('BR-48213907', '9.9.9.9');
  assert.equal(last.status, 429);
  assert.match(last.text, /Too many lookups/);
  assert.equal((await get('BR-48213907', '8.8.8.8')).status, 200, 'other networks unaffected');
});
