/**
 * Admin: employers and certification credits.
 *
 *   GET  /admin/employers               every employer: ID, contact, purchased / used / remaining
 *   GET  /admin/employers/:id           purchases, who used credits, adjustments
 *   POST /admin/employers/:id/adjust    add or remove credits (reason required)
 *   POST /admin/employers/:id/reissue   retire a misused ID; balance moves to a new ID (emailed to the contact)
 */
const express = require('express');
const { db, must } = require('../lib/supabase');
const { logAdmin } = require('../lib/audit');
const { requireAdmin } = require('../middleware/admin');
const employers = require('../lib/employers');

const router = express.Router();
router.use('/employers', requireAdmin);

const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '');
const clean = (x, max = 500) => (typeof x === 'string' ? x.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const back = (res, id, msg, isErr) => res.redirect(303, `/admin/employers/${id}?${isErr ? 'err' : 'msg'}=${encodeURIComponent(msg)}`);

router.get('/employers', async (req, res, next) => {
  try {
    const rows = must(await db().from('csbfp_employers').select('*').order('created_at', { ascending: false }), 'Employers');
    res.render('admin/employers', { pageTitle: 'Employers', rows: rows.map(e => ({ ...e, balance: employers.balanceOf(e) })) });
  } catch (err) { next(err); }
});

async function load(id) {
  if (!isUuid(id)) return null;
  return must(await db().from('csbfp_employers').select('*').eq('id', id).maybeSingle(), 'Employer');
}

router.get('/employers/:id', async (req, res, next) => {
  try {
    const e = await load(req.params.id);
    if (!e) return next();
    const [purchases, uses] = await Promise.all([
      db().from('csbfp_employer_purchases').select('*').eq('employer_id', e.id).order('created_at', { ascending: false }),
      db().from('csbfp_employer_credit_uses').select('*').eq('employer_id', e.id).order('created_at', { ascending: false }),
    ]);
    const useRows = must(uses, 'Uses');
    const regIds = useRows.filter(u => u.registration_id).map(u => u.registration_id);
    const regs = regIds.length ? must(await db().from('csbfp_registrations').select('id, registrant_id, status, registration_number, is_demo').in('id', regIds), 'Registrations') : [];
    const people = regs.length ? must(await db().from('csbfp_registrants').select('id, legal_first_name, middle_name, legal_last_name, email').in('id', regs.map(r => r.registrant_id)), 'People') : [];
    const regBy = new Map(regs.map(r => [r.id, r]));
    const personBy = new Map(people.map(p => [p.id, p]));
    const replacement = e.replaced_by ? await load(e.replaced_by) : null;
    res.render('admin/employer', {
      pageTitle: e.company_name, e, balance: employers.balanceOf(e), replacement, purchases: must(purchases, 'Purchases'),
      uses: useRows.map(u => { const reg = regBy.get(u.registration_id); return { ...u, reg, person: reg ? personBy.get(reg.registrant_id) : null }; }),
      msg: typeof req.query.msg === 'string' ? req.query.msg.slice(0, 200) : null,
      err: typeof req.query.err === 'string' ? req.query.err.slice(0, 200) : null,
    });
  } catch (err) { next(err); }
});

router.post('/employers/:id/adjust', async (req, res, next) => {
  try {
    const e = await load(req.params.id);
    if (!e) return next();
    const amount = /^-?\d+$/.test(clean(req.body.amount, 6)) ? Number(req.body.amount) : 0;
    const reason = clean(req.body.reason);
    if (!amount) return back(res, e.id, 'Enter a whole number of credits to add (or negative to remove).', true);
    if (!reason) return back(res, e.id, 'A reason is required.', true);
    if (employers.balanceOf(e) + amount < 0) return back(res, e.id, 'That would leave a negative balance.', true);
    await employers.adjust(e, amount, reason, req.admin.id);
    await logAdmin({ adminId: req.admin.id, action: 'employer_credits_adjusted', targetType: 'employer', targetId: e.id, reason, detail: { amount }, ip: req.ip });
    return back(res, e.id, `${amount > 0 ? 'Added' : 'Removed'} ${Math.abs(amount)} credit${Math.abs(amount) === 1 ? '' : 's'}.`);
  } catch (err) { next(err); }
});

router.post('/employers/:id/reissue', async (req, res, next) => {
  try {
    const e = await load(req.params.id);
    if (!e) return next();
    if (!e.active) return back(res, e.id, 'This ID was already replaced.', true);
    const reason = clean(req.body.reason);
    if (!reason) return back(res, e.id, 'A reason is required.', true);
    const fresh = await employers.reissue(e);
    await logAdmin({ adminId: req.admin.id, action: 'employer_id_reissued', targetType: 'employer', targetId: e.id, reason,
      detail: { old: e.employer_number, new: fresh.employer_number }, ip: req.ip });
    return back(res, fresh.id, `New Employer ID ${fresh.employer_number} issued and emailed to ${fresh.email}. ${e.employer_number} no longer works.`);
  } catch (err) { next(err); }
});

module.exports = router;
