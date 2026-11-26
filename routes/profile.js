/**
 * Signed-in registrant pages: dashboard and registration information.
 *
 *   GET      /portal/dashboard
 *   GET/POST /portal/personal
 *   GET      /portal/employment              status + list of relationships
 *   POST     /portal/employment/status
 *   GET/POST /portal/employment/new
 *   GET/POST /portal/employment/:id
 *   POST     /portal/employment/:id/delete
 *   GET/POST /portal/products                financing products
 *   GET/POST /portal/acknowledgments
 *
 * Every query is scoped to req.registrant.id.
 */
const express = require('express');
const { db, must } = require('../lib/supabase');
const { encrypt, decrypt, blindIndex } = require('../lib/crypto');
const { logEvent } = require('../lib/events');
const screening = require('../lib/screening');
const { progressFor, markProfileComplete } = require('../lib/progress');
const { checkDuplicates, hasOpenFlag } = require('../lib/duplicates');
const legal = require('../lib/legal');
const training = require('../lib/training');
const { requireRegistrant } = require('../middleware/auth');
const { sendQuietly, registrantVars } = require('../lib/email');

// Once a registration is no longer pending, changes to it are confirmed by email (at most once a day).
async function infoUpdated(registrant) {
  const reg = must(await db().from('csbfp_registrations').select('id, status').eq('registrant_id', registrant.id).maybeSingle(), 'Registration');
  if (!reg || reg.status === 'pending') return;
  sendQuietly({ dedupeKey: `info_updated:${reg.id}:${new Date().toISOString().slice(0, 10)}`, registrantId: registrant.id,
    templateKey: 'registration_info_updated', to: registrant.email, vars: registrantVars(registrant) });
}
const v = require('../lib/validate');

const router = express.Router();
router.use(requireRegistrant);

const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '');
const saved = (res, path) => res.redirect(303, `${path}?saved=1`);
const refresh = async id => must(await db().from('csbfp_registrants').select('*').eq('id', id).single(), 'Reload registrant');

// Name and date of birth appear on (or identify) the public registration, so they lock once it's no longer pending.
async function identityLocked(registrantId) {
  const reg = must(await db().from('csbfp_registrations').select('status').eq('registrant_id', registrantId).maybeSingle(), 'Registration');
  return Boolean(reg && reg.status !== 'pending');
}

async function lists() {
  const [titles, products] = await Promise.all([
    db().from('csbfp_job_titles').select('id, label').eq('active', true).order('position'),
    db().from('csbfp_financing_products').select('id, label').eq('active', true).order('position'),
  ]);
  return { titles: must(titles, 'Job titles'), products: must(products, 'Products') };
}

// ---------- dashboard ----------

router.get('/dashboard', async (req, res, next) => {
  try {
    const [progress, flagged, train] = await Promise.all([progressFor(req.registrant), hasOpenFlag(req.registrant.id), training.stateFor(req.registrant.id)]);
    const sc = progress.registration && progress.registration.id ? await screening.forRegistration(progress.registration.id) : null;
    const { data: job } = await db().from('csbfp_employment_relationships').select('company_name')
      .eq('registrant_id', req.registrant.id).eq('is_current', true).order('created_at', { ascending: false }).limit(1).maybeSingle();
    res.render('portal/dashboard', { pageTitle: 'Certification Dashboard', progress, flagged, train, screening: sc, saved: req.query.saved === '1',
      employer: job ? job.company_name : null, phone: v.fmtPhone(req.registrant.phone_e164) });
  } catch (err) { next(err); }
});

// ---------- personal information ----------

function personalValues(r) {
  const m = r.industry_start_month ? r.industry_start_month.split('-') : [];
  let dob = '';
  try { dob = r.dob_enc ? decrypt(r.dob_enc) : ''; } catch { dob = ''; }
  return {
    legal_first_name: r.legal_first_name || '', middle_name: r.middle_name || '', legal_last_name: r.legal_last_name || '',
    dob, zip5: r.zip5 || '', phone: v.fmtPhone(r.phone_e164),
    industry_start_year: m[0] || '', industry_start_month: m[1] ? String(Number(m[1])) : '',
  };
}

router.get('/personal', async (req, res, next) => {
  try {
    res.render('portal/personal', { pageTitle: 'Personal Information', values: personalValues(req.registrant), errors: {},
      locked: await identityLocked(req.registrant.id), saved: req.query.saved === '1' });
  } catch (err) { next(err); }
});

router.post('/personal', async (req, res, next) => {
  try {
    const r = req.registrant;
    const locked = await identityLocked(r.id);
    const body = { ...req.body };
    if (locked) Object.assign(body, { legal_first_name: r.legal_first_name, middle_name: r.middle_name || '', legal_last_name: r.legal_last_name, dob: personalValues(r).dob });

    const { errors, data } = v.validatePersonal(body);
    if (Object.keys(errors).length) {
      return res.status(422).render('portal/personal', { pageTitle: 'Personal Information', values: { ...req.body, ...(locked ? personalValues(r) : {}) }, errors, locked, saved: false });
    }
    const update = {
      phone_e164: data.phone_e164, zip5: data.zip5, industry_start_month: data.industry_start_month,
    };
    if (!locked) {
      Object.assign(update, {
        legal_first_name: data.legal_first_name, middle_name: data.middle_name, legal_last_name: data.legal_last_name,
        dob_enc: encrypt(data.dob), dob_hash: blindIndex(`dob:${data.dob}`),
      });
    }
    must(await db().from('csbfp_registrants').update(update).eq('id', r.id), 'Save personal information');
    await logEvent({ registrantId: r.id, event: 'personal_updated', actor: 'registrant', detail: { fields: Object.keys(update).filter(k => k !== 'dob_enc') }, ip: req.ip });

    const fresh = await refresh(r.id);
    await checkDuplicates(fresh);
    await markProfileComplete(fresh);
    await infoUpdated(fresh);
    return saved(res, '/portal/dashboard');
  } catch (err) { next(err); }
});

// ---------- employment ----------

router.get('/employment', async (req, res, next) => {
  try {
    const { titles } = await lists();
    const titleLabel = new Map(titles.map(t => [t.id, t.label]));
    const rels = must(await db().from('csbfp_employment_relationships')
      .select('*').eq('registrant_id', req.registrant.id).eq('is_current', true)
      .order('start_month', { ascending: false }), 'Relationships')
      .map(r => ({ ...r, title: r.job_title_other || titleLabel.get(r.job_title_id) || '',
        role: v.PRIMARY_ROLES[r.primary_role] || '', companyType: v.COMPANY_TYPE_LABELS[r.company_type] || '' }));
    res.render('portal/employment', { pageTitle: 'Employment', rels, saved: req.query.saved === '1', error: null });
  } catch (err) { next(err); }
});

router.post('/employment/status', async (req, res, next) => {
  try {
    const status = req.body.employment_status;
    if (!['working', 'not_currently_employed'].includes(status)) return res.redirect(303, '/portal/employment');
    must(await db().from('csbfp_registrants').update({ employment_status: status }).eq('id', req.registrant.id), 'Employment status');
    await logEvent({ registrantId: req.registrant.id, event: 'employment_status_updated', actor: 'registrant', detail: { status }, ip: req.ip });
    await markProfileComplete(await refresh(req.registrant.id));
    if (status === 'working') {
      const { count } = await db().from('csbfp_employment_relationships').select('id', { count: 'exact', head: true })
        .eq('registrant_id', req.registrant.id).eq('is_current', true);
      if (!count) return res.redirect(303, '/portal/employment');
    }
    return saved(res, '/portal/dashboard');
  } catch (err) { next(err); }
});

function relValues(rel) {
  if (!rel) return {};
  const [sy, sm] = (rel.start_month || '').split('-');
  return {
    relationship_type: rel.relationship_type, company_name: rel.company_name, company_website: rel.company_website || '',
    start_year: sy || '', start_month: sm ? String(Number(sm)) : '',
    work_arrangement: rel.work_arrangement, company_type: rel.company_type || '', primary_role: rel.primary_role || '',
  };
}

async function loadRel(req) {
  if (!isUuid(req.params.id)) return null;
  return must(await db().from('csbfp_employment_relationships').select('*')
    .eq('id', req.params.id).eq('registrant_id', req.registrant.id).maybeSingle(), 'Relationship');
}

async function relForm(req, res, rel) {
  res.render('portal/relationship', { pageTitle: rel ? 'Edit Employer' : 'Add Employer', rel, roles: v.PRIMARY_ROLES, companyTypes: v.COMPANY_TYPES, values: relValues(rel), errors: {} });
}

async function relSave(req, res, rel) {
  const { errors, data } = v.validateRelationship(req.body);
  if (Object.keys(errors).length) {
    return res.status(422).render('portal/relationship', { pageTitle: rel ? 'Edit Employer' : 'Add Employer', rel, roles: v.PRIMARY_ROLES, companyTypes: v.COMPANY_TYPES, values: req.body, errors });
  }
  if (rel) {
    must(await db().from('csbfp_employment_relationships').update(data).eq('id', rel.id).eq('registrant_id', req.registrant.id), 'Update relationship');
  } else {
    must(await db().from('csbfp_employment_relationships').insert({ ...data, registrant_id: req.registrant.id }), 'Add relationship');
    if (req.registrant.employment_status !== 'working') {
      must(await db().from('csbfp_registrants').update({ employment_status: 'working' }).eq('id', req.registrant.id), 'Employment status');
    }
  }
  await logEvent({ registrantId: req.registrant.id, event: rel ? 'employer_updated' : 'employer_added', actor: 'registrant', ip: req.ip });
  await markProfileComplete(await refresh(req.registrant.id));
  await infoUpdated(req.registrant);
  return saved(res, '/portal/dashboard');
}

router.get('/employment/new', (req, res, next) => relForm(req, res, null).catch(next));
router.post('/employment/new', (req, res, next) => relSave(req, res, null).catch(next));

router.get('/employment/:id', async (req, res, next) => {
  try {
    const rel = await loadRel(req);
    if (!rel) return next();
    return relForm(req, res, rel);
  } catch (err) { next(err); }
});

router.post('/employment/:id', async (req, res, next) => {
  try {
    const rel = await loadRel(req);
    if (!rel) return next();
    return relSave(req, res, rel);
  } catch (err) { next(err); }
});

router.post('/employment/:id/delete', async (req, res, next) => {
  try {
    const rel = await loadRel(req);
    if (!rel) return next();
    must(await db().from('csbfp_employment_relationships').delete().eq('id', rel.id).eq('registrant_id', req.registrant.id), 'Remove relationship');
    await logEvent({ registrantId: req.registrant.id, event: 'employer_removed', actor: 'registrant', ip: req.ip });
    return saved(res, '/portal/employment');
  } catch (err) { next(err); }
});

// ---------- products ----------

router.get('/products', async (req, res, next) => {
  try {
    const { products } = await lists();
    const mine = await db().from('csbfp_registrant_products').select('product_id').eq('registrant_id', req.registrant.id);
    const values = {
      products: must(mine, 'My products').map(p => String(p.product_id)),
      products_other: req.registrant.products_other || '',
    };
    res.render('portal/products', { pageTitle: 'Financing Products', products, values, errors: {}, saved: req.query.saved === '1' });
  } catch (err) { next(err); }
});

router.post('/products', async (req, res, next) => {
  try {
    const { products } = await lists();
    const { errors, data } = v.validateProducts(req.body, new Map(products.map(p => [p.id, p.label])));
    if (Object.keys(errors).length) {
      const asArr = x => (Array.isArray(x) ? x : x ? [x] : []);
      return res.status(422).render('portal/products', { pageTitle: 'Financing Products', products, errors, saved: false,
        values: { products: asArr(req.body.products) } });
    }
    const id = req.registrant.id;
    must(await db().from('csbfp_registrant_products').delete().eq('registrant_id', id), 'Clear products');
    must(await db().from('csbfp_registrant_products').insert(data.products.map(p => ({ registrant_id: id, product_id: p }))), 'Save products');
    await logEvent({ registrantId: id, event: 'products_updated', actor: 'registrant', ip: req.ip });
    await markProfileComplete(await refresh(id));
    await infoUpdated(req.registrant);
    return saved(res, '/portal/dashboard');
  } catch (err) { next(err); }
});

// ---------- acknowledgments ----------

router.get('/acknowledgments', async (req, res, next) => {
  try {
    const doc = await legal.currentDoc('acknowledgments');
    const accepted = must(await db().from('csbfp_legal_acceptances').select('document_version, accepted_at')
      .eq('registrant_id', req.registrant.id).eq('document_key', 'acknowledgments')
      .order('accepted_at', { ascending: false }).limit(1).maybeSingle(), 'Acknowledgments');
    res.render('portal/acknowledgments', { pageTitle: 'Professional Standards', doc, statements: legal.statements(doc), accepted,
      current: Boolean(accepted && doc && accepted.document_version === doc.version), error: null, checked: [] });
  } catch (err) { next(err); }
});

router.post('/acknowledgments', async (req, res, next) => {
  try {
    const doc = await legal.currentDoc('acknowledgments');
    const statements = legal.statements(doc);
    const checked = statements.map((_, i) => req.body[`ack_${i}`] === 'yes');
    if (!statements.length || checked.includes(false)) {
      return res.status(422).render('portal/acknowledgments', { pageTitle: 'Professional Standards', doc, statements, accepted: null, current: false,
        error: 'Please confirm each statement to continue.', checked });
    }
    await legal.recordAcceptance({ registrantId: req.registrant.id, keys: ['acknowledgments'], context: 'acknowledgments', ip: req.ip, userAgent: req.get('user-agent') });
    await logEvent({ registrantId: req.registrant.id, event: 'acknowledgments_accepted', actor: 'registrant', detail: { version: doc.version }, ip: req.ip });
    return res.redirect(303, '/portal/dashboard');
  } catch (err) { next(err); }
});

module.exports = router;
