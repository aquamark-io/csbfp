/**
 * Registrant session (br_session) and the short-lived "which email is signing in" cookie (br_login).
 * Both are signed JWTs in httpOnly cookies; the email is never put in a URL.
 */
const jwt = require('jsonwebtoken');
const config = require('./config');

const SESSION_COOKIE = 'br_session';
const SESSION_HOURS = 12;
const LOGIN_COOKIE = 'br_login';
const LOGIN_MINUTES = 15;

const opts = (path, maxAge) => ({ httpOnly: true, secure: config.production, sameSite: 'lax', path, maxAge });

function setSession(res, registrant) {
  const token = jwt.sign({ sub: registrant.id }, process.env.JWT_SECRET, { expiresIn: `${SESSION_HOURS}h`, audience: 'br-session' });
  res.cookie(SESSION_COOKIE, token, opts('/', SESSION_HOURS * 3600 * 1000));
}

function readSession(req) {
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  if (!token || !process.env.JWT_SECRET) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET, { audience: 'br-session' }); } catch { return null; }
}

const clearSession = res => res.clearCookie(SESSION_COOKIE, { path: '/' });

function setLoginEmail(res, email) {
  const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: `${LOGIN_MINUTES}m`, audience: 'br-login' });
  res.cookie(LOGIN_COOKIE, token, opts('/portal', LOGIN_MINUTES * 60 * 1000));
}

function readLoginEmail(req) {
  const token = req.cookies && req.cookies[LOGIN_COOKIE];
  if (!token) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET, { audience: 'br-login' }).email; } catch { return null; }
}

const clearLoginEmail = res => res.clearCookie(LOGIN_COOKIE, { path: '/portal' });

module.exports = { setSession, readSession, clearSession, setLoginEmail, readLoginEmail, clearLoginEmail };
