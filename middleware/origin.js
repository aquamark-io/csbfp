/**
 * Cross-site request protection for form posts (session cookies are also SameSite=Lax).
 *
 * Modern browsers send Sec-Fetch-Site on every request: "same-origin" (or "none" when the user typed the
 * address) is allowed; "same-site" and "cross-site" are blocked. Older browsers fall back to the Origin header.
 * Webhooks will be mounted before this and are not affected.
 */
module.exports = function sameOrigin(req, res, next) {
  if (req.method !== 'POST') return next();
  const site = req.get('sec-fetch-site');
  let ok;
  if (site) {
    ok = site === 'same-origin' || site === 'none';
  } else {
    const origin = req.get('origin');
    if (!origin) ok = true; // no signal at all (old browser or privacy tool); SameSite cookies still apply
    else {
      try { ok = new URL(origin).host === req.get('host'); } catch { ok = false; }
    }
  }
  if (ok) return next();
  return res.status(403).render('error', { pageTitle: 'Request blocked', message: 'This form must be submitted from the CSBFP website.' });
};
