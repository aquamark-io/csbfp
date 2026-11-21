/**
 * Registrant account settings.
 *
 *   GET      /portal/account                 email, phone, change email
 *   POST     /portal/account/email           request a change: a code goes to the NEW address
 *   GET/POST /portal/account/email/verify    enter that code; the old address is notified
 *   POST     /portal/confirm-info            "my information is current" (annual review)
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, must } = require('../lib/supabase');
const { codeHash } = require('../lib/crypto');
const { sendOnce, sendQuietly, registrantVars } = require('../lib/email');
const { logEvent } = require('../lib/events');
const { normEmail, validEmail, fmtPhone } = require('../lib/validate');
const { requireRegistrant } = require('../middleware/auth');
const { createRequest } = require('../lib/support');
const billing = require('../lib/billing');

const router = express.Router();
router.use(['/account', '/confirm-info'], requireRegistrant);

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => res.status(429).render('error', { pageTitle: 'Please wait', message: 'Too many attempts. Please wait 15 minutes and try again.' }) });

const view = (req, res, extra = {}) => res.status(extra.status || 200).render('portal/account', {
  pageTitle: 'Account', phone: fmtPhone(req.registrant.phone_e164), error: null, newEmail: '',
  msg: typeof req.query.msg === 'string' ? req.query.msg.slice(0, 200) : null, ...extra });

router.get('/account', (req, res) => view(req, res));

router.post('/account/email', limiter, async (req, res, next) => {
  try {
    const r = req.registrant;
    const newEmail = normEmail(req.body.new_email);
    if (!validEmail(newEmail)) return view(req, res, { status: 422, error: 'Please enter a valid email address.', newEmail });
    if (newEmail === r.email) return view(req, res, { status: 422, error: 'That is already your email address.', newEmail });
    const taken = must(await db().from('br_registrants').select('id').eq('email', newEmail).maybeSingle(), 'Email check');
    if (taken) return view(req, res, { status: 422, error: 'That email address can\'t be used. Please choose another.', newEmail });

    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { count } = await db().from('br_login_codes').select('id', { count: 'exact', head: true }).eq('registrant_id', r.id).gte('created_at', since);
    if ((count || 0) >= 3) return view(req, res, { status: 429, error: 'Too many codes requested. Please wait 15 minutes.', newEmail });

    must(await db().from('br_login_codes').update({ used_at: new Date().toISOString() }).eq('registrant_id', r.id).eq('purpose', 'change_email').is('used_at', null), 'Cancel old');
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const row = must(await db().from('br_login_codes').insert({ registrant_id: r.id, purpose: 'change_email', new_email: newEmail,
      code_hash: codeHash(`change:${r.id}`, code), expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), ip: req.ip }).select('id').single(), 'Code');
    await sendOnce({ dedupeKey: `email_change_code:${row.id}`, registrantId: r.id, templateKey: 'email_change_code', to: newEmail, vars: { ...registrantVars(r), code } });
    return res.redirect(303, '/portal/account/email/verify');
  } catch (err) { next(err); }
});

async function pendingChange(registrantId) {
  return must(await db().from('br_login_codes').select('*').eq('registrant_id', registrantId).eq('purpose', 'change_email')
    .is('used_at', null).gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).maybeSingle(), 'Pending change');
}

router.get('/account/email/verify', async (req, res, next) => {
  try {
    const pending = await pendingChange(req.registrant.id);
    if (!pending) return res.redirect('/portal/account');
    res.render('portal/account-verify', { pageTitle: 'Confirm New Email', newEmail: pending.new_email, error: null });
  } catch (err) { next(err); }
});

router.post('/account/email/verify', limiter, async (req, res, next) => {
  try {
    const r = req.registrant;
    const pending = await pendingChange(r.id);
    if (!pending) return res.redirect(303, '/portal/account');
    const fail = m => res.status(401).render('portal/account-verify', { pageTitle: 'Confirm New Email', newEmail: pending.new_email, error: m });
    const code = typeof req.body.code === 'string' ? req.body.code.replace(/\D/g, '') : '';
    if (pending.attempts >= 5) return fail('Too many incorrect attempts. Please start the change again.');
    const given = Buffer.from(codeHash(`change:${r.id}`, code), 'hex');
    const want = Buffer.from(pending.code_hash, 'hex');
    if (code.length !== 6 || given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      await db().from('br_login_codes').update({ attempts: pending.attempts + 1 }).eq('id', pending.id);
      return fail('That code is incorrect or has expired.');
    }
    must(await db().from('br_login_codes').update({ used_at: new Date().toISOString() }).eq('id', pending.id), 'Use code');
    const { error } = await db().from('br_registrants').update({ email: pending.new_email, email_verified_at: new Date().toISOString() }).eq('id', r.id);
    if (error) return fail(error.code === '23505' ? 'That email address can\'t be used. Please choose another.' : 'Could not change your email.');
    await logEvent({ registrantId: r.id, event: 'email_changed', actor: 'registrant', ip: req.ip });
    // Tell the OLD address, in case this wasn't them.
    sendQuietly({ dedupeKey: `email_changed:${pending.id}`, registrantId: r.id, templateKey: 'email_changed', to: r.email, vars: { ...registrantVars(r), new_email: pending.new_email } });
    return res.redirect(303, '/portal/account?msg=' + encodeURIComponent('Your email address has been changed.'));
  } catch (err) { next(err); }
});

// ---------- delete my data ----------

router.get('/account/delete', (req, res) => res.render('portal/account-delete', { pageTitle: 'Delete My Data', error: null }));

router.post('/account/delete', async (req, res, next) => {
  try {
    const r = req.registrant;
    if (r.account_status === 'deletion_requested') return res.redirect(303, '/portal/account');
    if (req.body.confirm !== 'yes') return res.status(422).render('portal/account-delete', { pageTitle: 'Delete My Data', error: 'Please tick the box to confirm.' });
    // Stop future charges now; the deletion itself is completed by an administrator.
    const live = await billing.liveSubscriptionOf(r.id);
    if (live && !live.cancel_at_period_end) {
      try { await billing.setAutoRenew(r.id, false); } catch (err) { console.error('Cancel on deletion request failed:', err.message); }
    }
    must(await db().from('br_registrants').update({ account_status: 'deletion_requested', deletion_requested_at: new Date().toISOString() }).eq('id', r.id), 'Request deletion');
    await createRequest({ registrantId: r.id, contactEmail: r.email, name: [r.legal_first_name, r.legal_last_name].filter(Boolean).join(' '),
      category: 'data_deletion', message: 'Deletion requested from the portal.', firstName: r.legal_first_name, ip: req.ip });
    return res.redirect(303, '/portal/account?msg=' + encodeURIComponent('Your deletion request was received. We will complete it within 30 days and email you when it is done.'));
  } catch (err) { next(err); }
});

router.post('/confirm-info', async (req, res, next) => {
  try {
    must(await db().from('br_registrants').update({ info_confirmed_at: new Date().toISOString() }).eq('id', req.registrant.id), 'Confirm info');
    await logEvent({ registrantId: req.registrant.id, event: 'info_confirmed', actor: 'registrant', ip: req.ip });
    return res.redirect(303, '/portal/dashboard');
  } catch (err) { next(err); }
});

module.exports = router;
