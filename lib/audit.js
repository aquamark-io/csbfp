// Admin audit log (insert-only). `detail` holds field names changed, never date-of-birth values.
const { db } = require('./supabase');

async function logAdmin({ adminId, action, targetType = null, targetId = null, reason = null, detail = {}, ip = null }) {
  const { error } = await db().from('br_admin_audit_log')
    .insert({ admin_id: adminId, action, target_type: targetType, target_id: targetId ? String(targetId) : null, reason, detail, ip });
  if (error) throw new Error(`Audit log: ${error.message}`); // an admin action must not go unrecorded
}

module.exports = { logAdmin };
