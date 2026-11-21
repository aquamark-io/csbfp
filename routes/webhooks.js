/**
 * Stripe webhooks: POST /webhooks/stripe
 * The signature is checked against the signing secret saved by the admin "Set up Stripe" action. Each event is
 * processed once (br_stripe_events). A 500 makes Stripe retry later.
 */
const express = require('express');
const { stripe, stripeConfig, blockedReason } = require('../lib/stripe');
const billing = require('../lib/billing');

const router = express.Router();

router.post('/webhooks/stripe', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (blockedReason()) return res.status(503).json({ error: 'payments disabled' });
  const { webhookSecret } = await stripeConfig().catch(() => ({}));
  if (!webhookSecret) return res.status(503).json({ error: 'not configured' });
  let event;
  try {
    event = stripe().webhooks.constructEvent(req.body, req.get('stripe-signature') || '', webhookSecret);
  } catch {
    return res.status(400).json({ error: 'bad signature' });
  }
  try {
    const result = await billing.handleEvent(event);
    return res.json({ received: true, result });
  } catch (err) {
    console.error(`Stripe webhook ${event.type} ${event.id} failed:`, err.message);
    return res.status(500).json({ error: 'failed' });
  }
});

/**
 * Postmark delivery / bounce / spam-complaint webhooks: POST /webhooks/postmark?token=...
 * The token is created by the admin "Connect Postmark" action and stored encrypted in br_settings.
 */
const crypto = require('crypto');
const { db } = require('../lib/supabase');
const { decrypt } = require('../lib/crypto');

async function postmarkToken() {
  const { data } = await db().from('br_settings').select('value').eq('key', 'postmark_webhook_token').maybeSingle();
  try { return data && data.value ? decrypt(data.value) : null; } catch { return null; }
}

async function tokenOk(req) {
  const want = await postmarkToken().catch(() => null);
  const given = typeof req.query.token === 'string' ? req.query.token : '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(want || '').digest();
  return Boolean(want) && crypto.timingSafeEqual(a, b);
}

// Postmark checks a new webhook address before saving it.
router.get('/webhooks/postmark', async (req, res) => res.status((await tokenOk(req)) ? 200 : 401).json({ ok: true }));

router.post('/webhooks/postmark', express.json({ limit: '200kb', type: () => true, strict: false }), async (req, res) => {
  if (!(await tokenOk(req))) return res.status(401).json({ error: 'unauthorized' });
  try {
    const e = req.body && typeof req.body === 'object' ? req.body : {};
    if (!e.RecordType && !e.MessageID) return res.json({ ok: true }); // verification ping / empty test
    const id = e.MessageID || null;
    // Keep the outcome, not message content.
    const payload = { RecordType: e.RecordType, Type: e.Type, TypeCode: e.TypeCode, Description: e.Description, Details: e.Details,
      DeliveredAt: e.DeliveredAt, BouncedAt: e.BouncedAt, Tag: e.Tag, Recipient: e.Recipient || e.Email };
    await db().from('br_postmark_events').insert({ message_id: id, record_type: e.RecordType || 'unknown', payload });
    if (id) {
      const update = e.RecordType === 'Delivery' ? { status: 'delivered' }
        : e.RecordType === 'Bounce' ? { status: 'bounced', error: `${e.Type || 'Bounce'}: ${(e.Description || '').slice(0, 300)}` }
          : e.RecordType === 'SpamComplaint' ? { status: 'bounced', error: 'Marked as spam by the recipient' } : null;
      if (update) {
        let q = db().from('br_email_messages').update(update).eq('postmark_message_id', id);
        if (update.status === 'delivered') q = q.eq('status', 'sent'); // never overwrite a bounce with "delivered"
        await q;
      }
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('Postmark webhook failed:', err.message);
    return res.status(500).json({ error: 'failed' }); // Postmark retries
  }
});

module.exports = router;
