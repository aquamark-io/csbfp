/**
 * Certification fee, Stripe Checkout and billing for signed-in applicants and certificants.
 *
 *   GET/POST /portal/checkout              fee + automatic-renewal terms + consent -> Stripe Checkout
 *   GET      /portal/checkout/return       back from Stripe; activates if paid (the webhook does the same)
 *   GET      /portal/billing               fee, renewal date, payment history, manage / cancel / resume
 *   POST     /portal/billing/manage        Stripe billing portal (update card, receipts)
 *   GET/POST /portal/billing/cancel        cancel automatic renewal (confirm page)
 *   POST     /portal/billing/resume        turn automatic renewal back on
 *   GET      /portal/billing/pay           pay the open renewal invoice (inactive registrations)
 *   GET      /portal/confirmation          printable certificate
 */
const crypto = require('crypto');
const express = require('express');
const config = require('../lib/config');
const { db, must } = require('../lib/supabase');
const { paymentsReady } = require('../lib/stripe');
const billing = require('../lib/billing');
const legal = require('../lib/legal');
const training = require('../lib/training');
const { progressFor } = require('../lib/progress');
const { hasOpenFlag } = require('../lib/duplicates');
const { logEvent } = require('../lib/events');
const { requireRegistrant } = require('../middleware/auth');

const router = express.Router();
router.use(['/checkout', '/billing', '/confirmation'], requireRegistrant);

const FEE = config.program.annualFee;

async function statusFor(registrant) {
  const [progress, train, flagged] = await Promise.all([progressFor(registrant), training.stateFor(registrant.id), hasOpenFlag(registrant.id)]);
  return billing.paymentStatus(registrant, { progress, train, flagged });
}

// ---------- checkout ----------

async function checkoutView(req, res, { status = 200, error = null } = {}) {
  const pay = await statusFor(req.registrant);
  const doc = await legal.currentDoc('terms');
  const renewsOn = new Date();
  renewsOn.setFullYear(renewsOn.getFullYear() + 1);
  res.status(status).render('portal/checkout', {
    pageTitle: 'Certification Fee', pay, doc, fee: FEE, error,
    renewsOn: renewsOn.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' }),
    ready: await paymentsReady(), canceled: req.query.canceled === '1',
  });
}

router.get('/checkout', (req, res, next) => checkoutView(req, res).catch(next));

router.post('/checkout', async (req, res, next) => {
  try {
    if (!(await paymentsReady())) return checkoutView(req, res, { status: 503, error: 'Payments are not available right now. Please try again later.' });
    const pay = await statusFor(req.registrant);
    if (pay.action === 'pay_invoice') return res.redirect(303, '/portal/billing');
    if (pay.action !== 'checkout') return res.redirect(303, '/portal/checkout');
    if (pay.live) return res.redirect(303, '/portal/billing'); // already subscribed
    if (req.body.agree_renewal !== 'yes') {
      return checkoutView(req, res, { status: 422, error: 'Please confirm that you agree to automatic annual renewal.' });
    }
    // Evidence of consent: the exact terms versions, time, IP and browser, tied to this checkout.
    const ref = crypto.randomUUID();
    await legal.recordAcceptance({ registrantId: req.registrant.id, keys: ['terms'], context: 'checkout',
      ref, ip: req.ip, userAgent: req.get('user-agent') });
    const session = await billing.createCheckout(req.registrant, pay.registration, { acceptanceRef: ref });
    await db().from('csbfp_legal_acceptances').update({ ref: session.id }).eq('registrant_id', req.registrant.id).eq('ref', ref);
    await logEvent({ registrantId: req.registrant.id, event: 'checkout_started', actor: 'registrant', ip: req.ip });
    return res.redirect(303, session.url);
  } catch (err) { next(err); }
});

router.get('/checkout/return', async (req, res, next) => {
  try {
    const sessionId = typeof req.query.session_id === 'string' && /^cs_[A-Za-z0-9_]+$/.test(req.query.session_id) ? req.query.session_id : null;
    let result = { activated: false };
    if (sessionId) {
      try {
        const session = await require('../lib/stripe').stripe().checkout.sessions.retrieve(sessionId, { expand: ['subscription', 'subscription.latest_invoice'] });
        // Only for this registrant's own session.
        const reg = await billing.registrationOf(req.registrant.id);
        if (session.client_reference_id === reg.id) result = await billing.syncCheckoutSession(session, session.id);
      } catch (err) {
        console.error('Checkout return sync failed:', err.message); // the webhook will still activate
      }
    }
    const registration = await billing.registrationOf(req.registrant.id);
    res.render('portal/checkout-return', { pageTitle: 'Payment Received', registration, activated: registration.status === 'active', held: ['pending_screening', 'under_review'].includes(registration.status) });
  } catch (err) { next(err); }
});

// ---------- billing ----------

router.get('/billing', async (req, res, next) => {
  try {
    const registration = await billing.registrationOf(req.registrant.id);
    const [live, payments] = await Promise.all([
      billing.liveSubscriptionOf(req.registrant.id),
      db().from('csbfp_payments').select('*').eq('registrant_id', req.registrant.id).order('created_at', { ascending: false }),
    ]);
    res.render('portal/billing', { pageTitle: 'Billing', registration, live, payments: must(payments, 'Payments'), fee: FEE,
      msg: typeof req.query.msg === 'string' ? req.query.msg.slice(0, 200) : null, ready: await paymentsReady() });
  } catch (err) { next(err); }
});

router.post('/billing/manage', async (req, res, next) => {
  try {
    const registration = await billing.registrationOf(req.registrant.id);
    if (!registration.stripe_customer_id) return res.redirect(303, '/portal/billing');
    return res.redirect(303, await billing.portalUrl(registration));
  } catch (err) { next(err); }
});

router.get('/billing/cancel', async (req, res, next) => {
  try {
    const registration = await billing.registrationOf(req.registrant.id);
    const live = await billing.liveSubscriptionOf(req.registrant.id);
    if (!live || live.cancel_at_period_end) return res.redirect('/portal/billing');
    res.render('portal/billing-cancel', { pageTitle: 'Cancel Automatic Renewal', registration, live });
  } catch (err) { next(err); }
});

router.post('/billing/cancel', async (req, res, next) => {
  try {
    await billing.setAutoRenew(req.registrant.id, false);
    await logEvent({ registrantId: req.registrant.id, event: 'auto_renewal_canceled', actor: 'registrant', ip: req.ip });
    return res.redirect(303, '/portal/billing?msg=' + encodeURIComponent('Automatic renewal is canceled. Your registration stays active through the date shown.'));
  } catch (err) { next(err); }
});

router.post('/billing/resume', async (req, res, next) => {
  try {
    await billing.setAutoRenew(req.registrant.id, true);
    await logEvent({ registrantId: req.registrant.id, event: 'auto_renewal_resumed', actor: 'registrant', ip: req.ip });
    return res.redirect(303, '/portal/billing?msg=' + encodeURIComponent('Automatic renewal is back on.'));
  } catch (err) { next(err); }
});

router.get('/billing/pay', async (req, res, next) => {
  try {
    const live = await billing.liveSubscriptionOf(req.registrant.id);
    const url = live ? await billing.openInvoiceUrl(live) : null;
    if (!url) return res.redirect('/portal/billing?msg=' + encodeURIComponent('There is nothing to pay right now.'));
    return res.redirect(303, url);
  } catch (err) { next(err); }
});

// ---------- confirmation ----------

router.get('/confirmation', async (req, res, next) => {
  try {
    const registration = await billing.registrationOf(req.registrant.id);
    if (!registration.registration_number) return res.redirect('/portal/dashboard');
    res.render('portal/confirmation', { pageTitle: 'Certificate', registration, r: req.registrant });
  } catch (err) { next(err); }
});

module.exports = router;
