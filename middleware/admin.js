// Requires a signed-in admin whose email is still on the ADMIN_EMAILS allowlist and whose account is active.
// Re-checked on every request, so removing someone from the allowlist ends their access at once.
const { db } = require('../lib/supabase');
const config = require('../lib/config');
const adminSession = require('../lib/admin-session');

async function requireAdmin(req, res, next) {
  const s = adminSession.readSession(req);
  if (!s) return res.redirect(303, '/admin/login');
  try {
    const { data: admin, error } = await db().from('csbfp_admin_users').select('*').eq('id', s.sub).maybeSingle();
    if (error) throw new Error(error.message);
    if (!admin || !admin.active || !config.adminEmails.includes(admin.email)) {
      adminSession.clearSession(res);
      return res.redirect(303, '/admin/login');
    }
    req.admin = admin;
    res.locals.admin = admin;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireAdmin };
