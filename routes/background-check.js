/**
 * Applicant background check (phase 1: Checkr open invitation links, one per state).
 *
 *   GET /portal/background-check       state from the home ZIP code, the name and email to use, and the Checkr button
 *   GET /portal/background-check/go    records the first click, then sends the applicant to their state's Checkr link
 *
 * Only for paid applicants waiting on the check (status pending_screening). The links are never shown anywhere
 * public. The redirect is a plain link (GET), so the site's form-action policy doesn't block the jump to Checkr.
 */
const express = require('express');
const { db, must } = require('../lib/supabase');
const { requireRegistrant } = require('../middleware/auth');
const { logEvent } = require('../lib/events');
const screening = require('../lib/screening');
const { stateForZip, NAMES } = require('../lib/zip-state');

const router = express.Router();
router.use('/background-check', requireRegistrant);

async function context(registrant) {
  const reg = must(await db().from('csbfp_registrations').select('*').eq('registrant_id', registrant.id).maybeSingle(), 'Registration');
  if (!reg || reg.status !== 'pending_screening') return { reg, ready: false };
  const sc = await screening.forRegistration(reg.id);
  const state = stateForZip(registrant.zip5);
  const links = await screening.invitationLinks();
  const link = state && typeof links[state] === 'string' && /^https:\/\//.test(links[state]) ? links[state] : null;
  return { reg, sc, state, stateName: state ? NAMES[state] : null, link, ready: true };
}

router.get('/background-check', async (req, res, next) => {
  try {
    const c = await context(req.registrant);
    if (!c.ready) return res.redirect('/portal/dashboard');
    res.render('portal/background-check', { pageTitle: 'Background Check', ...c, r: req.registrant });
  } catch (err) { next(err); }
});

router.get('/background-check/go', async (req, res, next) => {
  try {
    const c = await context(req.registrant);
    if (!c.ready || !c.link || !c.sc) return res.redirect('/portal/background-check');
    if (!c.sc.link_opened_at) {
      await screening.recordLinkOpened(c.sc, c.state);
      await logEvent({ registrantId: req.registrant.id, event: 'background_check_link_opened', actor: 'registrant', detail: { state: c.state }, ip: req.ip });
    }
    return res.redirect(303, c.link);
  } catch (err) { next(err); }
});

module.exports = router;
