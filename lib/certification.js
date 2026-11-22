/**
 * Certification lifecycle. Every status change goes through csbfp_set_registration_status, which enforces the allowed
 * transitions (see the migration) and writes the history row. Status values are stored with their original names:
 *
 *   value              label               public lookup
 *   pending            In Progress         not found
 *   pending_screening  Pending Screening   not found
 *   under_review       Under Review        not found
 *   not_approved       Not Approved        not found
 *   active             Certified           Certified
 *   inactive           Inactive            Inactive
 *   expired            Expired             Expired
 *   suspended          Suspended           Suspended
 *   revoked            Revoked             Revoked
 *
 * Initial path: Pay -> (screening enabled) Pending Screening -> Under Review -> approved by a reviewer -> Certified.
 * The first annual term starts on final approval, not on payment; the subscription's next renewal is moved to match.
 * While screening is switched off, payment issues a DEMO credential (DEMO- number, is_demo) that the public lookup
 * labels "Demo record: not screened, not a valid certification". No real credential is issued without screening.
 */
const config = require('./config');
const { db, must } = require('./supabase');
const { stripe, blockedReason } = require('./stripe');
const { logEvent } = require('./events');
const { sendQuietly, registrantVars, fmtDate } = require('./email');
const screening = require('./screening');

const LABELS = {
  pending: 'In Progress', pending_screening: 'Pending Screening', under_review: 'Under Review', not_approved: 'Not Approved',
  active: 'Certified', inactive: 'Inactive', expired: 'Expired', suspended: 'Suspended', revoked: 'Revoked',
};
const PUBLIC_STATUSES = ['active', 'inactive', 'expired', 'suspended', 'revoked'];
const APPLICATION_STATUSES = ['pending', 'pending_screening', 'under_review', 'not_approved'];
const YEAR_MS = 365 * 864e5;

async function load(id) {
  return must(await db().from('csbfp_registrations').select('*').eq('id', id).single(), 'Registration');
}

async function setStatus(registration, to, { reason, actorType, actorId = null, sourceRef = null, effectiveAt = null, evidenceRef = null }) {
  const { error } = await db().rpc('csbfp_set_registration_status', {
    p_registration_id: registration.id, p_to_status: to, p_reason: reason, p_actor_type: actorType, p_actor_id: actorId,
    p_source_ref: sourceRef, p_effective_at: effectiveAt, p_evidence_ref: evidenceRef,
  });
  if (error) throw new Error(`Set status: ${error.message}`);
}

async function assignNumber(registration, { demo }) {
  const { data, error } = await db().rpc('csbfp_assign_registration_number', {
    p_registration_id: registration.id, p_prefix: demo ? config.program.demoNumberPrefix : config.program.numberPrefix,
  });
  if (error) throw new Error(`Assign number: ${error.message}`);
  return data;
}

async function notify(registration, templateKey, dedupeKey, vars = {}) {
  const registrant = must(await db().from('csbfp_registrants').select('*').eq('id', registration.registrant_id).single(), 'Registrant');
  if (!registrant.email || registrant.account_status === 'deleted') return;
  const fresh = await load(registration.id);
  await sendQuietly({ dedupeKey, registrantId: registrant.id, templateKey, to: registrant.email,
    vars: { ...registrantVars(registrant), email: registrant.email, number: fresh.registration_number || '', amount: config.program.annualFee,
      valid_through: fmtDate(fresh.expires_at), ...vars } });
}

/**
 * Called by billing when the first payment of a new application is confirmed (status pending).
 * Returns { number, issued, held } — held means the application is waiting on screening/review.
 */
async function afterInitialPayment(registration, { periodStart, periodEnd, sourceRef }) {
  if (!registration.paid_at) must(await db().from('csbfp_registrations').update({ paid_at: new Date().toISOString() }).eq('id', registration.id).is('paid_at', null), 'Paid at');

  if (screening.enabled()) {
    await setStatus(registration, 'pending_screening', { reason: 'Fee paid; awaiting one-time background screening', actorType: 'stripe', sourceRef });
    await screening.begin(registration);
    await logEvent({ registrantId: registration.registrant_id, event: 'screening_pending', actor: 'system' });
    await notify(registration, 'application_received', `application_received:${registration.id}`);
    return { number: null, issued: false, held: true };
  }

  // Screening switched off (preview): issue a clearly labeled DEMO credential, never a genuine one.
  const now = new Date().toISOString();
  must(await db().from('csbfp_registrations').update({
    is_demo: true, approved_at: now, first_activated_at: registration.first_activated_at || now,
    current_period_start: periodStart, expires_at: periodEnd,
  }).eq('id', registration.id), 'Demo issue');
  const number = await assignNumber(registration, { demo: true });
  await setStatus(registration, 'active', { reason: 'DEMO credential issued (background screening not enabled)', actorType: 'stripe', sourceRef });
  await logEvent({ registrantId: registration.registrant_id, event: 'demo_credential_issued', actor: 'system', detail: { number } });
  await notify(registration, 'certification_issued', `issued:${registration.id}`, { number });
  return { number, issued: true, held: false };
}

// Move the subscription's next renewal to one year after approval (no charge for the gap).
async function alignRenewal(registration, termEnd) {
  const billing = require('./billing');
  const live = await billing.liveSubscriptionOf(registration.registrant_id);
  if (!live || blockedReason()) return false;
  if (live.current_period_end && Math.abs(Date.parse(live.current_period_end) - termEnd.getTime()) < 864e5) return false;
  const sub = await stripe().subscriptions.update(live.stripe_subscription_id, {
    trial_end: Math.floor(termEnd.getTime() / 1000), proration_behavior: 'none',
  }, { idempotencyKey: `align:${registration.id}:${Math.floor(termEnd.getTime() / 864e5)}` });
  await billing.upsertSubscription(sub, registration);
  return true;
}

// ---------- reviewer actions (admin only) ----------

async function sendToReview(registration, { adminId, reason }) {
  await setStatus(registration, 'under_review', { reason, actorType: 'admin', actorId: adminId });
}

/** Final eligibility approval: assigns the permanent number and starts the first annual term. */
async function approve(registration, { adminId, reason }) {
  if (!screening.enabled()) throw new Error('Background screening is not enabled; genuine credentials cannot be issued.');
  if (registration.status !== 'under_review') throw new Error('Only applications under review can be approved.');
  const sc = await screening.forRegistration(registration.id);
  if (!sc || sc.status !== 'approved') throw new Error('The background screening has not been approved by a reviewer.');
  const now = new Date();
  const termEnd = new Date(now.getTime() + YEAR_MS);
  must(await db().from('csbfp_registrations').update({
    approved_at: now.toISOString(), approved_by: adminId, first_activated_at: registration.first_activated_at || now.toISOString(),
    current_period_start: now.toISOString(), expires_at: termEnd.toISOString(), is_demo: false,
  }).eq('id', registration.id), 'Approve');
  const number = await assignNumber(registration, { demo: false });
  await setStatus(registration, 'active', { reason: reason || 'Eligibility approved', actorType: 'admin', actorId: adminId });
  try { await alignRenewal(registration, termEnd); } catch (err) { console.error('Renewal date alignment failed:', err.message); }
  await logEvent({ registrantId: registration.registrant_id, event: 'certification_issued', actor: 'admin', detail: { number } });
  await notify(registration, 'certification_issued', `issued:${registration.id}`, { number });
  return number;
}

async function notApprove(registration, { adminId, reason, evidenceRef }) {
  await setStatus(registration, 'not_approved', { reason, actorType: 'admin', actorId: adminId, evidenceRef });
  await logEvent({ registrantId: registration.registrant_id, event: 'application_not_approved', actor: 'admin' });
  await notify(registration, 'application_not_approved', `not_approved:${registration.id}:${Date.now()}`);
}

async function suspend(registration, { adminId, reason, evidenceRef, effectiveAt }) {
  await setStatus(registration, 'suspended', { reason, actorType: 'admin', actorId: adminId, evidenceRef, effectiveAt });
  await logEvent({ registrantId: registration.registrant_id, event: 'certification_suspended', actor: 'admin' });
  await notify(registration, 'certification_suspended', `suspended:${registration.id}:${Date.now()}`);
}

/** Back to Certified if the term is current, otherwise Expired. */
async function reinstate(registration, { adminId, reason, evidenceRef }) {
  const current = registration.expires_at && Date.parse(registration.expires_at) > Date.now();
  await setStatus(registration, current ? 'active' : 'expired', { reason, actorType: 'admin', actorId: adminId, evidenceRef });
  await logEvent({ registrantId: registration.registrant_id, event: 'certification_reinstated', actor: 'admin' });
  if (current) await notify(registration, 'certification_reinstated', `reinstated:${registration.id}:${Date.now()}`);
}

/** Final withdrawal. Automatic renewal is stopped so no further charges happen. The number is never reissued. */
async function revoke(registration, { adminId, reason, evidenceRef, effectiveAt }) {
  await setStatus(registration, 'revoked', { reason, actorType: 'admin', actorId: adminId, evidenceRef, effectiveAt });
  const billing = require('./billing');
  const live = await billing.liveSubscriptionOf(registration.registrant_id);
  if (live && !blockedReason()) {
    try {
      const sub = await stripe().subscriptions.cancel(live.stripe_subscription_id);
      await billing.upsertSubscription(sub, registration);
    } catch (err) { console.error('Cancel subscription on revocation failed:', err.message); }
  }
  await logEvent({ registrantId: registration.registrant_id, event: 'certification_revoked', actor: 'admin' });
  await notify(registration, 'certification_revoked', `revoked:${registration.id}`);
}

module.exports = {
  LABELS, PUBLIC_STATUSES, APPLICATION_STATUSES, load, setStatus, assignNumber, afterInitialPayment, alignRenewal,
  sendToReview, approve, notApprove, suspend, reinstate, revoke, notify,
};
