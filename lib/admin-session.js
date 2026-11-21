/**
 * Admin session for /admin. Separate cookie from registrant sessions (br_admin, path /admin,
 * SameSite=Strict), and the token's audience is "br-admin", so a registrant session can never pass as admin.
 */
const jwt = require('jsonwebtoken');
const config = require('./config');

const COOKIE = 'br_admin';
const LOGIN_COOKIE = 'br_admin_login';
const HOURS = 12;

const opts = maxAge => ({ httpOnly: true, secure: config.production, sameSite: 'strict', path: '/admin', maxAge });

function setSession(res, admin) {
  const token = jwt.sign({ sub: admin.id }, process.env.JWT_SECRET, { expiresIn: `${HOURS}h`, audience: 'br-admin' });
  res.cookie(COOKIE, token, opts(HOURS * 3600 * 1000));
}

function readSession(req) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET, { audience: 'br-admin' }); } catch { return null; }
}

const clearSession = res => res.clearCookie(COOKIE, { path: '/admin' });

function setLoginEmail(res, email) {
  const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: '15m', audience: 'br-admin-login' });
  res.cookie(LOGIN_COOKIE, token, opts(15 * 60 * 1000));
}

function readLoginEmail(req) {
  const token = req.cookies && req.cookies[LOGIN_COOKIE];
  if (!token) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET, { audience: 'br-admin-login' }).email; } catch { return null; }
}

const clearLoginEmail = res => res.clearCookie(LOGIN_COOKIE, { path: '/admin' });

module.exports = { setSession, readSession, clearSession, setLoginEmail, readLoginEmail, clearLoginEmail };
