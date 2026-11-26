/**
 * Certification billing lifecycle (statuses: see lib/certification.js). Stripe is the source of truth for money; csbfp_registrations is the source of truth
 * for status. Every function here is safe to run more than once for the same Stripe object (webhooks retry, and the
 * checkout return page and the webhook can both arrive).
 *
 *   Pay (first time)          pending  -> pending_screening (screening on) or DEMO credential (screening off);
 *                                                    the genuine number and term start on reviewer approval
 *   Renewal paid              active   -> active    valid through extended to the new period end
 *   Renewal payment failed    active   -> inactive  they pay the open invoice to reactivate
 *   Open renewal paid later   inactive -> active
 *   Auto-renewal canceled     stays active until valid-through, then expired (daily job)
 *   Suspended / revoked       payments are recorded but never change these statuses (admin decisions)
 *   Rejoin after expiry       expired / inactive with no live subscription -> new checkout -> active, same number
 */
const { db, must } = require('./supabase');
const { stripe, stripeConfig } = require('./stripe');
const { logEvent } = require('./events');
const { sendQuietly, registrantVars, fmtDate } = require('./email');
const config = require('./config');
const certification = require('./certification');

const APP = 'csbfp';
const iso = t => (t ? new Date(t * 1000).toISOString() : null);
const LIVE_SUB_STATUSES = ['active', 'trialing', 'past_due', 'incomplete', 'unpaid'];

// ---------- lookups ----------

async function registrationOf(registrantId) {
  return must(await db().from('csbfp_registrations').select('*').eq('registrant_id', registrantId).single(), 'Registration');
}

async function liveSubscriptionOf(registrantId) {
  const rows = must(await db().from('csbfp_subscriptions').select('*').eq('registrant_id', registrantId).order('created_at', { ascending: false }), 'Subscriptions');
  return rows.find(s => LIVE_SUB_STATUSES.includes(s.stripe_status)) || null;
}

// Period of a subscription (newer API versions keep it on the subscription item).
function periodOf(sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  return {
    start: iso((item && item.current_period_start) || sub.current_period_start),
    end: iso((item && item.current_period_end) || sub.current_period_end),
  };
}

const subscriptionIdOfInvoice = inv => {
  const s = (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription) || inv.subscription || null;
  return s && typeof s === 'object' ? s.id : s;
};

function invoicePeriod(inv) {
  const line = inv.lines && inv.lines.data && inv.lines.data.find(l => l.period) ;
  return line ? { start: iso(line.period.start), end: iso(line.period.end) } : { start: iso(inv.period_start), end: iso(inv.period_end) };
}

// ---------- eligibility ----------

/**
 * What the registrant can do about payment right now.
 * action: 'checkout' (first time or rejoin), 'pay_invoice' (renewal failed), 'none' (active or blocked)
 */
async function paymentStatus(registrant, { progress, train, flagged }) {
  const registration = await registrationOf(registrant.id);
  const live = await liveSubscriptionOf(registrant.id);
  const reasons = [];
  // Employer-paid year: no card on file. They can add one any time; billing starts when the paid year ends.
  if (registration.status === 'active' && registration.paid_by_employer_id && !live) {
    return { action: 'add_card', registration, live, reasons };
  }
  if (['active', 'pending_screening', 'under_review', 'not_approved', 'suspended', 'revoked'].includes(registration.status)) {
    return { action: 'none', registration, live, reasons };
  }
  if (registration.status === 'inactive' && live) return { action: 'pay_invoice', registration, live, reasons };

  if (!progress.infoComplete) reasons.push('Complete your application information and acknowledgments.');
  if (!train.allComplete) reasons.push('Complete the training modules.');
  if (!(train.assessment && train.assessment.passed)) reasons.push('Pass the assessment.');
  if (flagged) reasons.push(`We need to confirm a few details first. Please contact ${config.program.supportEmail}.`);
  if (registration.admin_hold) reasons.push(`Your application is on hold. Please contact ${config.program.supportEmail}.`);
  if (registration.retired_at || registrant.account_status !== 'active') reasons.push(`This account cannot be certified. Please contact ${config.program.supportEmail}.`);
  return { action: reasons.length ? 'none' : 'checkout', registration, live, reasons, rejoin: Boolean(registration.first_activated_at) };
}

// ---------- checkout ----------

async function customerFor(registrant, registration) {
  if (registration.stripe_customer_id) return registration.stripe_customer_id;
  const name = [registrant.legal_first_name, registrant.legal_last_name].filter(Boolean).join(' ') || undefined;
  const customer = await stripe().customers.create({
    email: registrant.email, name,
    metadata: { app: APP, registrant_id: registrant.id, registration_id: registration.id },
  }, { idempotencyKey: `customer:${registration.id}` });
  must(await db().from('csbfp_registrations').update({ stripe_customer_id: customer.id }).eq('id', registration.id).is('stripe_customer_id', null), 'Save customer');
  const fresh = await registrationOf(registrant.id);
  return fresh.stripe_customer_id;
}

async function createCheckout(registrant, registration, { acceptanceRef, trialEnd = null }) {
  const { priceId } = await stripeConfig();
  const customer = await customerFor(registrant, registration);
  const meta = { app: APP, registrant_id: registrant.id, registration_id: registration.id };
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer,
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: registration.id,
    metadata: meta,
    // trialEnd: card added during an employer-paid year; the first charge happens when that year ends.
    subscription_data: { metadata: meta, description: `${config.program.short} annual certification`,
      ...(trialEnd && trialEnd.getTime() > Date.now() + 3 * 864e5 ? { trial_end: Math.floor(trialEnd.getTime() / 1000) } : {}) },
    success_url: `${config.siteUrl}/portal/checkout/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.siteUrl}/portal/checkout?canceled=1`,
  }, { idempotencyKey: `checkout:${registration.id}:${acceptanceRef}` });
  return session;
}

// ---------- syncing from Stripe ----------

async function upsertSubscription(sub, registration) {
  const p = periodOf(sub);
  const row = {
    registrant_id: registration.registrant_id, registration_id: registration.id,
    stripe_customer_id: typeof sub.customer === 'object' ? sub.customer.id : sub.customer,
    stripe_subscription_id: sub.id, stripe_status: sub.status,
    cancel_at_period_end: Boolean(sub.cancel_at_period_end || sub.cancel_at),
    current_period_start: p.start, current_period_end: p.end,
    canceled_at: iso(sub.canceled_at || sub.ended_at),
  };
  const existing = must(await db().from('csbfp_subscriptions').select('*').eq('stripe_subscription_id', sub.id).maybeSingle(), 'Subscription');
  if (existing) {
    must(await db().from('csbfp_subscriptions').update(row).eq('id', existing.id), 'Update subscription');
    if (!existing.cancel_at_period_end && row.cancel_at_period_end && !['canceled', 'incomplete_expired'].includes(sub.status)) {
      await notify(registration, 'auto_renewal_canceled', `auto_renewal_canceled:${sub.id}:${row.current_period_end}`, { end_date: fmtDate(row.current_period_end) });
    }
    return { ...existing, ...row, previous: existing };
  }
  const { data, error } = await db().from('csbfp_subscriptions').insert(row).select('*').single();
  if (error && error.code === '23505') return upsertSubscription(sub, registration); // created concurrently
  if (error) throw new Error(`Insert subscription: ${error.message}`);
  return { ...data, previous: null };
}

async function registrationForSubscription(sub) {
  const meta = sub.metadata || {};
  if (meta.registration_id) {
    const r = must(await db().from('csbfp_registrations').select('*').eq('id', meta.registration_id).maybeSingle(), 'Registration');
    if (r) return r;
  }
  const known = must(await db().from('csbfp_subscriptions').select('registration_id').eq('stripe_subscription_id', sub.id).maybeSingle(), 'Known subscription');
  if (known) return must(await db().from('csbfp_registrations').select('*').eq('id', known.registration_id).single(), 'Registration');
  return null;
}

async function recordInvoice(inv, subRow, registration) {
  const billingReason = inv.billing_reason === 'subscription_cycle' ? 'renewal'
    : registration.first_activated_at && inv.billing_reason === 'subscription_create' && Date.parse(registration.first_activated_at) < inv.created * 1000 - 60000 ? 'reactivation'
      : 'initial';
  const status = inv.status === 'paid' ? 'paid' : inv.status === 'open' && inv.attempt_count > 0 ? 'failed' : inv.status === 'open' ? 'open' : 'open';
  const p = invoicePeriod(inv);
  const row = {
    registrant_id: registration.registrant_id, registration_id: registration.id, subscription_id: subRow ? subRow.id : null,
    stripe_invoice_id: inv.id, amount_cents: inv.status === 'paid' ? inv.amount_paid : inv.amount_due, currency: inv.currency || 'usd',
    billing_reason: billingReason, status, period_start: p.start, period_end: p.end,
    hosted_invoice_url: inv.hosted_invoice_url || null,
    paid_at: inv.status_transitions && inv.status_transitions.paid_at ? iso(inv.status_transitions.paid_at) : null,
    failure_message: inv.last_finalization_error ? String(inv.last_finalization_error.message || '').slice(0, 300) : null,
  };
  const existing = must(await db().from('csbfp_payments').select('id, status').eq('stripe_invoice_id', inv.id).maybeSingle(), 'Payment');
  if (existing) {
    if (existing.status === 'paid' && status !== 'paid') return existing; // never downgrade a paid record
    if (['refunded', 'partially_refunded'].includes(existing.status)) return existing; // a refund recorded later stays
    must(await db().from('csbfp_payments').update(row).eq('id', existing.id), 'Update payment');
    return existing;
  }
  const { error } = await db().from('csbfp_payments').insert(row);
  if (error && error.code !== '23505') throw new Error(`Insert payment: ${error.message}`);
  return row;
}

async function setStatus(registration, to, reason, sourceRef) {
  await certification.setStatus(registration, to, { reason, actorType: 'stripe', sourceRef: sourceRef || null });
}

/**
 * A payment was confirmed for `periodStart`..`periodEnd`. Returns { number, wasActive, held }:
 *   - new application (pending): hand over to the certification lifecycle (screening / demo issue)
 *   - application in screening or review, not approved, revoked: payment recorded only
 *   - suspended: valid-through extended, status stays suspended
 *   - otherwise (certified, inactive, expired rejoin): certified through the period end, same number
 */
async function activate(registration, { periodStart, periodEnd, reason, sourceRef }) {
  if (registration.status === 'pending') {
    const r = await certification.afterInitialPayment(registration, { periodStart, periodEnd, sourceRef });
    return { number: r.number, wasActive: true, held: r.held };
  }
  if (['pending_screening', 'under_review', 'not_approved', 'revoked'].includes(registration.status)) {
    return { number: registration.registration_number, wasActive: true, held: true };
  }
  const update = { current_period_start: periodStart, expires_at: periodEnd };
  if (!registration.first_activated_at) update.first_activated_at = new Date().toISOString();
  // Never move the valid-through date backwards (events can arrive out of order).
  if (registration.expires_at && Date.parse(registration.expires_at) > Date.parse(periodEnd)) {
    delete update.expires_at; delete update.current_period_start;
  }
  if (Object.keys(update).length) must(await db().from('csbfp_registrations').update(update).eq('id', registration.id), 'Activate dates');
  if (registration.status === 'suspended') return { number: registration.registration_number, wasActive: true, held: true };
  const number = await certification.assignNumber(registration, { demo: registration.is_demo });
  const wasActive = registration.status === 'active';
  await setStatus(registration, 'active', reason, sourceRef);
  return { number, wasActive };
}

// Send a lifecycle email to the registrant behind a registration (at most once per dedupe key).
async function notify(registration, templateKey, dedupeKey, vars = {}) {
  const registrant = must(await db().from('csbfp_registrants').select('*').eq('id', registration.registrant_id).single(), 'Registrant');
  if (!registrant.email || registrant.account_status === 'deleted') return;
  const fresh = must(await db().from('csbfp_registrations').select('*').eq('id', registration.id).single(), 'Registration');
  await sendQuietly({ dedupeKey, registrantId: registrant.id, templateKey, to: registrant.email,
    vars: { ...registrantVars(registrant), number: fresh.registration_number, amount: config.program.annualFee, valid_through: fmtDate(fresh.expires_at), ...vars } });
}

// Expire a registration (end of a canceled or ended period) and tell the registrant.
async function expire(registration, reason, sourceRef) {
  await setStatus(registration, 'expired', reason, sourceRef);
  await logEvent({ registrantId: registration.registrant_id, event: 'registration_expired', actor: 'system' });
  await notify(registration, 'registration_expired', `expired:${registration.id}:${registration.expires_at}`, { expired_on: fmtDate(registration.expires_at) });
}

// Reactivated (renewal paid after a failure, or rejoined after expiry).
async function notifyActivated(registration, number) {
  const fresh = must(await db().from('csbfp_registrations').select('*').eq('id', registration.id).single(), 'Registration');
  await notify(registration, 'certification_reactivated', `activated:${registration.id}:${fresh.expires_at}`, { number });
}

/**
 * Bring our records in line with a subscription, activating when its first invoice is paid.
 * Used by the checkout return page and by checkout.session.completed.
 */
async function syncCheckoutSession(sessionOrId, sourceRef) {
  const session = typeof sessionOrId === 'string'
    ? await stripe().checkout.sessions.retrieve(sessionOrId, { expand: ['subscription', 'subscription.latest_invoice'] })
    : sessionOrId;
  if (!session || session.mode !== 'subscription' || !session.subscription) return { activated: false };
  const sub = typeof session.subscription === 'object' ? session.subscription
    : await stripe().subscriptions.retrieve(session.subscription, { expand: ['latest_invoice'] });
  return syncSubscriptionAndActivate(sub, sourceRef || session.id);
}

async function syncSubscriptionAndActivate(sub, sourceRef) {
  const registration = await registrationForSubscription(sub);
  if (!registration) return { activated: false, ignored: true };
  const subRow = await upsertSubscription(sub, registration);
  let inv = sub.latest_invoice;
  if (inv && typeof inv === 'string') inv = await stripe().invoices.retrieve(inv);
  if (inv) await recordInvoice(inv, subRow, registration);
  const paid = inv && inv.status === 'paid';
  if (paid && ['active', 'trialing'].includes(sub.status)) {
    const p = periodOf(sub);
    const reason = registration.status === 'pending' ? 'Certification fee paid'
      : registration.status === 'expired' ? 'Rejoined: certification fee paid'
        : registration.status === 'inactive' ? 'Renewal paid' : 'Payment received';
    const { number, wasActive, held } = await activate(registration, { periodStart: p.start, periodEnd: p.end, reason, sourceRef });
    if (!wasActive && !held) {
      await logEvent({ registrantId: registration.registrant_id, event: 'registration_activated', actor: 'stripe', detail: { number } });
      await notifyActivated(registration, number);
    }
    return { activated: true, number };
  }
  return { activated: false };
}

// ---------- employer credits ----------

/** Pay for a new application (or a rejoin after expiry) with one employer credit. No subscription is created. */
async function payWithEmployerCredit(registrant, registration, employerNumber) {
  const employers = require('./employers');
  const result = await employers.useCredit(employerNumber, registration.id);
  if (!result.ok) return result;
  const start = new Date();
  const periodEnd = new Date(start.getTime() + 365 * 864e5).toISOString();
  const sourceRef = `employer:${result.employer.employer_number}`;
  if (registration.status === 'pending') {
    await certification.afterInitialPayment({ ...registration, paid_by_employer_id: result.employer.id },
      { periodStart: start.toISOString(), periodEnd, sourceRef, actorType: 'system' });
  } else {
    const { number } = await activate(registration, { periodStart: start.toISOString(), periodEnd, reason: 'Rejoined: paid by employer credit', sourceRef });
    await notifyActivated(registration, number);
  }
  await logEvent({ registrantId: registrant.id, event: 'paid_by_employer', actor: 'registrant', detail: { employer: result.employer.employer_number } });
  return { ok: true };
}

// ---------- webhooks ----------

async function handleInvoice(inv, event) {
  const subId = subscriptionIdOfInvoice(inv);
  if (!subId) return 'ignored: no subscription';
  const sub = await stripe().subscriptions.retrieve(subId);
  if ((sub.metadata || {}).app && sub.metadata.app !== APP) return 'ignored: other app';
  const registration = await registrationForSubscription(sub);
  if (!registration) return 'ignored: unknown subscription';
  const subRow = await upsertSubscription(sub, registration);
  await recordInvoice(inv, subRow, registration);

  if (event.type === 'invoice.paid') {
    const p = invoicePeriod(inv);
    const reason = registration.status === 'inactive' ? 'Renewal paid'
      : registration.status === 'expired' ? 'Rejoined: certification fee paid'
        : registration.status === 'pending' ? 'Certification fee paid' : 'Renewal paid';
    const { number, wasActive, held } = await activate(registration, { periodStart: p.start, periodEnd: p.end, reason, sourceRef: event.id });
    if (inv.billing_reason === 'subscription_cycle' && !held) {
      await logEvent({ registrantId: registration.registrant_id, event: 'renewal_paid', actor: 'stripe' });
      await notify(registration, 'renewal_succeeded', `renewal_paid:${inv.id}`, { receipt_url: inv.hosted_invoice_url || '' });
    } else if (!wasActive && !held) {
      await logEvent({ registrantId: registration.registrant_id, event: 'registration_activated', actor: 'stripe', detail: { number } });
      await notifyActivated(registration, number);
    }
    return 'paid';
  }

  if (event.type === 'invoice.payment_failed') {
    if (inv.billing_reason === 'subscription_cycle' && registration.status === 'active') {
      await setStatus(registration, 'inactive', 'Renewal payment failed', event.id);
      await logEvent({ registrantId: registration.registrant_id, event: 'renewal_failed', actor: 'stripe' });
    }
    if (inv.billing_reason === 'subscription_cycle') await notify(registration, 'renewal_failed', `renewal_failed:${inv.id}`);
    return 'failed';
  }
  return 'recorded';
}

async function handleSubscription(sub, event) {
  if ((sub.metadata || {}).app && sub.metadata.app !== APP) return 'ignored: other app';
  const registration = await registrationForSubscription(sub);
  if (!registration) return 'ignored: unknown subscription';
  const row = await upsertSubscription(sub, registration);
  const before = row.previous;
  if (before && before.cancel_at_period_end !== row.cancel_at_period_end) {
    await logEvent({ registrantId: registration.registrant_id, event: row.cancel_at_period_end ? 'auto_renewal_canceled' : 'auto_renewal_resumed', actor: 'stripe' });
  }
  if (event.type === 'customer.subscription.deleted') {
    await logEvent({ registrantId: registration.registrant_id, event: 'subscription_ended', actor: 'stripe' });
    // Active registrations run to their valid-through date (the daily job expires them). Inactive ones stay inactive.
    if (registration.status === 'active' && registration.expires_at && Date.parse(registration.expires_at) <= Date.now()) {
      await expire(registration, 'Registration period ended without renewal', event.id);
    }
  }
  return 'synced';
}

/**
 * Process one verified Stripe event exactly once (csbfp_stripe_events). Returns a short result string.
 */
async function handleEvent(event) {
  const { error: insErr } = await db().from('csbfp_stripe_events').insert({ id: event.id, type: event.type });
  if (insErr && insErr.code !== '23505') throw new Error(`Event log: ${insErr.message}`);
  if (insErr) {
    const prior = must(await db().from('csbfp_stripe_events').select('processed_at').eq('id', event.id).single(), 'Event');
    if (prior.processed_at) return 'duplicate';
  }
  try {
    const obj = event.data.object;
    let result = 'ignored';
    if (event.type === 'checkout.session.completed' && (obj.metadata || {}).app === APP && (obj.metadata || {}).kind === 'employer_credits') {
      result = (await require('./employers').fulfill(obj.id)).added ? 'employer credits added' : 'employer credits: nothing to add';
    } else if (event.type === 'checkout.session.completed') {
      result = (obj.metadata || {}).app === APP ? ((await syncCheckoutSession(obj.id, event.id)).activated ? 'activated' : 'synced') : 'ignored: other app';
    } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      result = await handleInvoice(obj, event);
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      result = await handleSubscription(obj, event);
    } else if (event.type === 'charge.refunded') {
      result = await handleRefund(obj);
    }
    must(await db().from('csbfp_stripe_events').update({ processed_at: new Date().toISOString(), error: null }).eq('id', event.id), 'Event done');
    return result;
  } catch (err) {
    await db().from('csbfp_stripe_events').update({ error: err.message.slice(0, 500) }).eq('id', event.id);
    throw err;
  }
}

// A refund made in Stripe marks the payment Refunded (or Partly refunded). It never changes the certification:
// any action after a refund is an admin decision.
async function handleRefund(charge) {
  let invoiceId = typeof charge.invoice === 'string' ? charge.invoice : charge.invoice && charge.invoice.id;
  if (!invoiceId && charge.payment_intent) {
    const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent.id;
    const list = await stripe().invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: pi }, limit: 1 });
    const first = list && list.data && list.data[0];
    invoiceId = first && (typeof first.invoice === 'string' ? first.invoice : first.invoice && first.invoice.id);
  }
  if (!invoiceId) return 'ignored: no invoice';
  const payment = must(await db().from('csbfp_payments').select('id, registrant_id').eq('stripe_invoice_id', invoiceId).maybeSingle(), 'Payment');
  if (!payment) return 'ignored: unknown payment';
  const status = charge.refunded || (charge.amount_refunded || 0) >= (charge.amount || 0) ? 'refunded' : 'partially_refunded';
  must(await db().from('csbfp_payments').update({ status }).eq('id', payment.id), 'Refund');
  await logEvent({ registrantId: payment.registrant_id, event: 'payment_refunded', actor: 'stripe', detail: { status } });
  return status;
}

// ---------- registrant actions ----------

async function setAutoRenew(registrantId, on) {
  const live = await liveSubscriptionOf(registrantId);
  if (!live) throw new Error('No active subscription');
  const sub = await stripe().subscriptions.update(live.stripe_subscription_id, { cancel_at_period_end: !on });
  const registration = await registrationOf(registrantId);
  await upsertSubscription(sub, registration);
  return sub;
}

async function portalUrl(registration, returnPath = '/portal/billing') {
  const { portalId } = await stripeConfig();
  const session = await stripe().billingPortal.sessions.create({
    customer: registration.stripe_customer_id, configuration: portalId || undefined, return_url: `${config.siteUrl}${returnPath}`,
  });
  return session.url;
}

// Hosted page for the open (unpaid) renewal invoice.
async function openInvoiceUrl(live) {
  const sub = await stripe().subscriptions.retrieve(live.stripe_subscription_id, { expand: ['latest_invoice'] });
  const inv = sub.latest_invoice;
  return inv && typeof inv === 'object' && inv.status === 'open' ? inv.hosted_invoice_url : null;
}

module.exports = {
  APP, notify, expire, payWithEmployerCredit, syncSubscriptionAndActivate, upsertSubscription, registrationForSubscription, paymentStatus, createCheckout, syncCheckoutSession, handleEvent, setAutoRenew, portalUrl, openInvoiceUrl,
  liveSubscriptionOf, registrationOf, periodOf,
};
