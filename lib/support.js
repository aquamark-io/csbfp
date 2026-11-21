/**
 * Support requests (contact form, portal requests, data deletion). Each request gets a reference like SR-7F3A21,
 * a confirmation email to the requester, and an alert to every address in ADMIN_EMAILS (without the message text).
 */
const config = require('./config');
const { db, must } = require('./supabase');
const { sendQuietly } = require('./email');
const { logEvent } = require('./events');

const CATEGORIES = {
  account_recovery: 'signing in or account access',
  data_correction: 'correcting my information',
  billing: 'billing or payment',
  duplicate_review: 'registration review',
  assessment_reset: 'assessment attempts',
  data_deletion: 'deleting my data',
  other: 'something else',
};

const referenceOf = id => `SR-${String(id).replace(/-/g, '').slice(0, 6).toUpperCase()}`;

async function createRequest({ registrantId = null, contactEmail, name = '', category, message, firstName = null, ip = null }) {
  const cat = Object.hasOwn(CATEGORIES, category) ? category : 'other';
  const text = name ? `From: ${name}\n\n${message}` : message;
  const row = must(await db().from('br_support_requests').insert({ registrant_id: registrantId, contact_email: contactEmail, category: cat, message: text })
    .select('id').single(), 'Support request');
  const reference = referenceOf(row.id);
  const topic = CATEGORIES[cat];
  sendQuietly({ dedupeKey: `support_received:${row.id}`, registrantId, templateKey: 'support_request_received', to: contactEmail,
    vars: { first_name: firstName || (name ? name.split(' ')[0] : 'there'), topic, reference } });
  for (const admin of config.adminEmails) {
    sendQuietly({ dedupeKey: `support_alert:${row.id}:${admin}`, templateKey: 'admin_support_alert', to: admin, vars: { topic, reference } });
  }
  if (registrantId) await logEvent({ registrantId, event: 'support_request', actor: 'registrant', detail: { category: cat, reference }, ip });
  return { id: row.id, reference };
}

module.exports = { CATEGORIES, createRequest, referenceOf };
