-- CSBFP: billing additions.

-- The registrant's Stripe customer (created at first checkout, reused for renewals and rejoining).
alter table public.csbfp_registrations
  add column stripe_customer_id text unique;

-- Stripe configuration created by the admin "Set up Stripe" action is kept in csbfp_settings
-- (stripe_price_id, stripe_portal_configuration_id, stripe_webhook_endpoint_id, and the webhook signing
-- secret encrypted with FIELD_ENCRYPTION_KEY). csbfp_settings is service-role only, like every csbfp_ table.
