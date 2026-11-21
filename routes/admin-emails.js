/**
 * Admin: email templates, delivery log, Postmark connection, daily job.
 *
 *   GET  /admin/emails                     templates by group + Postmark status
 *   GET  /admin/emails/log                 delivery log (?status=failed|bounced)
 *   GET  /admin/emails/t/:key              edit subject and body, with live preview
 *   GET  /admin/emails/t/:key/preview      the rendered email (sample values)
 *   POST /admin/emails/t/:key              save
 *   POST /admin/emails/t/:key/reset        back to the default wording
 *   POST /admin/emails/t/:key/test         send a test to yourself
 *   POST /admin/emails/postmark            connect delivery / bounce tracking (creates the Postmark webhook)
 *   GET  /admin/jobs, POST /admin/jobs/run daily job history; run it now
 */
const crypto = require('crypto');
const express = require('express');
const config = require('../lib/config');
const { db, must } = require('../lib/supabase');
const { encrypt } = require('../lib/crypto');
const email = require('../lib/email');
const jobs = require('../lib/jobs');
const { logAdmin } = require('../lib/audit');
const { requireAdmin } = require('../middleware/admin');

const router = express.Router();
router.use(requireAdmin);

const T = email.DEFAULTS;
const back = (res, path, m, isErr) => res.redirect(303, `${path}?${isErr ? 'err' : 'msg'}=${encodeURIComponent(m)}`);
const msgOf = req => ({ msg: typeof req.query.msg === 'string' ? req.query.msg.slice(0, 300) : null, err: typeof req.query.err === 'string' ? req.query.err.slice(0, 300) : null });
const placeholders = def => [...new Set([...`${def.subject}\n${def.body}`.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map(m => m[1]))];
const sampleVars = def => ({ first_name: 'Jane', ...def.sample });

router.get('/emails', async (req, res, next) => {
  try {
    const [rows, token, lastEvent, failed] = await Promise.all([
      db().from('br_email_templates').select('key, version, updated_at'),
      db().from('br_settings').select('updated_at').eq('key', 'postmark_webhook_token').maybeSingle(),
      db().from('br_postmark_events').select('record_type, received_at').order('received_at', { ascending: false }).limit(1).maybeSingle(),
      db().from('br_email_messages').select('id', { count: 'exact', head: true }).in('status', ['failed', 'bounced']),
    ]);
    const custom = new Map(must(rows, 'Templates').map(r => [r.key, r]));
    const groups = {};
    for (const [key, def] of Object.entries(T)) (groups[def.group] ||= []).push({ key, ...def, custom: custom.get(key) });
    res.render('admin/emails', { pageTitle: 'Emails', groups, postmark: { connected: Boolean(token.data), since: token.data && token.data.updated_at, lastEvent: lastEvent.data },
      problems: failed.count || 0, ...msgOf(req) });
  } catch (err) { next(err); }
});

router.get('/emails/log', async (req, res, next) => {
  try {
    const status = ['failed', 'bounced', 'queued'].includes(req.query.status) ? req.query.status : null;
    let q = db().from('br_email_messages').select('id, registrant_id, template_key, to_email, status, error, created_at, sent_at');
    if (status) q = q.eq('status', status);
    const rows = must(await q.order('created_at', { ascending: false }).limit(200), 'Email log');
    res.render('admin/email-log', { pageTitle: 'Email Log', rows, status, names: Object.fromEntries(Object.entries(T).map(([k, d]) => [k, d.name])) });
  } catch (err) { next(err); }
});

const keyOk = key => Object.hasOwn(T, key);

router.get('/emails/t/:key', async (req, res, next) => {
  try {
    if (!keyOk(req.params.key)) return next();
    const t = await email.templateFor(req.params.key);
    res.render('admin/email-template', { pageTitle: T[req.params.key].name, key: req.params.key, def: T[req.params.key], t,
      placeholders: placeholders(T[req.params.key]), ...msgOf(req) });
  } catch (err) { next(err); }
});

router.get('/emails/t/:key/preview', async (req, res, next) => {
  try {
    if (!keyOk(req.params.key)) return next();
    const out = await email.renderEmail(req.params.key, sampleVars(T[req.params.key]));
    // The email's own inline styles need a relaxed policy; it is only shown inside the admin page.
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'");
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.type('html').send(out.html);
  } catch (err) { next(err); }
});

router.post('/emails/t/:key', async (req, res, next) => {
  try {
    const key = req.params.key;
    if (!keyOk(key)) return next();
    const path = `/admin/emails/t/${key}`;
    const subject = String(req.body.subject || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const body = String(req.body.body_md || '').replace(/\r\n/g, '\n').trim().slice(0, 10000);
    if (!subject || !body) return back(res, path, 'Subject and body are both required.', true);
    if (T[key].body.includes('{{code}}') && !/^\{\{\s*code\s*\}\}$/m.test(body)) return back(res, path, 'This email must keep the {{code}} line, on a line of its own.', true);
    const existing = must(await db().from('br_email_templates').select('version').eq('key', key).maybeSingle(), 'Template');
    if (existing) must(await db().from('br_email_templates').update({ subject, body_md: body, version: existing.version + 1, updated_by: req.admin.id, updated_at: new Date().toISOString() }).eq('key', key), 'Save template');
    else must(await db().from('br_email_templates').insert({ key, subject, body_md: body, version: 1, updated_by: req.admin.id }), 'Save template');
    email.clearCache();
    await logAdmin({ adminId: req.admin.id, action: 'email_template_updated', targetType: 'email', targetId: key, detail: { label: T[key].name }, ip: req.ip });
    return back(res, path, 'Saved. New emails use this wording now.');
  } catch (err) { next(err); }
});

router.post('/emails/t/:key/reset', async (req, res, next) => {
  try {
    const key = req.params.key;
    if (!keyOk(key)) return next();
    must(await db().from('br_email_templates').delete().eq('key', key), 'Reset template');
    email.clearCache();
    await logAdmin({ adminId: req.admin.id, action: 'email_template_reset', targetType: 'email', targetId: key, detail: { label: T[key].name }, ip: req.ip });
    return back(res, `/admin/emails/t/${key}`, 'Restored the default wording.');
  } catch (err) { next(err); }
});

router.post('/emails/t/:key/test', async (req, res, next) => {
  try {
    const key = req.params.key;
    if (!keyOk(key)) return next();
    await email.sendDirect({ to: req.admin.email, templateKey: key, vars: sampleVars(T[key]) });
    return back(res, `/admin/emails/t/${key}`, `Test sent to ${req.admin.email}.`);
  } catch (err) {
    return back(res, `/admin/emails/t/${req.params.key}`, `Test failed: ${err.message}`, true);
  }
});

// Create (or replace) the Postmark webhook for delivery, bounce and spam-complaint events.
router.post('/emails/postmark', async (req, res, next) => {
  try {
    const serverToken = process.env.POSTMARK_SERVER_TOKEN;
    if (!serverToken) return back(res, '/admin/emails', 'POSTMARK_SERVER_TOKEN is not set.', true);
    const pm = async (method, path, body) => {
      const r = await fetch(`https://api.postmarkapp.com${path}`, { method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': serverToken },
        body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      if (!r.ok) throw new Error(`Postmark ${r.status}: ${text.slice(0, 800)}`);
      return text ? JSON.parse(text) : {};
    };
    const base = `${config.siteUrl}/webhooks/postmark`;
    // Save the token BEFORE creating the webhook: Postmark calls the endpoint to verify it, and the endpoint
    // checks the token against this saved value.
    const token = crypto.randomBytes(24).toString('hex');
    const value = encrypt(token);
    const row = must(await db().from('br_settings').select('key').eq('key', 'postmark_webhook_token').maybeSingle(), 'Setting');
    if (row) must(await db().from('br_settings').update({ value, updated_by: req.admin.id, updated_at: new Date().toISOString() }).eq('key', 'postmark_webhook_token'), 'Save token');
    else must(await db().from('br_settings').insert({ key: 'postmark_webhook_token', value, updated_by: req.admin.id }), 'Save token');
    const existing = await pm('GET', '/webhooks?MessageStream=outbound');
    for (const w of existing.Webhooks || []) if (String(w.Url || '').startsWith(base)) await pm('DELETE', `/webhooks/${w.ID}`);
    await pm('POST', '/webhooks', {
      Url: `${base}?token=${token}`, MessageStream: 'outbound',
      Triggers: { Delivery: { Enabled: true }, Bounce: { Enabled: true, IncludeContent: false }, SpamComplaint: { Enabled: true, IncludeContent: false },
        Open: { Enabled: false }, Click: { Enabled: false }, SubscriptionChange: { Enabled: false } },
    });
    await logAdmin({ adminId: req.admin.id, action: 'postmark_connected', ip: req.ip });
    return back(res, '/admin/emails', 'Postmark delivery and bounce tracking is connected.');
  } catch (err) {
    return back(res, '/admin/emails', `Could not connect Postmark: ${err.message}`, true);
  }
});

// ---------- daily job ----------

router.get('/jobs', async (req, res, next) => {
  try {
    const runs = must(await db().from('br_job_runs').select('*').order('started_at', { ascending: false }).limit(14), 'Job runs');
    res.render('admin/jobs', { pageTitle: 'Daily Job', runs, ...msgOf(req), result: null });
  } catch (err) { next(err); }
});

router.post('/jobs/run', async (req, res, next) => {
  try {
    const result = await jobs.runTasks(new Date());
    await logAdmin({ adminId: req.admin.id, action: 'daily_job_run_manually', detail: result, ip: req.ip });
    const runs = must(await db().from('br_job_runs').select('*').order('started_at', { ascending: false }).limit(14), 'Job runs');
    res.render('admin/jobs', { pageTitle: 'Daily Job', runs, msg: 'Ran the daily tasks now.', err: null, result });
  } catch (err) { next(err); }
});

module.exports = router;
