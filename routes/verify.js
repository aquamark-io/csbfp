/**
 * Public registration lookup: GET /verify?number=BR-12345678
 *
 * Shows only: registration number, full name (first + last), status (Active / Inactive / Expired) and the
 * valid-through date. Never employer, contact details, date of birth, ZIP or anything else.
 * Pending, on-hold, retired (deleted) and unknown numbers all get the same "not found" answer.
 * No name search, no directory, no JSON API. Rate-limited per network; every lookup is logged with a
 * keyed hash of the IP (no query text) to spot scraping.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../lib/config');
const { db, must } = require('../lib/supabase');
const { keyedHash } = require('../lib/crypto');
const turnstile = require('../lib/turnstile');

const router = express.Router();

const tooMany = (req, res) => res.status(429).render('verify', { pageTitle: 'Verify Registration', number: '', result: null,
  error: 'Too many lookups from this network. Please try again later.', turnstileKey: turnstile.siteKey() });
const perTenMinutes = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, handler: tooMany,
  skip: req => !req.query.number });
const perDay = rateLimit({ windowMs: 24 * 60 * 60 * 1000, limit: 100, standardHeaders: false, legacyHeaders: false, handler: tooMany,
  skip: req => !req.query.number });

// "BR-12345678", "br 1234 5678", "12345678" -> "BR-12345678"
function normalize(input) {
  const digits = String(input || '').toUpperCase().replace(/^\s*BR/, '').replace(/[\s-]/g, '');
  return /^\d{8}$/.test(digits) ? `BR-${digits}` : null;
}

// Delete lookup logs older than 90 days, at most once a day.
let lastCleanup = 0;
function cleanup() {
  if (Date.now() - lastCleanup < 864e5) return;
  lastCleanup = Date.now();
  db().from('br_verify_lookups').delete().lt('created_at', new Date(Date.now() - 90 * 864e5).toISOString())
    .then(({ error }) => { if (error) console.error('Lookup log cleanup failed:', error.message); });
}

async function lookup(number) {
  const reg = must(await db().from('br_registrations')
    .select('registrant_id, registration_number, status, admin_hold, retired_at, expires_at')
    .eq('registration_number', number).maybeSingle(), 'Lookup');
  if (!reg || reg.admin_hold || reg.retired_at || !['active', 'inactive', 'expired'].includes(reg.status)) return null;
  const person = must(await db().from('br_registrants').select('legal_first_name, legal_last_name, account_status')
    .eq('id', reg.registrant_id).maybeSingle(), 'Lookup name');
  if (!person || person.account_status === 'deleted') return null;
  // Never show Active past the valid-through date, even if the daily job hasn't run yet.
  let status = reg.status;
  if (status === 'active' && reg.expires_at && Date.parse(reg.expires_at) <= Date.now()) status = 'expired';
  return {
    number: reg.registration_number,
    name: [person.legal_first_name, person.legal_last_name].filter(Boolean).join(' '),
    status,
    date: reg.expires_at,
  };
}

router.get('/verify', perTenMinutes, perDay, async (req, res, next) => {
  try {
    const raw = typeof req.query.number === 'string' ? req.query.number.slice(0, 30) : '';
    const view = extra => res.render('verify', { pageTitle: 'Verify Registration', number: raw, result: null, error: null,
      turnstileKey: turnstile.siteKey(), ...extra });
    if (!raw) return view({});
    if (!config.portalReady()) return view({ error: 'Verification is temporarily unavailable. Please try again later.' });
    if (turnstile.enabled() && !(await turnstile.verify(req.query['cf-turnstile-response'], req.ip))) {
      return view({ error: 'Please complete the verification check and try again.' });
    }
    const number = normalize(raw);
    if (!number) return view({ error: 'Enter a registration number in the format BR-12345678.' });

    const result = await lookup(number);
    cleanup();
    // Keyed hash of the IP, salted per month so a network can't be tracked long-term.
    const ipHash = keyedHash('verify-ip', `${new Date().toISOString().slice(0, 7)}:${req.ip}`);
    db().from('br_verify_lookups').insert({ ip_hash: ipHash, found: Boolean(result) })
      .then(({ error }) => { if (error) console.error('Lookup log failed:', error.message); });

    return view({ number, result, notFound: !result });
  } catch (err) { next(err); }
});

module.exports = { router, normalize };
