// Registrant activity log. `detail` must never contain a date of birth.
const { db } = require('./supabase');

async function logEvent({ registrantId = null, event, actor, detail = {}, ip = null }) {
  const { error } = await db().from('csbfp_events').insert({ registrant_id: registrantId, event, actor, detail, ip });
  if (error) console.error(`csbfp_events insert failed (${event}):`, error.message);
}

module.exports = { logEvent };
