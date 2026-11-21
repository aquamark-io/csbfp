-- Broker Registry: billing additions.

-- The registrant's Stripe customer (created at first checkout, reused for renewals and rejoining).
alter table public.br_registrations
  add column stripe_customer_id text unique;

-- Stripe configuration created by the admin "Set up Stripe" action is kept in br_settings
-- (stripe_price_id, stripe_portal_configuration_id, stripe_webhook_endpoint_id, and the webhook signing
-- secret encrypted with FIELD_ENCRYPTION_KEY). br_settings is service-role only, like every br_ table.
