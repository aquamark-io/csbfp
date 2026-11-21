/**
 * Deleting a registrant's data (decision D20 / D20a). Run by an admin after a deletion request.
 *
 * Deleted: name, date of birth, ZIP, email, phone, industry start, employment, products, states, training progress,
 * assessment attempts, sign-in codes, email log, activity log, duplicate flags, support requests.
 * Kept, without a name: the registration row (number retired, so it is never reissued and verification shows
 * "not found"), status history, Stripe ids, payment records and the legal acceptance records (version + time).
 * Any live Stripe subscription is canceled immediately so no further charges happen.
 */
const { db, must } = require('./supabase');
const { stripe, blockedReason } = require('./stripe');
const { sendOnce, registrantVars } = require('./email');

const LINKED = ['csbfp_employment_relationships', 'csbfp_registrant_products', 'csbfp_registrant_states', 'csbfp_training_progress',
  'csbfp_assessment_attempts', 'csbfp_assessment_resets', 'csbfp_login_codes', 'csbfp_email_messages', 'csbfp_events', 'csbfp_support_requests'];

async function deleteRegistrantData(registrantId) {
  const r = must(await db().from('csbfp_registrants').select('*').eq('id', registrantId).single(), 'Registrant');
  if (r.account_status === 'deleted') return { already: true };
  const reg = must(await db().from('csbfp_registrations').select('*').eq('registrant_id', registrantId).maybeSingle(), 'Registration');

  // 1. Stop billing.
  const subs = must(await db().from('csbfp_subscriptions').select('*').eq('registrant_id', registrantId), 'Subscriptions');
  for (const s of subs.filter(x => ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(x.stripe_status))) {
    if (blockedReason()) throw new Error(`Can't cancel the Stripe subscription: ${blockedReason()}`);
    await stripe().subscriptions.cancel(s.stripe_subscription_id);
    must(await db().from('csbfp_subscriptions').update({ stripe_status: 'canceled', canceled_at: new Date().toISOString() }).eq('id', s.id), 'Cancel subscription');
  }

  // 2. Tell them, while we still have the address (the email log row is deleted below).
  if (r.email) {
    await sendOnce({ dedupeKey: `data_deleted:${r.id}`, registrantId: r.id, templateKey: 'data_deleted', to: r.email, vars: registrantVars(r) })
      .catch(err => console.error('Deletion email failed:', err.message));
  }

  // 3. Delete linked personal records.
  for (const table of LINKED) must(await db().from(table).delete().eq('registrant_id', registrantId), `Delete ${table}`);
  must(await db().from('csbfp_duplicate_flags').delete().eq('registrant_id', registrantId), 'Delete flags');
  must(await db().from('csbfp_duplicate_flags').delete().eq('matched_registrant_id', registrantId), 'Delete flags');

  // 4. Retire the number and scrub the registrant row.
  if (reg) must(await db().from('csbfp_registrations').update({ retired_at: new Date().toISOString(), admin_hold: false, admin_hold_reason: null }).eq('id', reg.id), 'Retire number');
  const now = new Date().toISOString();
  must(await db().from('csbfp_registrants').update({
    email: null, email_verified_at: null, phone_e164: null, legal_first_name: null, middle_name: null, legal_last_name: null,
    dob_enc: null, dob_hash: null, zip5: null, industry_start_month: null, employment_status: null, products_other: null,
    pending_name_change: null, profile_completed_at: null, info_confirmed_at: null, last_login_at: null,
    account_status: 'deleted', deleted_at: now,
  }).eq('id', registrantId), 'Scrub registrant');
  return { deleted: true, number: reg && reg.registration_number };
}

module.exports = { deleteRegistrantData };
