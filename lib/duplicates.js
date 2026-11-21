/**
 * Possible-duplicate detection. Name, DOB, ZIP and phone point to a likely match but don't prove identity,
 * so a match only raises a flag for an admin to review. An open flag blocks payment (not sign-in).
 */
const { db, must } = require('./supabase');
const { logEvent } = require('./events');

const same = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

async function checkDuplicates(registrant) {
  const flags = [];
  if (registrant.dob_hash) {
    const others = must(await db().from('csbfp_registrants')
      .select('id, legal_first_name, legal_last_name, zip5')
      .eq('dob_hash', registrant.dob_hash).neq('id', registrant.id).neq('account_status', 'deleted'), 'Duplicate check');
    for (const o of others) {
      if (same(o.legal_last_name, registrant.legal_last_name) && o.zip5 === registrant.zip5) flags.push({ other: o.id, reason: 'dob_last_name_zip' });
      else if (same(o.legal_first_name, registrant.legal_first_name) && same(o.legal_last_name, registrant.legal_last_name)) flags.push({ other: o.id, reason: 'dob_full_name' });
    }
  }
  if (registrant.phone_e164) {
    const others = must(await db().from('csbfp_registrants').select('id')
      .eq('phone_e164', registrant.phone_e164).neq('id', registrant.id).neq('account_status', 'deleted'), 'Duplicate phone check');
    for (const o of others) flags.push({ other: o.id, reason: 'phone' });
  }

  for (const f of flags) {
    const { error } = await db().from('csbfp_duplicate_flags')
      .insert({ registrant_id: registrant.id, matched_registrant_id: f.other, match_reason: f.reason });
    if (error && error.code !== '23505') throw new Error(`Duplicate flag: ${error.message}`);
    if (!error) await logEvent({ registrantId: registrant.id, event: 'duplicate_flagged', actor: 'system', detail: { reason: f.reason } });
  }
  return flags.length;
}

async function hasOpenFlag(registrantId) {
  const { count, error } = await db().from('csbfp_duplicate_flags')
    .select('id', { count: 'exact', head: true }).eq('registrant_id', registrantId).eq('status', 'open');
  if (error) throw new Error(`Open flag check: ${error.message}`);
  return (count || 0) > 0;
}

module.exports = { checkDuplicates, hasOpenFlag };
