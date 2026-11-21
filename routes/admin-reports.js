/**
 * Admin: reports, legal documents, launch checklist.
 *
 *   GET  /admin/reports            counts, monthly sign-ups / activations, renewal, training and payment figures
 *   GET  /admin/legal              legal documents and their current versions
 *   GET  /admin/legal/:key         edit and publish a new version (old versions are kept)
 *   POST /admin/legal/:key
 *   GET  /admin/launch             launch checklist
 *   POST /admin/launch/reset       remove all preview (test) registrant data; only while PRE_LAUNCH is on and Stripe is in test mode
 */
const express = require('express');
const config = require('../lib/config');
const { db, must } = require('../lib/supabase');
const S = require('../lib/stripe');
const legal = require('../lib/legal');
const training = require('../lib/training');
const turnstile = require('../lib/turnstile');
const { render: renderMd } = require('../lib/markdown');
const { logAdmin } = require('../lib/audit');
const { requireAdmin } = require('../middleware/admin');

const router = express.Router();
router.use(requireAdmin);

const DAY = 864e5;
const msgOf = req => ({ msg: typeof req.query.msg === 'string' ? req.query.msg.slice(0, 300) : null, err: typeof req.query.err === 'string' ? req.query.err.slice(0, 300) : null });
const go = (res, path, m, isErr) => res.redirect(303, `${path}?${isErr ? 'err' : 'msg'}=${encodeURIComponent(m)}`);

// Read every row of a query in pages (PostgREST returns at most 1000 rows per request).
async function all(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = must(await build().range(from, from + 999), 'Report query');
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
const count = async (q) => { const { count: c, error } = await q; if (error) throw new Error(error.message); return c || 0; };
const monthKey = d => d.slice(0, 7);
function lastMonths(n) {
  const out = [];
  const d = new Date();
  d.setUTCDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(x.toISOString().slice(0, 7));
  }
  return out;
}

// ---------- reports ----------

router.get('/reports', async (req, res, next) => {
  try {
    const head = t => db().from(t).select('id', { count: 'exact', head: true });
    const statuses = {};
    for (const s of ['pending', 'active', 'inactive', 'expired']) statuses[s] = await count(head('csbfp_registrations').eq('status', s).is('retired_at', null));
    const accounts = await count(head('csbfp_registrants').neq('account_status', 'deleted'));
    const verified = await count(head('csbfp_registrants').neq('account_status', 'deleted').not('email_verified_at', 'is', null));
    const deleted = await count(head('csbfp_registrants').eq('account_status', 'deleted'));

    const yearAgo = new Date(Date.now() - 365 * DAY).toISOString();
    const months = lastMonths(12);
    const signups = await all(() => db().from('csbfp_registrants').select('created_at').gte('created_at', `${months[0]}-01`).order('created_at'));
    const activations = await all(() => db().from('csbfp_registrations').select('first_activated_at').gte('first_activated_at', `${months[0]}-01`).order('first_activated_at'));
    const monthly = months.map(m => ({ month: m,
      signups: signups.filter(r => monthKey(r.created_at) === m).length,
      activations: activations.filter(r => r.first_activated_at && monthKey(r.first_activated_at) === m).length }));

    // Renewal rate, last 12 months: paid renewals / (paid renewals + registrations that lapsed to Inactive or Expired).
    const renewalsPaid = await count(head('csbfp_payments').eq('billing_reason', 'renewal').eq('status', 'paid').gte('created_at', yearAgo));
    const lapsed = await count(db().from('csbfp_registration_status_history').select('id', { count: 'exact', head: true })
      .eq('from_status', 'active').in('to_status', ['inactive', 'expired']).gte('created_at', yearAgo));
    const renewalRate = renewalsPaid + lapsed ? Math.round((renewalsPaid / (renewalsPaid + lapsed)) * 100) : null;

    // Training completion (current required version) and assessment.
    let trainingStats = null;
    const cur = await training.requiredCurriculum();
    if (cur) {
      const mods = await training.modulesOf(cur.id);
      const progress = mods.length ? await all(() => db().from('csbfp_training_progress').select('registrant_id, module_id, completed_at').in('module_id', mods.map(m => m.id)).order('registrant_id')) : [];
      const by = new Map();
      for (const p of progress) { const x = by.get(p.registrant_id) || 0; by.set(p.registrant_id, x + (p.completed_at ? 1 : 0)); }
      const started = by.size;
      const completed = [...by.values()].filter(c => c >= mods.length).length;
      const attempts = await all(() => db().from('csbfp_assessment_attempts').select('registrant_id, passed, submitted_at').eq('curriculum_version_id', cur.id).order('started_at'));
      const tried = new Set(attempts.filter(a => a.submitted_at).map(a => a.registrant_id));
      const passed = new Set(attempts.filter(a => a.passed).map(a => a.registrant_id));
      trainingStats = { label: cur.label, started, completed, rate: started ? Math.round((completed / started) * 100) : null,
        tried: tried.size, passed: passed.size, passRate: tried.size ? Math.round((passed.size / tried.size) * 100) : null, attempts: attempts.filter(a => a.submitted_at).length };
    }

    // Payments.
    const monthAgo = new Date(Date.now() - 30 * DAY).toISOString();
    const paid30 = await all(() => db().from('csbfp_payments').select('amount_cents').eq('status', 'paid').gte('paid_at', monthAgo).order('paid_at'));
    const paid12 = await all(() => db().from('csbfp_payments').select('amount_cents').eq('status', 'paid').gte('paid_at', yearAgo).order('paid_at'));
    const failedOpen = await count(head('csbfp_payments').eq('status', 'failed'));
    const autoOff = await count(db().from('csbfp_subscriptions').select('id', { count: 'exact', head: true }).eq('cancel_at_period_end', true).in('stripe_status', ['active', 'past_due']));
    const sum = rows => rows.reduce((a, r) => a + (r.amount_cents || 0), 0) / 100;

    res.render('admin/reports', { pageTitle: 'Reports', statuses, accounts, verified, deleted, monthly, renewalsPaid, lapsed, renewalRate, trainingStats,
      payments: { count30: paid30.length, revenue30: sum(paid30), count12: paid12.length, revenue12: sum(paid12), failedOpen, autoOff }, mode: S.mode() });
  } catch (err) { next(err); }
});

// ---------- legal documents ----------

router.get('/legal', async (req, res, next) => {
  try {
    const rows = must(await db().from('csbfp_legal_documents').select('key, version, title, body_md, published_at, status').order('version', { ascending: false }), 'Legal');
    const docs = Object.entries(legal.KEYS).map(([key, title]) => {
      const cur = rows.find(r => r.key === key && r.status === 'published');
      return { key, title, cur, placeholder: !cur || /placeholder/i.test(cur.body_md), versions: rows.filter(r => r.key === key).length };
    });
    res.render('admin/legal', { pageTitle: 'Legal Documents', docs, ...msgOf(req) });
  } catch (err) { next(err); }
});

router.get('/legal/:key', async (req, res, next) => {
  try {
    const key = req.params.key;
    if (!Object.hasOwn(legal.KEYS, key)) return next();
    const versions = must(await db().from('csbfp_legal_documents').select('*').eq('key', key).order('version', { ascending: false }), 'Versions');
    const cur = versions.find(v => v.status === 'published') || null;
    res.render('admin/legal-edit', { pageTitle: legal.KEYS[key], key, title: legal.KEYS[key], cur, versions, preview: cur ? renderMd(cur.body_md) : '',
      isList: ['acknowledgments', 'conduct_standards'].includes(key), ...msgOf(req) });
  } catch (err) { next(err); }
});

router.post('/legal/:key', async (req, res, next) => {
  try {
    const key = req.params.key;
    if (!Object.hasOwn(legal.KEYS, key)) return next();
    const path = `/admin/legal/${key}`;
    const body = String(req.body.body_md || '').replace(/\r\n/g, '\n').trim().slice(0, 100000);
    if (!body) return go(res, path, 'The document is empty.', true);
    if (['acknowledgments', 'conduct_standards'].includes(key) && !legal.statements({ body_md: body }).length) {
      return go(res, path, 'This document needs at least one "- " statement line (each becomes a checkbox).', true);
    }
    if (req.body.confirm !== 'yes') return go(res, path, 'Tick the confirmation box to publish.', true);
    const versions = must(await db().from('csbfp_legal_documents').select('version').eq('key', key), 'Versions');
    const version = Math.max(0, ...versions.map(v => v.version)) + 1;
    const now = new Date().toISOString();
    must(await db().from('csbfp_legal_documents').insert({ key, version, title: legal.KEYS[key], body_md: body, status: 'published', effective_at: now, published_at: now }), 'Publish');
    legal.clearCache();
    await logAdmin({ adminId: req.admin.id, action: 'legal_document_published', targetType: 'legal', targetId: key, detail: { label: legal.KEYS[key], version }, ip: req.ip });
    return go(res, path, `Version ${version} is published. New acceptances record version ${version}.`);
  } catch (err) { next(err); }
});

// ---------- launch ----------

async function previewCounts() {
  const head = t => db().from(t).select('*', { count: 'exact', head: true });
  return {
    registrants: await count(head('csbfp_registrants')), registrations: await count(head('csbfp_registrations').not('registration_number', 'is', null)),
    payments: await count(head('csbfp_payments')), support: await count(head('csbfp_support_requests')),
  };
}

router.get('/launch', async (req, res, next) => {
  try {
    const docs = must(await db().from('csbfp_legal_documents').select('key, version, body_md, status').eq('status', 'published').order('version', { ascending: false }), 'Legal');
    const current = new Map();
    for (const d of docs) if (!current.has(d.key)) current.set(d.key, d);
    const placeholders = Object.keys(legal.KEYS).filter(k => !current.get(k) || /placeholder/i.test(current.get(k).body_md)).map(k => legal.KEYS[k]);
    const cur = await training.requiredCurriculum();
    const stripeCfg = S.blockedReason() ? { ready: false } : await S.stripeConfig();
    const pm = must(await db().from('csbfp_settings').select('key').eq('key', 'postmark_webhook_token').maybeSingle(), 'Postmark');
    res.render('admin/launch', { pageTitle: 'Launch', preLaunch: config.preLaunch, mode: S.mode(), stripeBlocked: S.blockedReason(), stripeReady: stripeCfg.ready,
      postmark: Boolean(pm) && Boolean(process.env.POSTMARK_SERVER_TOKEN), placeholders, training: cur, turnstile: turnstile.enabled(),
      counts: await previewCounts(), adminEmails: config.adminEmails, ...msgOf(req) });
  } catch (err) { next(err); }
});

// Delete every registrant-related row. Only before launch, and only while Stripe is in test mode.
router.post('/launch/reset', async (req, res, next) => {
  try {
    if (!config.preLaunch) return go(res, '/admin/launch', 'Preview data can only be removed while PRE_LAUNCH is on.', true);
    if (S.isLiveKey()) return go(res, '/admin/launch', 'Stripe is in live mode; preview data can no longer be removed this way.', true);
    if (req.body.confirm !== 'REMOVE PREVIEW DATA') return go(res, '/admin/launch', 'Type REMOVE PREVIEW DATA to confirm.', true);
    const before = await previewCounts();
    const del = (t, col = 'id') => db().from(t).delete().not(col, 'is', null);
    for (const [t, col] of [
      ['csbfp_legal_acceptances'], ['csbfp_registration_status_history'], ['csbfp_payments'], ['csbfp_subscriptions'], ['csbfp_stripe_events'],
      ['csbfp_assessment_attempts'], ['csbfp_assessment_resets'], ['csbfp_training_progress', 'registrant_id'], ['csbfp_employment_relationships'],
      ['csbfp_registrant_products', 'registrant_id'], ['csbfp_registrant_states', 'registrant_id'], ['csbfp_duplicate_flags'], ['csbfp_support_requests'],
      ['csbfp_login_codes'], ['csbfp_email_messages'], ['csbfp_postmark_events'], ['csbfp_events'], ['csbfp_verify_lookups'], ['csbfp_registrations'], ['csbfp_registrants'],
    ]) must(await del(t, col), `Clear ${t}`);
    await logAdmin({ adminId: req.admin.id, action: 'preview_data_removed', detail: before, ip: req.ip });
    return go(res, '/admin/launch', `Removed preview data: ${before.registrants} accounts, ${before.payments} payments. Training, legal documents, email wording, settings and the audit log were kept.`);
  } catch (err) { next(err); }
});

module.exports = router;
