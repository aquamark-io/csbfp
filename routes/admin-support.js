/**
 * Admin: support requests, data deletion, identity review, program-update announcements.
 *
 *   GET  /admin/support                         open / in progress / closed
 *   GET  /admin/support/:id                     read, note, change status
 *   POST /admin/support/:id
 *   POST /admin/registrants/:id/delete-data     delete a registrant's data (type DELETE + reason)
 *   POST /admin/registrants/:id/identity-review email asking them to confirm details
 *   GET  /admin/announce                        write an announcement
 *   POST /admin/announce/test                   send it to yourself
 *   POST /admin/announce/send                   send to all (in the background)
 */
const crypto = require('crypto');
const express = require('express');
const { db, must } = require('../lib/supabase');
const { logAdmin } = require('../lib/audit');
const { logEvent } = require('../lib/events');
const { CATEGORIES, referenceOf } = require('../lib/support');
const { deleteRegistrantData } = require('../lib/deletion');
const { sendOnce, sendDirect, registrantVars } = require('../lib/email');
const { requireAdmin } = require('../middleware/admin');

const router = express.Router();
router.use(requireAdmin);

const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '');
const line = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
const go = (res, path, m, isErr) => res.redirect(303, `${path}${path.includes('?') ? '&' : '?'}${isErr ? 'err' : 'msg'}=${encodeURIComponent(m)}`);
const msgOf = req => ({ msg: typeof req.query.msg === 'string' ? req.query.msg.slice(0, 300) : null, err: typeof req.query.err === 'string' ? req.query.err.slice(0, 300) : null });

// ---------- support ----------

router.get('/support', async (req, res, next) => {
  try {
    const status = ['open', 'in_progress', 'closed'].includes(req.query.status) ? req.query.status : 'open';
    const rows = must(await db().from('br_support_requests').select('*').eq('status', status).order('created_at', { ascending: false }).limit(200), 'Support');
    const counts = {};
    for (const s of ['open', 'in_progress']) {
      const { count } = await db().from('br_support_requests').select('id', { count: 'exact', head: true }).eq('status', s);
      counts[s] = count || 0;
    }
    res.render('admin/support', { pageTitle: 'Support', status, counts, CATEGORIES, rows: rows.map(r => ({ ...r, reference: referenceOf(r.id) })) });
  } catch (err) { next(err); }
});

async function loadRequest(id) {
  if (!isUuid(id)) return null;
  return must(await db().from('br_support_requests').select('*').eq('id', id).maybeSingle(), 'Request');
}

router.get('/support/:id', async (req, res, next) => {
  try {
    const sr = await loadRequest(req.params.id);
    if (!sr) return next();
    const registrant = sr.registrant_id ? must(await db().from('br_registrants').select('id, legal_first_name, middle_name, legal_last_name, email, account_status').eq('id', sr.registrant_id).maybeSingle(), 'Registrant') : null;
    res.render('admin/support-request', { pageTitle: referenceOf(sr.id), sr, reference: referenceOf(sr.id), registrant, CATEGORIES, ...msgOf(req) });
  } catch (err) { next(err); }
});

router.post('/support/:id', async (req, res, next) => {
  try {
    const sr = await loadRequest(req.params.id);
    if (!sr) return next();
    const status = ['open', 'in_progress', 'closed'].includes(req.body.status) ? req.body.status : sr.status;
    const note = String(req.body.admin_note || '').trim().slice(0, 5000);
    must(await db().from('br_support_requests').update({ status, admin_note: note || null, closed_at: status === 'closed' ? new Date().toISOString() : null }).eq('id', sr.id), 'Update request');
    await logAdmin({ adminId: req.admin.id, action: 'support_request_updated', targetType: 'support', targetId: sr.id, detail: { status }, ip: req.ip });
    return go(res, `/admin/support/${sr.id}`, 'Saved.');
  } catch (err) { next(err); }
});

// ---------- registrant actions ----------

router.post('/registrants/:id/delete-data', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return next();
    const path = `/admin/registrants/${req.params.id}`;
    const reason = line(req.body.reason, 500);
    if (req.body.confirm !== 'DELETE') return go(res, path, 'Type DELETE (in capitals) to confirm.', true);
    if (!reason) return go(res, path, 'A reason is required.', true);
    const out = await deleteRegistrantData(req.params.id);
    await logAdmin({ adminId: req.admin.id, action: 'registrant_data_deleted', targetType: 'registrant', targetId: req.params.id, reason,
      detail: { retired_number: out.number || null }, ip: req.ip });
    // Close any open deletion requests for this person (their text was deleted with the data).
    return go(res, path, out.already ? 'This account was already deleted.' : 'Personal data deleted. The registration number is retired.');
  } catch (err) {
    return go(res, `/admin/registrants/${req.params.id}`, `Deletion failed: ${err.message}`, true);
  }
});

router.post('/registrants/:id/identity-review', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return next();
    const path = `/admin/registrants/${req.params.id}`;
    const r = must(await db().from('br_registrants').select('*').eq('id', req.params.id).maybeSingle(), 'Registrant');
    if (!r || !r.email) return go(res, path, 'This account has no email address.', true);
    const note = String(req.body.note || '').trim().slice(0, 2000);
    await sendOnce({ dedupeKey: `identity_review:${r.id}:${crypto.randomUUID()}`, registrantId: r.id, templateKey: 'identity_review_required', to: r.email,
      vars: { ...registrantVars(r), note: note || 'Please reply to this email so we can confirm a few details about your account.' } });
    await logAdmin({ adminId: req.admin.id, action: 'identity_review_sent', targetType: 'registrant', targetId: r.id, ip: req.ip });
    await logEvent({ registrantId: r.id, event: 'identity_review_sent', actor: 'admin' });
    return go(res, path, `Identity review email sent to ${r.email}.`);
  } catch (err) { next(err); }
});

// ---------- announcements ----------

const AUDIENCES = {
  active: 'Active registrations only',
  registered: 'Everyone who has ever been registered (active, inactive or expired)',
  all: 'All verified accounts (including those still completing registration)',
};

async function recipients(audience) {
  const people = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const rows = must(await db().from('br_registrants').select('id, email, legal_first_name').eq('account_status', 'active')
      .not('email_verified_at', 'is', null).order('created_at').range(from, from + page - 1), 'Recipients');
    people.push(...rows);
    if (rows.length < page) break;
  }
  if (audience === 'all') return people;
  const regs = [];
  for (let from = 0; ; from += 1000) {
    const rows = must(await db().from('br_registrations').select('registrant_id, status').order('created_at').range(from, from + 999), 'Registrations');
    regs.push(...rows);
    if (rows.length < 1000) break;
  }
  const ok = new Set(regs.filter(g => (audience === 'active' ? g.status === 'active' : g.status !== 'pending')).map(g => g.registrant_id));
  return people.filter(p => ok.has(p.id));
}

router.get('/announce', async (req, res, next) => {
  try {
    const counts = {};
    for (const a of Object.keys(AUDIENCES)) counts[a] = (await recipients(a)).length;
    const recent = must(await db().from('br_admin_audit_log').select('*').eq('action', 'announcement_sent').order('created_at', { ascending: false }).limit(10), 'Recent');
    res.render('admin/announce', { pageTitle: 'Announce', AUDIENCES, counts, recent, values: {}, ...msgOf(req) });
  } catch (err) { next(err); }
});

function readAnnouncement(body) {
  return { subject: line(body.subject, 150), message: String(body.message || '').replace(/\r\n/g, '\n').trim().slice(0, 10000),
    audience: Object.hasOwn(AUDIENCES, body.audience) ? body.audience : null };
}

router.post('/announce/test', async (req, res, next) => {
  try {
    const a = readAnnouncement(req.body);
    if (!a.subject || !a.message) return go(res, '/admin/announce', 'Enter a subject and a message.', true);
    await sendDirect({ to: req.admin.email, templateKey: 'program_update', vars: { first_name: 'there', subject: a.subject, message: a.message } });
    return go(res, '/admin/announce', `Test sent to ${req.admin.email}. Re-enter the message to send it to registrants.`);
  } catch (err) { return go(res, '/admin/announce', `Test failed: ${err.message}`, true); }
});

router.post('/announce/send', async (req, res, next) => {
  try {
    const a = readAnnouncement(req.body);
    if (!a.subject || !a.message || !a.audience) return go(res, '/admin/announce', 'Enter a subject, a message and an audience.', true);
    if (req.body.confirm !== 'yes') return go(res, '/admin/announce', 'Tick the confirmation box to send.', true);
    const list = await recipients(a.audience);
    const id = crypto.randomUUID().slice(0, 8);
    await logAdmin({ adminId: req.admin.id, action: 'announcement_sent', detail: { id, subject: a.subject, audience: a.audience, recipients: list.length }, ip: req.ip });
    // Send in the background, one at a time; each send is deduplicated per announcement and person.
    setImmediate(async () => {
      for (const p of list) {
        await sendOnce({ dedupeKey: `program_update:${id}:${p.id}`, registrantId: p.id, templateKey: 'program_update', to: p.email,
          vars: { first_name: p.legal_first_name || 'there', subject: a.subject, message: a.message } })
          .catch(err => console.error('Announcement send failed:', err.message));
      }
    });
    return go(res, '/admin/announce', `Sending to ${list.length} ${list.length === 1 ? 'person' : 'people'}. Progress shows in the Email log.`);
  } catch (err) { next(err); }
});

module.exports = router;
