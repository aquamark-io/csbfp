/**
 * For Employers (public, no sign-in).
 *
 *   GET  /employers                     request an Employer ID, buy credits, check a balance
 *   POST /employers/request             create an Employer ID (live immediately; emailed to the contact)
 *   POST /employers/buy                 Employer ID + email on file + quantity -> Stripe Checkout (one-time payment)
 *   GET  /employers/purchase/return     after Stripe: add the credits (the webhook does the same, once)
 *   POST /employers/balance             Employer ID + email on file -> purchased / used / remaining
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../lib/config');
const employers = require('../lib/employers');
const { paymentsReady } = require('../lib/stripe');
const { validEmail, normEmail } = require('../lib/validate');
const turnstile = require('../lib/turnstile');

const router = express.Router();

const view = (res, extra = {}, status = 200) => res.status(status).render('employers', {
  pageTitle: 'For Employers', created: null, balance: null, error: null, section: null, values: {}, turnstileKey: turnstile.siteKey(),
  canceled: false, ...extra,
});
const limiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => view(res, { error: 'Too many requests from this network. Please try again later.' }, 429) });
const clean = (x, max) => (typeof x === 'string' ? x.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const unavailable = res => view(res, { error: 'This is temporarily unavailable. Please try again later.' }, 503);

router.get('/employers', (req, res) => view(res, { canceled: req.query.canceled === '1' }));

router.post('/employers/request', limiter, async (req, res, next) => {
  try {
    if (!config.portalReady()) return unavailable(res);
    const values = { company_name: clean(req.body.company_name, 120), contact_name: clean(req.body.contact_name, 80), email: normEmail(req.body.email) };
    if (req.body.website) return view(res); // honeypot
    if (turnstile.enabled() && !(await turnstile.verify(req.body['cf-turnstile-response'], req.ip))) {
      return view(res, { section: 'request', values, error: 'Please complete the verification check and try again.' }, 422);
    }
    if (!values.company_name || !values.contact_name || !validEmail(values.email)) {
      return view(res, { section: 'request', values, error: 'Please enter the company name, a contact name and a valid email address.' }, 422);
    }
    const employer = await employers.create({ companyName: values.company_name, contactName: values.contact_name, email: values.email });
    return view(res, { section: 'request', created: employer });
  } catch (err) { next(err); }
});

router.post('/employers/buy', limiter, async (req, res, next) => {
  try {
    if (!config.portalReady()) return unavailable(res);
    const values = { employer_number: clean(req.body.employer_number, 20), email: normEmail(req.body.email), quantity: clean(req.body.quantity, 4) };
    const qty = /^\d+$/.test(values.quantity) ? Number(values.quantity) : 0;
    if (qty < 1 || qty > employers.MAX_QTY) return view(res, { section: 'buy', values, error: `Enter a quantity from 1 to ${employers.MAX_QTY}.` }, 422);
    const employer = await employers.find(values.employer_number, values.email);
    if (!employer) return view(res, { section: 'buy', values, error: 'That Employer ID and email don\'t match our records.' }, 422);
    if (!(await paymentsReady())) return view(res, { section: 'buy', values, error: 'Payments are not available right now. Please try again later.' }, 503);
    const session = await employers.createCheckout(employer, qty);
    return res.redirect(303, session.url);
  } catch (err) { next(err); }
});

router.get('/employers/purchase/return', async (req, res, next) => {
  try {
    const id = typeof req.query.session_id === 'string' && /^cs_[A-Za-z0-9_]+$/.test(req.query.session_id) ? req.query.session_id : null;
    let result = null;
    if (id && config.portalReady()) {
      try { result = await employers.fulfill(id); } catch (err) { console.error('Employer purchase sync failed:', err.message); }
    }
    if (!result || !result.employer) return view(res, { section: 'buy', error: 'We\'re confirming your payment. Your credits will appear shortly, and we\'ll email you when they do.' });
    return view(res, { section: 'balance', balance: { employer: result.employer, remaining: employers.balanceOf(result.employer), purchasedNow: result.purchase.quantity } });
  } catch (err) { next(err); }
});

router.post('/employers/balance', limiter, async (req, res, next) => {
  try {
    if (!config.portalReady()) return unavailable(res);
    const values = { employer_number: clean(req.body.employer_number, 20), email: normEmail(req.body.email) };
    const employer = await employers.find(values.employer_number, values.email);
    if (!employer) return view(res, { section: 'balance', values, error: 'That Employer ID and email don\'t match our records.' }, 422);
    return view(res, { section: 'balance', balance: { employer, remaining: employers.balanceOf(employer) } });
  } catch (err) { next(err); }
});

module.exports = router;
