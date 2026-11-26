/**
 * Registrant accounts: sign-up, passwordless sign-in with emailed codes, sign-out.
 *
 *   GET/POST /portal            enter email to sign in
 *   GET/POST /portal/signup     create an account (email, mobile, Terms + Privacy)
 *   GET/POST /portal/verify     enter the 6-digit code
 *   POST     /portal/resend     send a fresh code
 *   POST     /portal/logout
 *
 * The first code also verifies the email address. Codes: 6 digits, 10-minute expiry, single use, stored as
 * HMAC, 5 attempts, a new code cancels older ones, at most 3 per account per 15 minutes, plus per-IP limits.
 *
 * The screen never says whether an account exists; only the inbox owner finds out (from the email).
 * While PRE_LAUNCH is on, only PREVIEW_EMAILS (default: ADMIN_EMAILS) can sign up or sign in.
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../lib/config');
const { db, must } = require('../lib/supabase');
const { codeHash, keyedHash } = require('../lib/crypto');
const { sendOnce, sendQuietly, registrantVars } = require('../lib/email');
const { logEvent } = require('../lib/events');
const { recordAcceptance } = require('../lib/legal');
const turnstile = require('../lib/turnstile');
const session = require('../lib/session');
const { normEmail, validEmail, validateSignup } = require('../lib/validate');

const router = express.Router();

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_WINDOW = 3;
const CODE_WINDOW_MS = 15 * 60 * 1000;
const GENERIC = 'That code is incorrect or has expired. Check the code, or request a new one.';
const CLOSED = 'Registration is not yet open.';

const limiter = (limit, view, message) => rateLimit({
  windowMs: 15 * 60 * 1000, limit, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => res.status(429).render(view, { pageTitle: 'Please wait', error: message, values: {}, errors: {}, email: '', turnstileKey: turnstile.siteKey() }),
});
const signinLimiter = limiter(50, 'portal/signin', 'Too many sign-in requests from this network. Please wait 15 minutes and try again.');
const signupLimiter = limiter(50, 'portal/signup', 'Too many sign-up attempts from this network. Please wait 15 minutes and try again.');
const verifyLimiter = limiter(100, 'portal/verify', 'Too many attempts from this network. Please wait 15 minutes and try again.');

// Delete codes that expired over a day ago, at most once an hour. Replaces a cron job.
let lastCleanup = 0;
function cleanupCodes() {
  if (Date.now() - lastCleanup < 60 * 60 * 1000) return;
  lastCleanup = Date.now();
  db().from('csbfp_login_codes').delete().lt('expires_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .then(({ error }) => { if (error) console.error('Code cleanup failed:', error.message); });
}

async function findByEmail(email) {
  return must(await db().from('csbfp_registrants').select('*').eq('email', email).maybeSingle(), 'Registrant lookup');
}

const canSignIn = r => r && ['active', 'deletion_requested'].includes(r.account_status);

// Runs after the response is sent, so timing doesn't reveal whether the account exists.
async function issueCode(email, ip) {
  try {
    cleanupCodes();
    const registrant = await findByEmail(email);
    if (!canSignIn(registrant)) {
      if (!registrant) {
        // At most one "no account" email per address per hour. The key is a hash, not the address.
        const hour = new Date().toISOString().slice(0, 13);
        await sendOnce({ dedupeKey: `no_account:${keyedHash('signin-notice', email)}:${hour}`, templateKey: 'no_account', to: email });
      }
      return;
    }

    const since = new Date(Date.now() - CODE_WINDOW_MS).toISOString();
    const { count, error: countErr } = await db().from('csbfp_login_codes')
      .select('id', { count: 'exact', head: true }).eq('registrant_id', registrant.id).gte('created_at', since);
    if (countErr) throw new Error(`Code count: ${countErr.message}`);
    if ((count || 0) >= MAX_CODES_PER_WINDOW) {
      await logEvent({ registrantId: registrant.id, event: 'code_rate_limited', actor: 'system', ip });
      return;
    }

    // A new code cancels any earlier unused ones.
    must(await db().from('csbfp_login_codes').update({ used_at: new Date().toISOString() })
      .eq('registrant_id', registrant.id).is('used_at', null), 'Cancel old codes');

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const firstTime = !registrant.email_verified_at;
    const row = must(await db().from('csbfp_login_codes').insert({
      registrant_id: registrant.id,
      purpose: firstTime ? 'verify_email' : 'sign_in',
      code_hash: codeHash(registrant.id, code),
      expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
      ip,
    }).select('id').single(), 'Code insert');

    await sendOnce({
      dedupeKey: `code:${row.id}`, registrantId: registrant.id, templateKey: firstTime ? 'email_verification' : 'sign_in_code',
      to: registrant.email, vars: { ...registrantVars(registrant), code },
    });
    await logEvent({ registrantId: registrant.id, event: 'code_sent', actor: 'system', ip });
  } catch (err) {
    console.error('Issuing sign-in code failed:', err.message);
  }
}

// Visible per-address limit: the same 3-in-15-minutes rule as above, counted per request (whether or not an
// account exists), so hitting it tells the person to wait without revealing who has an account.
const CODE_LIMIT_MSG = 'Too many codes have been requested for this email address. Please wait 15 minutes and try again.';
const codeRequests = new Map();
function tooManyCodeRequests(email) {
  const key = keyedHash('code-request', email);
  const now = Date.now();
  const recent = (codeRequests.get(key) || []).filter(t => now - t < CODE_WINDOW_MS);
  if (recent.length >= MAX_CODES_PER_WINDOW) { codeRequests.set(key, recent); return true; }
  recent.push(now);
  codeRequests.set(key, recent);
  if (codeRequests.size > 5000) for (const [k, v] of codeRequests) if (!v.some(t => now - t < CODE_WINDOW_MS)) codeRequests.delete(k);
  return false;
}

const startCode = (res, email, ip) => {
  session.setLoginEmail(res, email);
  res.redirect(303, '/portal/verify');
  setImmediate(() => issueCode(email, ip));
};

// ---------- sign in ----------

router.get('/', (req, res) => {
  if (session.readSession(req)) return res.redirect('/portal/dashboard');
  res.render('portal/signin', { pageTitle: 'Sign In', error: null, email: '' });
});

router.post('/', signinLimiter, (req, res) => {
  const email = normEmail(req.body.email);
  if (!validEmail(email)) return res.status(422).render('portal/signin', { pageTitle: 'Sign In', error: 'Please enter a valid email address.', email });
  if (!config.previewAllowed(email)) return res.status(403).render('portal/signin', { pageTitle: 'Sign In', error: CLOSED, email });
  if (tooManyCodeRequests(email)) return res.status(429).render('portal/signin', { pageTitle: 'Sign In', error: CODE_LIMIT_MSG, email });
  startCode(res, email, req.ip);
});

// ---------- sign up ----------

const signupView = (res, { status = 200, values = {}, errors = {}, error = null } = {}) =>
  res.status(status).render('portal/signup', { pageTitle: 'Create an Account', values, errors, error, turnstileKey: turnstile.siteKey() });

router.get('/signup', (req, res) => {
  if (session.readSession(req)) return res.redirect('/portal/dashboard');
  signupView(res);
});

router.post('/signup', signupLimiter, async (req, res, next) => {
  try {
    const values = { email: req.body.email, phone: req.body.phone, agree: req.body.agree };
    // Honeypot: real people never see or fill the "website" field.
    if (req.body.website) return res.redirect(303, '/portal/verify');
    if (!(await turnstile.verify(req.body['cf-turnstile-response'], req.ip))) {
      return signupView(res, { status: 422, values, error: 'Please complete the verification check and try again.' });
    }
    const { errors, data } = validateSignup(req.body);
    if (Object.keys(errors).length) return signupView(res, { status: 422, values, errors });
    if (!config.previewAllowed(data.email)) return signupView(res, { status: 403, values, error: CLOSED });

    const existing = await findByEmail(data.email);
    if (!existing) {
      const { data: created, error } = await db().from('csbfp_registrants')
        .insert({ email: data.email, phone_e164: data.phone }).select('id').single();
      if (error && error.code !== '23505') throw new Error(`Create registrant: ${error.message}`);
      if (created) {
        must(await db().from('csbfp_registrations').insert({ registrant_id: created.id }), 'Create registration');
        await recordAcceptance({ registrantId: created.id, keys: ['terms', 'privacy'], context: 'signup', ip: req.ip, userAgent: req.get('user-agent') });
        await logEvent({ registrantId: created.id, event: 'signed_up', actor: 'registrant', ip: req.ip });
      }
    }
    // Same next screen whether or not the email already had an account.
    return startCode(res, data.email, req.ip);
  } catch (err) {
    return next(err);
  }
});

// ---------- code entry ----------

const verifyView = (res, email, { status = 200, error = null, resent = false } = {}) =>
  res.status(status).render('portal/verify', { pageTitle: 'Enter Code', email, error, resent });

router.get('/verify', (req, res) => {
  const email = session.readLoginEmail(req);
  if (!email) return res.redirect('/portal');
  verifyView(res, email, { resent: req.query.resent === '1' });
});

router.post('/resend', signinLimiter, (req, res) => {
  const email = session.readLoginEmail(req);
  if (!email) return res.redirect(303, '/portal');
  if (tooManyCodeRequests(email)) return verifyView(res, email, { status: 429, error: CODE_LIMIT_MSG });
  session.setLoginEmail(res, email);
  res.redirect(303, '/portal/verify?resent=1');
  setImmediate(() => issueCode(email, req.ip));
});

router.post('/verify', verifyLimiter, async (req, res, next) => {
  const email = session.readLoginEmail(req);
  if (!email) return res.redirect(303, '/portal');
  const code = typeof req.body.code === 'string' ? req.body.code.replace(/\D/g, '') : '';
  const fail = (message, status = 401) => verifyView(res, email, { status, error: message });

  try {
    if (code.length !== 6) return fail('Please enter the 6-digit code from your email.', 422);

    const registrant = await findByEmail(email);
    if (!canSignIn(registrant) || !config.previewAllowed(email)) return fail(GENERIC);

    const row = must(await db().from('csbfp_login_codes')
      .select('id, code_hash, attempts, expires_at')
      .eq('registrant_id', registrant.id).is('used_at', null).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle(), 'Code lookup');
    if (!row) return fail(GENERIC);
    if (row.attempts >= MAX_ATTEMPTS) return fail('Too many incorrect attempts. Please request a new code.', 429);

    const given = Buffer.from(codeHash(registrant.id, code), 'hex');
    const want = Buffer.from(row.code_hash, 'hex');
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      const attempts = row.attempts + 1;
      await db().from('csbfp_login_codes').update({ attempts, ...(attempts >= MAX_ATTEMPTS ? { used_at: new Date().toISOString() } : {}) })
        .eq('id', row.id).eq('attempts', row.attempts);
      await logEvent({ registrantId: registrant.id, event: 'login_failed', actor: 'registrant', detail: { attempts }, ip: req.ip });
      return fail(attempts >= MAX_ATTEMPTS ? 'Too many incorrect attempts. Please request a new code.' : GENERIC);
    }

    // Mark used; the used_at filter makes this single-use even under concurrent submits.
    const used = must(await db().from('csbfp_login_codes')
      .update({ used_at: new Date().toISOString() }).eq('id', row.id).is('used_at', null).select('id').maybeSingle(), 'Code use');
    if (!used) return fail(GENERIC);

    const now = new Date().toISOString();
    const firstTime = !registrant.email_verified_at;
    must(await db().from('csbfp_registrants').update({ last_login_at: now, ...(firstTime ? { email_verified_at: now } : {}) })
      .eq('id', registrant.id), 'Update sign-in time');
    await logEvent({ registrantId: registrant.id, event: firstTime ? 'email_verified' : 'login', actor: 'registrant', ip: req.ip });
    if (firstTime) {
      sendQuietly({ dedupeKey: `welcome:${registrant.id}`, registrantId: registrant.id, templateKey: 'welcome', to: registrant.email, vars: registrantVars(registrant) });
    }

    session.clearLoginEmail(res);
    session.setSession(res, registrant);
    return res.redirect(303, '/portal/dashboard');
  } catch (err) {
    return next(err);
  }
});

router.post('/logout', async (req, res) => {
  const s = session.readSession(req);
  session.clearSession(res);
  if (s) await logEvent({ registrantId: s.sub, event: 'logout', actor: 'registrant', ip: req.ip });
  res.redirect(303, '/portal');
});

router.resetCodeRequests = () => codeRequests.clear(); // tests: "15 minutes have passed"
module.exports = router;
