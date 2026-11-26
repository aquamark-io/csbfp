/**
 * Transactional email through Postmark.
 *
 * sendOnce({ dedupeKey, templateKey, to, vars, registrantId }) renders the template (admin override from
 * csbfp_email_templates, else the default in lib/email-templates.js), records the send in csbfp_email_messages under a
 * unique dedupe key (so the same email is never sent twice), then sends it. Without POSTMARK_SERVER_TOKEN outside
 * production, emails are printed to the server log instead.
 *
 * Never pass a date of birth into any template.
 */
const config = require('./config');
const { db } = require('./supabase');
const DEFAULTS = require('./email-templates');
const { render: renderMd, esc } = require('./markdown');

const FOOTER = `${config.program.name} (CSBFP) is a private industry certification. `
  + 'It is not a government license and does not authorize anyone to perform activities that require a license.';

async function postmark({ to, subject, text, html, tag }) {
  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': process.env.POSTMARK_SERVER_TOKEN },
    body: JSON.stringify({
      From: config.emailFrom, ReplyTo: config.emailReplyTo, To: to, Subject: subject, TextBody: text, HtmlBody: html,
      Tag: tag, MessageStream: 'outbound', TrackOpens: false, TrackLinks: 'None',
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Postmark ${res.status}: ${body.slice(0, 300)}`);
  try { return JSON.parse(body); } catch { return {}; }
}

// ---------- templates ----------

let cache = { at: 0, rows: null };
async function overrides() {
  if (cache.rows && Date.now() - cache.at < 60 * 1000) return cache.rows;
  const { data, error } = await db().from('csbfp_email_templates').select('key, subject, body_md, version, updated_at');
  if (error) { console.error('Email template load failed:', error.message); return cache.rows || new Map(); }
  cache = { at: Date.now(), rows: new Map((data || []).map(r => [r.key, r])) };
  return cache.rows;
}
const clearCache = () => { cache = { at: 0, rows: null }; };

async function templateFor(key) {
  const def = DEFAULTS[key];
  if (!def) throw new Error(`Unknown email template ${key}`);
  const o = (await overrides()).get(key);
  return { def, subject: o ? o.subject : def.subject, body: o ? o.body_md : def.body, version: o ? o.version : 0, custom: Boolean(o) };
}

const fill = (s, vars) => String(s).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
const plain = md => md.replace(/^#\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1');

// Build { subject, html, text } from a template and values.
function build({ subject, body, def }, vars) {
  const v = { first_name: 'there', ...vars };
  const filledSubject = fill(subject, v).replace(/\s+/g, ' ').trim();
  let md = fill(body, { ...v, code: '\u0000CODE\u0000' });
  let heading = filledSubject;
  const m = /^#\s+(.+)\n*/.exec(md);
  if (m) { heading = m[1].trim(); md = md.slice(m[0].length); }

  const codeHtml = v.code ? `<p style="margin:8px 0 24px;font-size:30px;font-weight:700;letter-spacing:6px;color:#1f4796;">${esc(v.code)}</p>` : '';
  const bodyHtml = renderMd(md)
    .replace(/<p>\u0000CODE\u0000<\/p>/g, codeHtml)
    .replace(/<p>/g, '<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#37424f;">')
    .replace(/<ul>/g, '<ul style="margin:0 0 16px;padding-left:20px;font-size:15px;line-height:1.6;color:#37424f;">')
    .replace(/<h2>/g, '<h2 style="margin:20px 0 8px;font-size:16px;color:#16202b;">');
  const button = def.button ? { label: def.button.label, href: def.button.href || `${config.siteUrl}${def.button.path}` } : null;
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#f5f7f9;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#16202b;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7f9;padding:28px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #dde2e8;border-radius:8px;">
    <tr><td style="padding:20px 28px;border-bottom:1px solid #dde2e8;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;"><img src="${esc(config.siteUrl)}/img/csbfp-logo.png" width="104" height="54" alt="Certified SBFP" style="display:block;border:0;width:104px;height:54px;"></td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:28px 28px 8px;">
      <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:650;color:#16202b;">${esc(heading)}</h1>
      ${bodyHtml}
      ${button ? `<p style="margin:8px 0 24px;"><a href="${esc(button.href)}" style="display:inline-block;background:#1f4796;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:11px 22px;border-radius:6px;">${esc(button.label)}</a></p>` : ''}
    </td></tr>
    <tr><td style="padding:18px 28px 24px;border-top:1px solid #dde2e8;font-size:12px;line-height:1.6;color:#64707d;">${esc(FOOTER)}</td></tr>
  </table>
</td></tr></table>
</body></html>`;
  const text = [heading, '', plain(md).replace(/\u0000CODE\u0000/g, v.code || '').trim(), '',
    ...(button ? [`${button.label}: ${button.href}`, ''] : []), '--', FOOTER].join('\n');
  return { subject: filledSubject, html, text };
}

async function renderEmail(templateKey, vars = {}) {
  const t = await templateFor(templateKey);
  return { ...build(t, vars), version: t.version };
}

// Values every registrant email can use.
const registrantVars = r => ({ first_name: (r && r.legal_first_name) || 'there' });

/**
 * Send one email at most once per dedupe key. Returns 'sent', 'logged', 'duplicate' or throws.
 */
async function sendOnce({ dedupeKey, registrantId = null, templateKey, to, vars = {} }) {
  const email = await renderEmail(templateKey, vars);
  const { data: row, error } = await db().from('csbfp_email_messages')
    .insert({ dedupe_key: dedupeKey, registrant_id: registrantId, template_key: templateKey, template_version: email.version, to_email: to, status: 'queued' })
    .select('id').single();
  if (error) {
    if (error.code === '23505') return 'duplicate';
    throw new Error(`Email log insert: ${error.message}`);
  }
  if (!process.env.POSTMARK_SERVER_TOKEN && !config.production) {
    console.log(`\n[email] to=${to} template=${templateKey} subject="${email.subject}"\n${email.text}\n`);
    await db().from('csbfp_email_messages').update({ status: 'sent', sent_at: new Date().toISOString(), attempts: 1 }).eq('id', row.id);
    return 'logged';
  }
  try {
    const out = await postmark({ to, subject: email.subject, text: email.text, html: email.html, tag: templateKey });
    await db().from('csbfp_email_messages')
      .update({ status: 'sent', sent_at: new Date().toISOString(), attempts: 1, postmark_message_id: out.MessageID || null }).eq('id', row.id);
    return 'sent';
  } catch (err) {
    await db().from('csbfp_email_messages').update({ status: 'failed', attempts: 1, error: err.message.slice(0, 500) }).eq('id', row.id);
    throw err;
  }
}

// Fire-and-forget version for request handlers: never fails the request.
const sendQuietly = (opts) => sendOnce(opts).catch(err => console.error(`Email ${opts.templateKey} failed:`, err.message));

// Send without the dedupe log (admin test sends).
async function sendDirect({ to, templateKey, vars }) {
  const email = await renderEmail(templateKey, vars);
  if (!process.env.POSTMARK_SERVER_TOKEN && !config.production) {
    console.log(`\n[email] to=${to} template=${templateKey} subject="${email.subject}"\n${email.text}\n`);
    return 'logged';
  }
  await postmark({ to, subject: `[Test] ${email.subject}`, text: email.text, html: email.html, tag: `test-${templateKey}` });
  return 'sent';
}

const fmtDate = d => (d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '');

module.exports = { sendOnce, sendQuietly, sendDirect, renderEmail, templateFor, build, registrantVars, fmtDate, clearCache, DEFAULTS, esc };
