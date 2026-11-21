/**
 * Where an applicant is in the certification process. Drives the dashboard checklist.
 */
const { db, must } = require('./supabase');

async function progressFor(registrant) {
  const id = registrant.id;
  const [rels, products, acks, registration] = await Promise.all([
    db().from('csbfp_employment_relationships').select('id', { count: 'exact', head: true }).eq('registrant_id', id).eq('is_current', true),
    db().from('csbfp_registrant_products').select('product_id', { count: 'exact', head: true }).eq('registrant_id', id),
    db().from('csbfp_legal_acceptances').select('id', { count: 'exact', head: true }).eq('registrant_id', id).eq('document_key', 'acknowledgments'),
    db().from('csbfp_registrations').select('id, status, registration_number, first_activated_at, expires_at, is_demo, paid_at').eq('registrant_id', id).maybeSingle(),
  ]);
  for (const r of [rels, products, acks, registration]) if (r.error) throw new Error(`Progress: ${r.error.message}`);

  const personal = Boolean(registrant.legal_first_name && registrant.legal_last_name && registrant.dob_hash
    && registrant.zip5 && registrant.industry_start_month && registrant.phone_e164);
  const employment = registrant.employment_status === 'not_currently_employed'
    || (registrant.employment_status === 'working' && (rels.count || 0) > 0);
  const productsDone = (products.count || 0) > 0;
  const acknowledgments = (acks.count || 0) > 0;

  return {
    personal, employment, products: productsDone, acknowledgments,
    profileComplete: personal && employment && productsDone,
    infoComplete: personal && employment && productsDone && acknowledgments,
    registration: registration.data,
  };
}

// Records when the profile first became complete.
async function markProfileComplete(registrant) {
  if (registrant.profile_completed_at) return;
  const p = await progressFor(registrant);
  if (!p.profileComplete) return;
  must(await db().from('csbfp_registrants').update({ profile_completed_at: new Date().toISOString() })
    .eq('id', registrant.id).is('profile_completed_at', null), 'Mark profile complete');
}

module.exports = { progressFor, markProfileComplete };
