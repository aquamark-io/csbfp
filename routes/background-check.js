/**
 * Applicant background check (phase 1: Checkr open invitation links, one per state).
 *
 *   GET /portal/background-check       state from the home ZIP code, the name and email to use, and the Checkr button
 *   GET /portal/background-check/go    records the first click, then sends the applicant to their state's Checkr link
 *   POST /portal/background-check/done the applicant says they finished the Checkr form (phase 1: no Checkr callback)
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

// Phase 1 has no link back from Checkr, so the applicant tells us when they've finished. This only moves the
// workflow to in_progress (submitted); a reviewer still records the result.
const SUBMITTABLE = ['not_started', 'awaiting_authorization'];
router.post('/background-check/done', async (req, res, next) => {
  try {
    const c = await context(req.registrant);
    if (!c.ready || !c.sc) return res.redirect(303, '/portal/dashboard');
    if (SUBMITTABLE.includes(c.sc.status)) {
      let sc = c.sc;
      if (!sc.link_opened_at && c.state) sc = await screening.recordLinkOpened(sc, c.state);
      await screening.setStatus(sc, 'in_progress', { note: 'Applicant marked the Checkr form complete' });
      await logEvent({ registrantId: req.registrant.id, event: 'background_check_marked_complete', actor: 'registrant', ip: req.ip });
    }
    return res.redirect(303, '/portal/dashboard');
  } catch (err) { next(err); }
});

module.exports = router;
