# Broker Registry

An independently administered registration program for individuals working in U.S. alternative commercial finance.
Operated by Duncan Consulting LLC. <https://broker-registry.org>

Node 20+, Express 4, EJS. One Render web service serves everything on `broker-registry.org`:

| Path | What |
|---|---|
| `/`, `/about`, `/registration`, `/verify`, `/legal/*` | Public site |
| `/portal` | Registrant sign-up, emailed-code sign-in, dashboard and registration information |
| `/verify` | Public lookup by registration number (rate-limited) |
| `/support` | Contact form (creates a support request) |
| `/webhooks/stripe`, `/webhooks/postmark` | Signed / token-checked webhooks |
| `/admin` | Administrator area: registrants, reports, duplicates, support, training, payments, emails, announcements, lookups, lists, Stripe, legal documents, launch checklist, audit log |
| `/health` | Render health check, returns `{"status":"ok"}` |

`PRE_LAUNCH` (default on) shows a "Preview" strip, keeps search engines out, and lets only `PREVIEW_EMAILS`
(default: `ADMIN_EMAILS`) sign up or sign in. Until the database, email and secret settings are present, the portal
shows "temporarily unavailable" and the public site keeps working. See `.env.example`.

## Database

Migrations in `supabase/migrations/`. Tables are prefixed `br_` (shared Aquamark project), have RLS on with no
policies, and are reached only through the service role. DOB is AES-256-GCM encrypted with an HMAC match key.

## Tests

`npm test` runs the portal end to end against an in-memory stand-in for Supabase (`test/fake-supabase.js`).

## Local development

```bash
npm install
cp .env.example .env
npm run dev
```

## Plan

See [`docs/phase1-plan.md`](docs/phase1-plan.md).

## Daily job

Runs inside the web service, once per Pacific day after 6 AM: 30-day renewal reminders, expiry of registrations that
won't renew (with a Stripe re-check for overdue auto-renewals), payment-method reminders, housekeeping. Admin can run it
from Emails > Daily job. `DISABLE_DAILY_JOB=true` turns it off.

## Launch

See Admin > Launch. In short: publish final legal documents and training, remove preview data, set the live
`STRIPE_SECRET_KEY` and `PRE_LAUNCH=false` in Render, then run Admin > Stripe > Set Up Stripe again (live mode keeps
its own product, price and webhook), and turn off Stripe's own customer emails.
