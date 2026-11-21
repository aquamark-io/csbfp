/**
 * Public contact form: GET/POST /support  (/contact redirects here)
 * Signed-in registrants have their email filled in and the request linked to their account.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../lib/supabase');
const { readSession } = require('../lib/session');
const turnstile = require('../lib/turnstile');
const { normEmail, validEmail } = require('../lib/validate');
const { CATEGORIES, createRequest } = require('../lib/support');
const config = require('../lib/config');

const router = express.Router();
const FORM_CATEGORIES = ['account_recovery', 'data_correction', 'billing', 'duplicate_review', 'assessment_reset', 'data_deletion', 'other'];

const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => res.status(429).render('support', { pageTitle: 'Contact Us', values: req.body || {}, errors: {}, sent: null,
    error: `Too many messages from this network. Please try again later or email ${config.program.supportEmail}.`, categories: FORM_CATEGORIES, labels: CATEGORIES, turnstileKey: turnstile.siteKey() }) });

async function signedIn(req) {
  const s = readSession(req);
  if (!s || !config.portalReady()) return null;
  const { data } = await db().from('csbfp_registrants').select('id, email, legal_first_name, legal_last_name').eq('id', s.sub).maybeSingle();
  return data || null;
}

const view = (res, extra) => res.status(extra.status || 200).render('support', { pageTitle: 'Contact Us', values: {}, errors: {}, sent: null, error: null,
  categories: FORM_CATEGORIES, labels: CATEGORIES, turnstileKey: turnstile.siteKey(), ...extra });

router.get('/contact', (req, res) => res.redirect(301, '/support'));

router.get('/support', async (req, res, next) => {
  try {
    const me = await signedIn(req).catch(() => null);
    const topic = FORM_CATEGORIES.includes(req.query.topic) ? req.query.topic : '';
    view(res, { values: me ? { email: me.email, name: [me.legal_first_name, me.legal_last_name].filter(Boolean).join(' '), category: topic } : { category: topic } });
  } catch (err) { next(err); }
});

router.post('/support', limiter, async (req, res, next) => {
  try {
    const values = { name: String(req.body.name || '').trim().slice(0, 100), email: String(req.body.email || '').slice(0, 254),
      category: req.body.category, message: String(req.body.message || '').trim().slice(0, 5000) };
    if (req.body.website) return view(res, { sent: { reference: 'received' } }); // honeypot
    if (!config.portalReady()) return view(res, { status: 503, values, error: `The contact form is temporarily unavailable. Please email ${config.program.supportEmail}.` });
    if (!(await turnstile.verify(req.body['cf-turnstile-response'], req.ip))) return view(res, { status: 422, values, error: 'Please complete the verification check and try again.' });
    const errors = {};
    const email = normEmail(values.email);
    if (!validEmail(email)) errors.email = 'Please enter a valid email address.';
    if (!FORM_CATEGORIES.includes(values.category)) errors.category = 'Please choose a topic.';
    if (values.message.length < 5) errors.message = 'Please tell us how we can help.';
    if (Object.keys(errors).length) return view(res, { status: 422, values, errors });

    const me = await signedIn(req).catch(() => null);
    let registrantId = me ? me.id : null;
    if (!registrantId) {
      const { data } = await db().from('csbfp_registrants').select('id').eq('email', email).maybeSingle();
      registrantId = data ? data.id : null; // linked for the admin; the sender is not told whether an account exists
    }
    const sent = await createRequest({ registrantId, contactEmail: email, name: values.name, category: values.category, message: values.message,
      firstName: me ? me.legal_first_name : null, ip: req.ip });
    return view(res, { sent });
  } catch (err) { next(err); }
});

module.exports = router;
