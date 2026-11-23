/**
 * Administrator area at /admin.
 *
 * Sign-in: emailed 6-digit code, only for addresses in ADMIN_EMAILS (same code rules as registrants).
 *
 *   GET/POST /admin/login, /admin/login/verify       POST /admin/logout
 *   GET      /admin/registrants?q=                    search by name, email or registration number
 *   GET      /admin/registrants/:id                   everything about one registrant
 *   POST     /admin/registrants/:id/edit              correct personal information (reason required)
 *   POST     /admin/registrants/:id/reveal-dob        show the date of birth (logged)
 *   POST     /admin/registrants/:id/hold              place / release an administrative hold (reason required)
 *   POST     /admin/registrants/:id/lock              lock / unlock sign-in (reason required)
 *   GET      /admin/duplicates                        open possible-duplicate flags
 *   POST     /admin/duplicates/:id                    resolve a flag
 *   GET      /admin/lists                             job titles and financing products
 *   POST     /admin/lists/:kind, /admin/lists/:kind/:id
 *   GET      /admin/audit                             audit log
 *
 * Every change is written to csbfp_admin_audit_log with the admin, a reason and the field names changed.
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../lib/config');
const { db, must } = require('../lib/supabase');
const { codeHash, encrypt, decrypt, blindIndex } = require('../lib/crypto');
const { sendOnce } = require('../lib/email');
const { logAdmin } = require('../lib/audit');
const { logEvent } = require('../lib/events');
const { checkDuplicates } = require('../lib/duplicates');
const adminSession = require('../lib/admin-session');
const { requireAdmin } = require('../middleware/admin');
const v = require('../lib/validate');
const training = require('../lib/training');
const screening = require('../lib/screening');

const router = express.Router();

router.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.locals.adminArea = true;
  next();
});

const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '');
const reasonOf = body => (typeof body.reason === 'string' ? body.reason.trim().replace(/\s+/g, ' ').slice(0, 500) : '');
const back = (res, id, msg) => res.redirect(303, `/admin/registrants/${id}?msg=${encodeURIComponent(msg)}`);
const backErr = (res, id, msg) => res.redirect(303, `/admin/registrants/${id}?err=${encodeURIComponent(msg)}`);

// ======================================================================
// Sign-in
// ======================================================================

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const GENERIC = 'That code is incorrect or has expired. Check the code, or request a new one.';
const limited = (view, message) => (req, res) => res.status(429).render(view, { pageTitle: 'Admin Sign In', error: message, email: '' });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: limited('admin/login', 'Too many sign-in requests. Please wait 15 minutes and try again.') });
const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: limited('admin/verify', 'Too many attempts. Please wait 15 minutes and try again.') });

async function adminByEmail(email) {
  return must(await db().from('csbfp_admin_users').select('*').eq('email', email).maybeSingle(), 'Admin lookup');
}

// Runs after the response; nothing is sent for addresses that aren't on the allowlist.
async function issueAdminCode(email, ip) {
  try {
    if (!config.adminEmails.includes(email)) return;
    let admin = await adminByEmail(email);
    if (!admin) {
      admin = must(await db().from('csbfp_admin_users').insert({ email }).select('*').single(), 'Create admin user');
    }
    if (!admin.active) return;

    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { count } = await db().from('csbfp_admin_login_codes').select('id', { count: 'exact', head: true })
      .eq('admin_id', admin.id).gte('created_at', since);
    if ((count || 0) >= 3) return;

    must(await db().from('csbfp_admin_login_codes').update({ used_at: new Date().toISOString() })
      .eq('admin_id', admin.id).is('used_at', null), 'Cancel old admin codes');
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const row = must(await db().from('csbfp_admin_login_codes').insert({
      admin_id: admin.id, code_hash: codeHash(`admin:${admin.id}`, code),
      expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(), ip,
    }).select('id').single(), 'Admin code insert');
    await sendOnce({ dedupeKey: `admin_code:${row.id}`, templateKey: 'admin_sign_in_code', to: admin.email, vars: { code } });
  } catch (err) {
    console.error('Issuing admin code failed:', err.message);
  }
}

router.get('/login', (req, res) => {
  if (adminSession.readSession(req)) return res.redirect('/admin/registrants');
  res.render('admin/login', { pageTitle: 'Admin Sign In', error: null, email: '' });
});

router.post('/login', loginLimiter, (req, res) => {
  const email = v.normEmail(req.body.email);
  if (!v.validEmail(email)) return res.status(422).render('admin/login', { pageTitle: 'Admin Sign In', error: 'Please enter a valid email address.', email });
  adminSession.setLoginEmail(res, email);
  res.redirect(303, '/admin/login/verify');
  setImmediate(() => issueAdminCode(email, req.ip));
});

router.get('/login/verify', (req, res) => {
  const email = adminSession.readLoginEmail(req);
  if (!email) return res.redirect('/admin/login');
  res.render('admin/verify', { pageTitle: 'Admin Sign In', error: null, email });
});

router.post('/login/verify', verifyLimiter, async (req, res, next) => {
  const email = adminSession.readLoginEmail(req);
  if (!email) return res.redirect(303, '/admin/login');
  const code = typeof req.body.code === 'string' ? req.body.code.replace(/\D/g, '') : '';
  const fail = (message, status = 401) => res.status(status).render('admin/verify', { pageTitle: 'Admin Sign In', error: message, email });
  try {
    if (code.length !== 6) return fail('Please enter the 6-digit code from your email.', 422);
    if (!config.adminEmails.includes(email)) return fail(GENERIC);
    const admin = await adminByEmail(email);
    if (!admin || !admin.active) return fail(GENERIC);

    const row = must(await db().from('csbfp_admin_login_codes').select('id, code_hash, attempts')
      .eq('admin_id', admin.id).is('used_at', null).gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false }).limit(1).maybeSingle(), 'Admin code lookup');
    if (!row) return fail(GENERIC);
    if (row.attempts >= MAX_ATTEMPTS) return fail('Too many incorrect attempts. Please request a new code.', 429);

    const given = Buffer.from(codeHash(`admin:${admin.id}`, code), 'hex');
    const want = Buffer.from(row.code_hash, 'hex');
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      const attempts = row.attempts + 1;
      await db().from('csbfp_admin_login_codes').update({ attempts, ...(attempts >= MAX_ATTEMPTS ? { used_at: new Date().toISOString() } : {}) })
        .eq('id', row.id).eq('attempts', row.attempts);
      await logAdmin({ adminId: admin.id, action: 'admin_login_failed', ip: req.ip });
      return fail(attempts >= MAX_ATTEMPTS ? 'Too many incorrect attempts. Please request a new code.' : GENERIC);
    }
    const used = must(await db().from('csbfp_admin_login_codes').update({ used_at: new Date().toISOString() })
      .eq('id', row.id).is('used_at', null).select('id').maybeSingle(), 'Admin code use');
    if (!used) return fail(GENERIC);

    must(await db().from('csbfp_admin_users').update({ last_login_at: new Date().toISOString() }).eq('id', admin.id), 'Admin login time');
    await logAdmin({ adminId: admin.id, action: 'admin_login', ip: req.ip });
    adminSession.clearLoginEmail(res);
    adminSession.setSession(res, admin);
    return res.redirect(303, '/admin/registrants');
  } catch (err) { return next(err); }
});

router.post('/logout', (req, res) => {
  adminSession.clearSession(res);
  res.redirect(303, '/admin/login');
});

// Everything below requires a signed-in admin.
router.use(requireAdmin);

router.get('/', (req, res) => res.redirect('/admin/registrants'));

// ======================================================================
// Registrants
// ======================================================================

// PostgREST filter values can't contain these; names and emails never need them.
const clean = s => String(s || '').replace(/[,()%*\\:"]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

router.get('/registrants', async (req, res, next) => {
  try {
    const q = clean(req.query.q);
    let rows;
    const numberMatch = /^([a-z]{2,10})?-?(\d{8})$/i.exec(q.replace(/\s/g, ''));
    if (numberMatch) {
      const prefixes = numberMatch[1] ? [numberMatch[1].toUpperCase()] : [config.program.numberPrefix, config.program.demoNumberPrefix];
      const regs = must(await db().from('csbfp_registrations').select('registrant_id')
        .in('registration_number', prefixes.map(p => `${p}-${numberMatch[2]}`)), 'Number search');
      rows = regs.length ? must(await db().from('csbfp_registrants').select('*').in('id', regs.map(x => x.registrant_id)), 'Registrant') : [];
    } else {
      let query = db().from('csbfp_registrants').select('*').neq('account_status', 'deleted');
      if (q.includes('@')) query = query.ilike('email', `%${q.toLowerCase()}%`);
      else for (const word of q.split(' ').filter(Boolean)) query = query.or(`legal_first_name.ilike.%${word}%,legal_last_name.ilike.%${word}%,email.ilike.%${word}%`);
      rows = must(await query.order('created_at', { ascending: false }).limit(100), 'Registrant search');
    }
    const ids = rows.map(r => r.id);
    const [regs, flags] = ids.length ? await Promise.all([
      db().from('csbfp_registrations').select('registrant_id, status, registration_number, admin_hold').in('registrant_id', ids),
      db().from('csbfp_duplicate_flags').select('registrant_id').in('registrant_id', ids).eq('status', 'open'),
    ]) : [{ data: [] }, { data: [] }];
    const regBy = new Map(must(regs, 'Registrations').map(r => [r.registrant_id, r]));
    const flagged = new Set(must(flags, 'Flags').map(f => f.registrant_id));
    res.render('admin/registrants', { pageTitle: 'People', q, rows: rows.map(r => ({ ...r, reg: regBy.get(r.id) || {}, flagged: flagged.has(r.id) })) });
  } catch (err) { next(err); }
});

async function loadRegistrant(id) {
  if (!isUuid(id)) return null;
  return must(await db().from('csbfp_registrants').select('*').eq('id', id).maybeSingle(), 'Registrant');
}

router.get('/registrants/:id', async (req, res, next) => {
  try {
    const r = await loadRegistrant(req.params.id);
    if (!r) return next();
    return await renderDetail(req, res, r, {});
  } catch (err) { next(err); }
});

async function renderDetail(req, res, r, extra) {
    const id = r.id;
    const [reg, rels, prods, acc, flags, emails, events, titles, products, audit] = await Promise.all([
      db().from('csbfp_registrations').select('*').eq('registrant_id', id).maybeSingle(),
      db().from('csbfp_employment_relationships').select('*').eq('registrant_id', id).order('is_current', { ascending: false }).order('start_month', { ascending: false }),
      db().from('csbfp_registrant_products').select('product_id').eq('registrant_id', id),
      db().from('csbfp_legal_acceptances').select('*').eq('registrant_id', id).order('accepted_at', { ascending: false }),
      db().from('csbfp_duplicate_flags').select('*').or(`registrant_id.eq.${id},matched_registrant_id.eq.${id}`).order('created_at', { ascending: false }),
      db().from('csbfp_email_messages').select('template_key, status, to_email, created_at, sent_at, error').eq('registrant_id', id).order('created_at', { ascending: false }).limit(50),
      db().from('csbfp_events').select('event, actor, detail, created_at').eq('registrant_id', id).order('created_at', { ascending: false }).limit(50),
      db().from('csbfp_job_titles').select('id, label'),
      db().from('csbfp_financing_products').select('id, label'),
      db().from('csbfp_admin_audit_log').select('*').eq('target_type', 'registrant').eq('target_id', id).order('created_at', { ascending: false }).limit(50),
    ]);
    const registration = must(reg, 'Registration');
    const history = registration ? must(await db().from('csbfp_registration_status_history').select('*')
      .eq('registration_id', registration.id).order('created_at', { ascending: false }), 'Status history') : [];
    const titleBy = new Map(must(titles, 'Titles').map(t => [t.id, t.label]));
    const productBy = new Map(must(products, 'Products').map(p => [p.id, p.label]));

    // Names of the other accounts in any duplicate flags.
    const flagRows = must(flags, 'Flags');
    const otherIds = [...new Set(flagRows.map(f => (f.registrant_id === id ? f.matched_registrant_id : f.registrant_id)))];
    const others = otherIds.length ? must(await db().from('csbfp_registrants').select('id, legal_first_name, legal_last_name, email').in('id', otherIds), 'Other accounts') : [];
    const otherBy = new Map(others.map(o => [o.id, o]));

    const sc = registration ? await screening.forRegistration(registration.id) : null;
    const screeningEvents = sc ? await screening.events(sc.id) : [];
    const appeals = must(await db().from('csbfp_appeals').select('*').eq('registrant_id', id).order('created_at', { ascending: false }), 'Appeals');
    const train = await training.stateFor(id);
    const attempts = must(await db().from('csbfp_assessment_attempts').select('id, started_at, submitted_at, correct_count, question_count, passed')
      .eq('registrant_id', id).order('started_at', { ascending: false }), 'Attempts');
    const [subs, payments] = await Promise.all([
      db().from('csbfp_subscriptions').select('*').eq('registrant_id', id).order('created_at', { ascending: false }),
      db().from('csbfp_payments').select('*').eq('registrant_id', id).order('created_at', { ascending: false }),
    ]);
    let age = null;
    try { if (r.dob_enc) age = v.ageOn(decrypt(r.dob_enc)); } catch { age = null; }

    res.render('admin/registrant', {
      pageTitle: [r.legal_first_name, r.legal_last_name].filter(Boolean).join(' ') || r.email || 'Registrant',
      r, age, registration, history, train, attempts, subs: must(subs, 'Subscriptions'), payments: must(payments, 'Payments'),
      rels: must(rels, 'Employment').map(x => ({ ...x, title: [v.COMPANY_TYPE_LABELS[x.company_type], v.PRIMARY_ROLES[x.primary_role]].filter(Boolean).join(', ') })),
      products: must(prods, 'Products').map(p => productBy.get(p.product_id)).filter(Boolean),
      acceptances: must(acc, 'Acceptances'),
      flags: flagRows.map(f => ({ ...f, other: otherBy.get(f.registrant_id === id ? f.matched_registrant_id : f.registrant_id) || null })),
      emails: must(emails, 'Emails'), events: must(events, 'Events'), audit: must(audit, 'Audit'),
      screening: sc, screeningEvents, screeningLabels: screening.LABELS, appeals,
      revealedDob: null,
      msg: typeof req.query.msg === 'string' ? req.query.msg.slice(0, 200) : null,
      err: typeof req.query.err === 'string' ? req.query.err.slice(0, 200) : null,
      ...extra,
    });
}

// Show the date of birth once, on request. Every view is logged.
router.post('/registrants/:id/reveal-dob', async (req, res, next) => {
  try {
    const r = await loadRegistrant(req.params.id);
    if (!r) return next();
    if (!r.dob_enc) return backErr(res, r.id, 'No date of birth on file.');
    await logAdmin({ adminId: req.admin.id, action: 'dob_viewed', targetType: 'registrant', targetId: r.id, ip: req.ip });
    // Rendered directly (never put in a URL, where it would land in browser history and server logs).
    const [y, m, d] = decrypt(r.dob_enc).split('-');
    return await renderDetail(req, res, r, { revealedDob: `${m}/${d}/${y}`, msg: null, err: null });
  } catch (err) { next(err); }
});

// Correct personal information. Fields left as they are don't change. A reason is required.
router.post('/registrants/:id/edit', async (req, res, next) => {
  try {
    const r = await loadRegistrant(req.params.id);
    if (!r) return next();
    const reason = reasonOf(req.body);
    if (!reason) return backErr(res, r.id, 'A reason is required for every change.');

    const errors = {};
    const update = {};
    const str = s => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ') : '');
    for (const [field, label] of [['legal_first_name', 'First name'], ['middle_name', 'Middle name'], ['legal_last_name', 'Last name']]) {
      const val = str(req.body[field]);
      if (val.length > 60) errors[field] = `${label} is too long.`;
      else if (!val && field !== 'middle_name') { if (r[field]) errors[field] = `${label} can't be blank.`; }
      else if ((val || null) !== (r[field] || null)) update[field] = val || null;
    }
    const zip = str(req.body.zip5);
    if (zip && zip !== r.zip5) { if (/^\d{5}$/.test(zip)) update.zip5 = zip; else errors.zip5 = 'ZIP must be 5 digits.'; }
    const phone = str(req.body.phone);
    if (phone) {
      const p = v.normPhone(phone);
      if (!p) errors.phone = 'Phone must be a 10-digit U.S. number.';
      else if (p !== r.phone_e164) update.phone_e164 = p;
    }
    const email = v.normEmail(req.body.email);
    if (email && email !== r.email) {
      if (!v.validEmail(email)) errors.email = 'Invalid email address.';
      else if (await db().from('csbfp_registrants').select('id').eq('email', email).maybeSingle().then(x => x.data)) errors.email = 'Another account already uses that email.';
      else update.email = email;
    }
    const dob = str(req.body.dob);
    if (dob) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number(dob.slice(0, 4)) < 1900 || v.ageOn(dob) < 18) errors.dob = 'Invalid date of birth (must be 18 or older).';
      else {
        let current = null;
        try { current = r.dob_enc ? decrypt(r.dob_enc) : null; } catch { current = null; }
        if (dob !== current) Object.assign(update, { dob_enc: encrypt(dob), dob_hash: blindIndex(`dob:${dob}`) });
      }
    }
    if (Object.keys(errors).length) return backErr(res, r.id, Object.values(errors).join(' '));
    if (!Object.keys(update).length) return backErr(res, r.id, 'Nothing changed.');

    must(await db().from('csbfp_registrants').update(update).eq('id', r.id), 'Admin edit');
    const fields = Object.keys(update).filter(k => k !== 'dob_enc').map(k => (k === 'dob_hash' ? 'dob' : k));
    await logAdmin({ adminId: req.admin.id, action: 'registrant_edited', targetType: 'registrant', targetId: r.id, reason, detail: { fields }, ip: req.ip });
    await logEvent({ registrantId: r.id, event: 'edited_by_admin', actor: 'admin', detail: { fields } });
    const fresh = must(await db().from('csbfp_registrants').select('*').eq('id', r.id).single(), 'Reload');
    await checkDuplicates(fresh);
    return back(res, r.id, `Saved: ${fields.join(', ')}.`);
  } catch (err) { next(err); }
});

// Administrative hold: internal only. The public lookup will show "not found" while it's on, and payment is blocked.
router.post('/registrants/:id/hold', async (req, res, next) => {
  try {
    const r = await loadRegistrant(req.params.id);
    if (!r) return next();
    const reason = reasonOf(req.body);
    if (!reason) return backErr(res, r.id, 'A reason is required.');
    const reg = must(await db().from('csbfp_registrations').select('*').eq('registrant_id', r.id).single(), 'Registration');
    const place = req.body.action === 'place';
    if (place === reg.admin_hold) return backErr(res, r.id, place ? 'Already on hold.' : 'Not on hold.');
    must(await db().from('csbfp_registrations').update({ admin_hold: place, admin_hold_reason: place ? reason : null }).eq('id', reg.id), 'Hold');
    must(await db().from('csbfp_registration_status_history').insert({
      registration_id: reg.id, from_status: reg.status, to_status: reg.status, hold_change: place ? 'placed' : 'released',
      reason, actor_type: 'admin', actor_id: req.admin.id,
    }), 'Hold history');
    await logAdmin({ adminId: req.admin.id, action: place ? 'hold_placed' : 'hold_released', targetType: 'registrant', targetId: r.id, reason, ip: req.ip });
    return back(res, r.id, place ? 'Hold placed.' : 'Hold released.');
  } catch (err) { next(err); }
});

// Lock or unlock sign-in.
router.post('/registrants/:id/lock', async (req, res, next) => {
  try {
    const r = await loadRegistrant(req.params.id);
    if (!r) return next();
    const reason = reasonOf(req.body);
    if (!reason) return backErr(res, r.id, 'A reason is required.');
    const lock = req.body.action === 'lock';
    if (r.account_status === 'deleted') return backErr(res, r.id, 'This account has been deleted.');
    if (lock === (r.account_status === 'locked')) return backErr(res, r.id, lock ? 'Already locked.' : 'Not locked.');
    must(await db().from('csbfp_registrants').update({ account_status: lock ? 'locked' : 'active' }).eq('id', r.id), 'Lock');
    await logAdmin({ adminId: req.admin.id, action: lock ? 'account_locked' : 'account_unlocked', targetType: 'registrant', targetId: r.id, reason, ip: req.ip });
    await logEvent({ registrantId: r.id, event: lock ? 'locked_by_admin' : 'unlocked_by_admin', actor: 'admin' });
    return back(res, r.id, lock ? 'Account locked. They can no longer sign in.' : 'Account unlocked.');
  } catch (err) { next(err); }
});

// ======================================================================
// Possible duplicates
// ======================================================================

const MATCH_LABEL = {
  dob_last_name_zip: 'Same date of birth, last name and ZIP',
  dob_full_name: 'Same date of birth and full name',
  phone: 'Same mobile number',
};

router.get('/duplicates', async (req, res, next) => {
  try {
    const status = ['open', 'dismissed', 'merged'].includes(req.query.status) ? req.query.status : 'open';
    const flags = must(await db().from('csbfp_duplicate_flags').select('*').eq('status', status).order('created_at', { ascending: false }).limit(200), 'Flags');
    const ids = [...new Set(flags.flatMap(f => [f.registrant_id, f.matched_registrant_id]))];
    const people = ids.length ? must(await db().from('csbfp_registrants').select('id, legal_first_name, legal_last_name, email, created_at').in('id', ids), 'People') : [];
    const by = new Map(people.map(p => [p.id, p]));
    res.render('admin/duplicates', { pageTitle: 'Possible Duplicates', status, MATCH_LABEL,
      flags: flags.map(f => ({ ...f, a: by.get(f.registrant_id), b: by.get(f.matched_registrant_id) })),
      msg: typeof req.query.msg === 'string' ? req.query.msg.slice(0, 200) : null });
  } catch (err) { next(err); }
});

router.post('/duplicates/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return next();
    const flag = must(await db().from('csbfp_duplicate_flags').select('*').eq('id', req.params.id).maybeSingle(), 'Flag');
    if (!flag) return next();
    const note = reasonOf({ reason: req.body.note });
    const outcome = req.body.outcome === 'same_person' ? 'merged' : req.body.outcome === 'different_people' ? 'dismissed' : null;
    if (!outcome || !note) return res.redirect(303, `/admin/duplicates?msg=${encodeURIComponent('Choose an outcome and add a note.')}`);
    must(await db().from('csbfp_duplicate_flags').update({ status: outcome, note, reviewed_by: req.admin.id, reviewed_at: new Date().toISOString() })
      .eq('id', flag.id).eq('status', 'open'), 'Resolve flag');
    await logAdmin({ adminId: req.admin.id, action: 'duplicate_resolved', targetType: 'registrant', targetId: flag.registrant_id, reason: note,
      detail: { outcome, flag_id: flag.id, matched_registrant_id: flag.matched_registrant_id }, ip: req.ip });
    const to = req.body.return === 'registrant' ? `/admin/registrants/${flag.registrant_id}?msg=` : '/admin/duplicates?msg=';
    return res.redirect(303, to + encodeURIComponent('Flag resolved.'));
  } catch (err) { next(err); }
});

// ======================================================================
// Configurable lists
// ======================================================================

const LISTS = { titles: { table: 'csbfp_job_titles', label: 'Job titles' }, products: { table: 'csbfp_financing_products', label: 'Financing products' } };

router.get('/lists', async (req, res, next) => {
  try {
    const [titles, products] = await Promise.all([
      db().from('csbfp_job_titles').select('*').order('position'),
      db().from('csbfp_financing_products').select('*').order('position'),
    ]);
    res.render('admin/lists', { pageTitle: 'Lists', titles: must(titles, 'Titles'), products: must(products, 'Products'),
      msg: typeof req.query.msg === 'string' ? req.query.msg.slice(0, 200) : null });
  } catch (err) { next(err); }
});

router.post('/lists/:kind', async (req, res, next) => {
  try {
    const list = LISTS[req.params.kind];
    if (!list) return next();
    const label = String(req.body.label || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!label) return res.redirect(303, '/admin/lists?msg=' + encodeURIComponent('Enter a name.'));
    const all = must(await db().from(list.table).select('position'), 'Positions');
    const position = Math.max(0, ...all.map(x => x.position)) + 1;
    const { error } = await db().from(list.table).insert({ label, position });
    if (error) return res.redirect(303, '/admin/lists?msg=' + encodeURIComponent(error.code === '23505' ? 'That name already exists.' : 'Could not add it.'));
    await logAdmin({ adminId: req.admin.id, action: 'list_item_added', targetType: req.params.kind, detail: { label }, ip: req.ip });
    return res.redirect(303, '/admin/lists?msg=' + encodeURIComponent(`Added "${label}".`));
  } catch (err) { next(err); }
});

router.post('/lists/:kind/:id', async (req, res, next) => {
  try {
    const list = LISTS[req.params.kind];
    const id = parseInt(req.params.id, 10);
    if (!list || !id) return next();
    const item = must(await db().from(list.table).select('*').eq('id', id).maybeSingle(), 'List item');
    if (!item) return next();
    const update = {};
    const label = String(req.body.label || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (label && label !== item.label) update.label = label;
    const position = parseInt(req.body.position, 10);
    if (Number.isFinite(position) && position !== item.position) update.position = position;
    const active = req.body.active === 'yes';
    if (active !== item.active) update.active = active;
    if (!Object.keys(update).length) return res.redirect(303, '/admin/lists');
    const { error } = await db().from(list.table).update(update).eq('id', id);
    if (error) return res.redirect(303, '/admin/lists?msg=' + encodeURIComponent(error.code === '23505' ? 'That name already exists.' : 'Could not save.'));
    await logAdmin({ adminId: req.admin.id, action: 'list_item_updated', targetType: req.params.kind, targetId: id,
      detail: { fields: Object.keys(update), label: update.label || item.label }, ip: req.ip });
    return res.redirect(303, '/admin/lists?msg=' + encodeURIComponent('Saved.'));
  } catch (err) { next(err); }
});

// ======================================================================
// Audit log
// ======================================================================

router.get('/audit', async (req, res, next) => {
  try {
    const [rows, admins] = await Promise.all([
      db().from('csbfp_admin_audit_log').select('*').order('created_at', { ascending: false }).limit(200),
      db().from('csbfp_admin_users').select('id, email'),
    ]);
    const by = new Map(must(admins, 'Admins').map(a => [a.id, a.email]));
    res.render('admin/audit', { pageTitle: 'Audit Log', rows: must(rows, 'Audit').map(r => ({ ...r, who: by.get(r.admin_id) || '' })) });
  } catch (err) { next(err); }
});

module.exports = router;
