// Requires a signed-in registrant. Re-checks the database on every request, so locking or deleting
// an account ends its access immediately.
const { db } = require('../lib/supabase');
const { readSession, clearSession } = require('../lib/session');
const config = require('../lib/config');

async function requireRegistrant(req, res, next) {
  const session = readSession(req);
  if (!session) return res.redirect(303, '/portal');
  try {
    const { data: r, error } = await db().from('br_registrants').select('*').eq('id', session.sub).maybeSingle();
    if (error) throw new Error(error.message);
    if (!r || !['active', 'deletion_requested'].includes(r.account_status) || !r.email_verified_at || !config.previewAllowed(r.email)) {
      clearSession(res);
      return res.redirect(303, '/portal');
    }
    req.registrant = r;
    res.locals.registrant = r;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireRegistrant };
