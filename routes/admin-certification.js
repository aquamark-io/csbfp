/**
 * Admin: certification review, screening workflow, suspension / revocation / reinstatement, appeals.
 *
 *   GET  /admin/background-checks               the 51 Checkr open invitation links (50 states + DC)
 *   POST /admin/background-checks
 *   GET  /admin/review                          queue: pending screening, under review, not approved, suspended, open appeals
 *   POST /admin/registrants/:id/screening       record a screening workflow status (reviewer, note required)
 *   POST /admin/registrants/:id/decision        approve / not approve / send to review / suspend / reinstate / revoke
 *   POST /admin/registrants/:id/appeals         record an appeal, dispute or reconsideration request
 *   POST /admin/appeals/:id                     update an appeal's status and decision note
 *
 * Every action needs a reason and is written to the admin audit log; status changes also go to the status history
 * (with evidence reference and effective date). Policy decisions (criteria, appeal procedures) are the program owner's;
 * these tools only record them. No action here is automatic.
 */
const express = require('express');
const config = require('../lib/config');
const { db, must } = require('../lib/supabase');
const { logAdmin } = require('../lib/audit');
const { requireAdmin } = require('../middleware/admin');
const certification = require('../lib/certification');
const screening = require('../lib/screening');
const { STATES, NAMES } = require('../lib/zip-state');

const router = express.Router();
router.use(['/background-checks', '/review', '/registrants/:id/screening', '/registrants/:id/decision', '/registrants/:id/appeals', '/appeals'], requireAdmin);

const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '');
const clean = (x, max = 500) => (typeof x === 'string' ? x.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const back = (res, id, msg, isErr) => res.redirect(303, `/admin/registrants/${id}?${isErr ? 'err' : 'msg'}=${encodeURIComponent(msg)}#certification`);

async function load(req) {
  if (!isUuid(req.params.id)) return null;
  const r = must(await db().from('csbfp_registrants').select('*').eq('id', req.params.id).maybeSingle(), 'Registrant');
  if (!r) return null;
  const reg = must(await db().from('csbfp_registrations').select('*').eq('registrant_id', r.id).single(), 'Registration');
  return { r, reg };
}

// ---------- Checkr open invitation links ----------

router.get('/background-checks', async (req, res, next) => {
  try {
    const links = await screening.invitationLinks();
    res.render('admin/background-checks', { pageTitle: 'Background Checks', states: STATES, names: NAMES, links,
      set: STATES.filter(s => links[s]).length, screeningConfig: config.screening,
      msg: typeof req.query.msg === 'string' ? req.query.msg.slice(0, 200) : null,
      err: typeof req.query.err === 'string' ? req.query.err.slice(0, 300) : null });
  } catch (err) { next(err); }
});

router.post('/background-checks', async (req, res, next) => {
  try {
    const before = await screening.invitationLinks();
    const links = {};
    const bad = [];
    for (const st of STATES) {
      const v = typeof req.body[`link_${st}`] === 'string' ? req.body[`link_${st}`].trim() : '';
      if (!v) continue;
      let ok = false;
      try { ok = new URL(v).protocol === 'https:' && v.length <= 500; } catch { ok = false; }
      if (ok) links[st] = v; else bad.push(NAMES[st]);
    }
    if (bad.length) return res.redirect(303, `/admin/background-checks?err=${encodeURIComponent(`Not saved. These need a full https:// link: ${bad.join(', ')}.`)}`);
    await screening.saveInvitationLinks(links, req.admin.id);
    const changed = STATES.filter(st => (before[st] || '') !== (links[st] || ''));
    await logAdmin({ adminId: req.admin.id, action: 'checkr_links_updated', detail: { changed, total: Object.keys(links).length }, ip: req.ip });
    return res.redirect(303, `/admin/background-checks?msg=${encodeURIComponent(`Saved. ${Object.keys(links).length} of ${STATES.length} links set${changed.length ? `; changed: ${changed.join(', ')}` : ''}.`)}`);
  } catch (err) { next(err); }
});

// ---------- queue ----------

router.get('/review', async (req, res, next) => {
  try {
    const regs = must(await db().from('csbfp_registrations').select('*')
      .in('status', ['pending_screening', 'under_review', 'not_approved', 'suspended']).order('updated_at', { ascending: true }), 'Queue');
    const appeals = must(await db().from('csbfp_appeals').select('*').in('status', ['open', 'under_review']).order('created_at', { ascending: true }), 'Appeals');
    const ids = [...new Set([...regs.map(x => x.registrant_id), ...appeals.map(a => a.registrant_id)])];
    const people = ids.length ? must(await db().from('csbfp_registrants').select('id, legal_first_name, middle_name, legal_last_name, email').in('id', ids), 'People') : [];
    const regIds = regs.map(x => x.id);
    const screenings = regIds.length ? must(await db().from('csbfp_screenings').select('*').in('registration_id', regIds), 'Screenings') : [];
    const by = new Map(people.map(p => [p.id, p]));
    const sBy = new Map(screenings.map(s => [s.registration_id, s]));
    res.render('admin/review', {
      pageTitle: 'Review', screeningConfig: { ...config.screening, integrated: Boolean(screening.PROVIDERS[config.screening.provider] && screening.PROVIDERS[config.screening.provider].integrated) },
      rows: regs.map(x => ({ ...x, person: by.get(x.registrant_id), screening: sBy.get(x.id) || null })),
      appeals: appeals.map(a => ({ ...a, person: by.get(a.registrant_id) })),
    });
  } catch (err) { next(err); }
});

// ---------- screening workflow (manual until a provider is integrated) ----------

router.post('/registrants/:id/screening', async (req, res, next) => {
  try {
    const found = await load(req);
    if (!found) return next();
    const { r, reg } = found;
    const to = clean(req.body.status, 40);
    const note = clean(req.body.reason);
    if (!screening.STATUSES.includes(to)) return back(res, r.id, 'Choose a screening status.', true);
    if (!note) return back(res, r.id, 'A note is required.', true);
    const sc = await screening.forRegistration(reg.id);
    if (!sc) return back(res, r.id, 'There is no screening record for this application.', true);
    await screening.setStatus(sc, to, { note, actorType: 'admin', actorId: req.admin.id });
    // A reviewer-approved screening moves the application on to the eligibility review. Nothing is decided automatically.
    if (to === 'approved' && reg.status === 'pending_screening') {
      await certification.sendToReview(reg, { adminId: req.admin.id, reason: 'Background screening approved by reviewer' });
    }
    await logAdmin({ adminId: req.admin.id, action: 'screening_status', targetType: 'registrant', targetId: r.id, reason: note, detail: { to }, ip: req.ip });
    return back(res, r.id, `Screening status set to ${screening.LABELS[to]}.`);
  } catch (err) { next(err); }
});

// ---------- certification decisions ----------

const ACTIONS = {
  approve: { label: 'Certification issued', run: (reg, o) => certification.approve(reg, o) },
  not_approve: { label: 'Marked not approved', run: (reg, o) => certification.notApprove(reg, o) },
  send_to_review: { label: 'Sent to review', run: (reg, o) => certification.sendToReview(reg, o) },
  suspend: { label: 'Certification suspended', evidence: true, run: (reg, o) => certification.suspend(reg, o) },
  reinstate: { label: 'Certification reinstated', run: (reg, o) => certification.reinstate(reg, o) },
  revoke: { label: 'Certification revoked', evidence: true, confirm: 'REVOKE', run: (reg, o) => certification.revoke(reg, o) },
};

router.post('/registrants/:id/decision', async (req, res, next) => {
  try {
    const found = await load(req);
    if (!found) return next();
    const { r, reg } = found;
    const action = ACTIONS[req.body.action];
    if (!action) return back(res, r.id, 'Choose an action.', true);
    const reason = clean(req.body.reason);
    const evidenceRef = clean(req.body.evidence_ref, 200) || null;
    if (!reason) return back(res, r.id, 'A reason is required.', true);
    if (action.evidence && !evidenceRef) return back(res, r.id, 'An evidence or case reference is required.', true);
    if (action.confirm && clean(req.body.confirm, 20) !== action.confirm) return back(res, r.id, `Type ${action.confirm} to confirm.`, true);
    let effectiveAt = null;
    if (req.body.effective_date) {
      const t = Date.parse(`${clean(req.body.effective_date, 10)}T00:00:00Z`);
      if (Number.isNaN(t)) return back(res, r.id, 'Effective date is not valid.', true);
      effectiveAt = new Date(t).toISOString();
    }
    try {
      await action.run(reg, { adminId: req.admin.id, reason, evidenceRef, effectiveAt });
    } catch (err) {
      return back(res, r.id, err.message.replace(/^Set status: /, ''), true);
    }
    await logAdmin({ adminId: req.admin.id, action: `certification_${req.body.action}`, targetType: 'registrant', targetId: r.id, reason,
      detail: { from: reg.status, evidence_ref: evidenceRef, effective_at: effectiveAt }, ip: req.ip });
    return back(res, r.id, `${action.label}.`);
  } catch (err) { next(err); }
});

// ---------- appeals, disputes, reconsideration ----------

router.post('/registrants/:id/appeals', async (req, res, next) => {
  try {
    const found = await load(req);
    if (!found) return next();
    const { r, reg } = found;
    const kind = ['appeal', 'dispute', 'reconsideration'].includes(req.body.kind) ? req.body.kind : null;
    const subject = ['not_approved', 'suspension', 'revocation', 'screening', 'other'].includes(req.body.subject) ? req.body.subject : null;
    const statement = clean(req.body.statement, 4000);
    if (!kind || !subject || !statement) return back(res, r.id, 'Type, subject and the statement received are required.', true);
    const row = must(await db().from('csbfp_appeals').insert({ registrant_id: r.id, registration_id: reg.id, kind, subject, statement, opened_by: req.admin.id })
      .select('id').single(), 'Appeal');
    if (subject === 'screening') {
      const sc = await screening.forRegistration(reg.id);
      if (sc) await screening.setStatus(sc, 'disputed', { note: 'Dispute recorded', actorType: 'admin', actorId: req.admin.id });
    }
    await logAdmin({ adminId: req.admin.id, action: 'appeal_opened', targetType: 'registrant', targetId: r.id, reason: `${kind}: ${subject}`, detail: { appeal: row.id }, ip: req.ip });
    return back(res, r.id, 'Recorded.');
  } catch (err) { next(err); }
});

router.post('/appeals/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return next();
    const a = must(await db().from('csbfp_appeals').select('*').eq('id', req.params.id).maybeSingle(), 'Appeal');
    if (!a) return next();
    const status = ['open', 'under_review', 'upheld', 'reversed', 'withdrawn'].includes(req.body.status) ? req.body.status : null;
    const note = clean(req.body.decision_note, 2000);
    if (!status || !note) return back(res, a.registrant_id, 'Status and a note are required.', true);
    const final = ['upheld', 'reversed', 'withdrawn'].includes(status);
    must(await db().from('csbfp_appeals').update({ status, decision_note: note, ...(final ? { decided_by: req.admin.id, decided_at: new Date().toISOString() } : {}) })
      .eq('id', a.id), 'Update appeal');
    await logAdmin({ adminId: req.admin.id, action: 'appeal_updated', targetType: 'registrant', targetId: a.registrant_id, reason: note, detail: { appeal: a.id, status }, ip: req.ip });
    return back(res, a.registrant_id, final && status === 'reversed'
      ? 'Appeal marked reversed. Use the certification actions to apply the outcome.' : 'Appeal updated.');
  } catch (err) { next(err); }
});

module.exports = router;
