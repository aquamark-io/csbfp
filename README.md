# CSBFP: Certified Small Business Finance Professional

Certification program for individuals working in U.S. small business finance.
Technology and administration: Duncan Consulting LLC. Working domain: <https://csbfp-certification.org> (later csbfp.org).

Node 20+, Express 4, EJS. One Render web service serves everything:

| Path | What |
|---|---|
| `/` | Logo, verify a certification, get certified |
| `/faq`, `/legal/*`, `/support` | FAQ, Program Terms, Privacy Policy, contact (linked from the footer) |
| `/verify` | Public lookup by exact certification number (rate-limited; no name search or directory) |
| `/portal` | Applicant / certificant sign-up, emailed-code sign-in, application, training, assessment, payment, certificate |
| `/webhooks/stripe`, `/webhooks/postmark` | Signed / token-checked webhooks |
| `/admin` | People, review queue (screening, approval, suspension, revocation, appeals), reports, training, payments, emails, legal, audit log |
| `/health` | Render health check |

## Certification lifecycle

`lib/certification.js` and `lib/screening.js`. Status changes go through one database function that enforces the
allowed transitions and writes history (reason, actor, evidence reference, effective date).

Create account → application → professional standards → training → assessment → payment →
background screening (when enabled) → eligibility approval → certification issued.

- **Screening is not integrated.** `BACKGROUND_SCREENING_ENABLED=false` (default): payment issues a **DEMO** credential
  (`DEMO-########`) that the dashboard, certificate and public lookup label "not screened, not valid".
- With screening enabled, payment moves the application to Pending Screening; a reviewer records the screening outcome
  and then approves or does not approve. Approval assigns the permanent `CSBFP-########` number and starts the first
  annual term (the Stripe renewal date is moved to one year after approval). No decision is automatic.
- Admins can suspend, reinstate and revoke (reason and evidence reference required; revocation stops renewal).
  Public lookup shows only status, never reasons.
- **Phase 1 background checks (Checkr open invitation links):** after paying, the applicant opens `/portal/background-check`,
  which picks their state from their home ZIP code (`lib/zip-state.js`) and shows the exact legal name and email to use.
  The button goes through `/portal/background-check/go`, which records the state and time, then redirects to that state's
  Checkr link. Links (50 states + DC) are set in Admin > Background Checks and never shown publicly. Checkr emails when
  a report is complete; a reviewer finds the applicant in Admin > Review and records the result. Checkr runs adverse
  action. A reminder goes out 3 days after payment if the link was never opened.
- Phase 2: Checkr API invitations per applicant and signed webhooks (adapter interface in `lib/screening.js`).

## Database

Migrations in `supabase/migrations/`. Tables are prefixed `csbfp_` (shared Aquamark project), have RLS on with no
policies, and are reached only through the service role. DOB is AES-256-GCM encrypted with an HMAC match key.
Training modules, assessment questions and legal documents live in the database, not in this repo.

## Tests

`npm test` runs the app end to end against an in-memory stand-in for Supabase and Stripe.

## Daily job

Runs inside the web service once per Pacific day after 6 AM: 30-day renewal reminders, expiry, payment-method reminders,
admin daily summary, housekeeping. `DISABLE_DAILY_JOB=true` turns it off.

## Open decisions (not built; do not assume)

Screening provider contract and integration, disqualifying-offense definitions and review rules, notice / appeal
procedures, final legal terms, SBFA–operator agreement and revenue share, launch timing and approval to enable screening.
