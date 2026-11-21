# Broker Registry — Phase 1 Technical Plan

Status: **draft for review, rev. 2** (round-1 decisions applied: see §3). No application code has been written. This document answers the eight
pre-build items in section 14 of the project brief. Anything marked **Decision** needs an answer from
you before (or during) the step that depends on it; my recommendation is given for each, but none of them
is a business rule until you approve it.

---

## 1. Brief review — summary of what we are building

A single, independently operated web application at `broker-registry.org` (operator: Duncan Consulting LLC) where an
individual:

1. creates one account (email, mobile number),
2. enters personal, employment and product information and accepts the acknowledgments,
3. completes five admin-managed training modules,
4. passes a 40-question assessment (80%),
5. accepts the automatic-renewal terms and pays $99/year through Stripe,
6. receives a permanent number (`BR-…`) that anyone can check on a public lookup that shows only
   name, number, status (Active / Expired) and expiration date.

There is also an admin interface (registrants, training, assessment, payments, email, reporting, audit log)
and 19 transactional emails sent through Postmark.

Out of scope for Phase 1 (from the brief): background checks, screening, complaints/misconduct,
employer or association dashboards, public directories, name search, any FinDex / Secure Broker /
Secure Funder integration, any government-licensing language.

### Things I noticed while reviewing

- **Accounts.** Duncan Consulting LLC is the legal entity for every brand (Aquamark, Secure Broker, Secure Funder, FinDex
  and Broker Registry are all DBAs). The existing Stripe, Postmark, Supabase and Render accounts are reused. Broker
  Registry gets its own Stripe product and price, its own Postmark server and sending domain, and its own statement
  descriptor.
- **Shared Supabase project (decided, changes brief §11).** Broker Registry lives in the Aquamark Supabase project
  next to FinDex. Its tables are prefixed `csbfp_`, have RLS enabled with no policies, and are reached only through the
  service role, the same way `fx_` tables are. Isolation comes from the prefix and the server code, not from a
  separate database.
- **Admin sign-in (decided, changes brief §11 MFA line).** Admins sign in with emailed codes, as in FinDex, with no TOTP.
  Unlike FinDex's single shared password, each admin gets their own account, so the audit log records who did what.
- **Random numbers (decided).** `BR-` + 8 random digits, never sequential, never reused.
- **Pending registrations have no number.** Numbers are assigned at activation, so a pending registration
  can never show up in the public lookup. That meets the "not publicly discoverable" requirement by design.

---

## 2. Proposed application architecture

Same shape as FinDex Portal, which is already proven in production:

```
                    broker-registry.org  (Render web service, Node 20)
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ Express 4 + EJS server-rendered pages, helmet CSP, express-rate-limit    │
 │                                                                          │
 │  Public site      Registrant portal      Admin (/admin)    Webhooks      │
 │  /, /about,       /signup, /login,       code sign-in,     /webhooks/    │
 │  /registration,   /dashboard, /profile,  registrants,      stripe        │
 │  /verify, /legal  /training, /assessment training, emails, /webhooks/    │
 │                   /billing, /confirmation reports, audit   postmark      │
 │                                                                          │
 │  In-process daily job (expiry, renewal reminders, cleanup)               │
 └───────┬───────────────────────┬──────────────────────┬───────────────────┘
         │ service role only     │ REST API             │ REST API
         ▼                       ▼                      ▼
  Supabase (Aquamark      Stripe (Checkout,       Postmark (dedicated server,
  project, csbfp_ tables):   Billing, Customer       sending domain
  Storage for training    Portal, webhooks)       broker-registry.org)
  images; RLS on, no
  anon/authenticated access
```

**Key choices**

| Area | Choice | Why |
|---|---|---|
| Runtime | Node 20, Express 4, EJS, plain CSS/JS. No SPA, no build step. | Same as FinDex. Simple, fast on mobile, easy to restyle later. |
| Hosting | One Render web service (plus Render's free TLS and custom domain). | Cheapest, simplest. Can split admin later if needed. |
| Database | The shared Aquamark Supabase project, with tables prefixed `csbfp_`. RLS **enabled on every table with no policies**, and no grants to `anon`/`authenticated`. The server uses the service role. | The database itself refuses all client access. Per-user access is enforced in one place, the server, by always scoping queries to `req.registrant.id`. Same model as FinDex. |
| Registrant auth | Passwordless 6-digit email codes, signed httpOnly JWT cookie (FinDex pattern). Account status is re-checked on every request. | The code email also verifies the email address. No passwords to store or reset. |
| Admin auth | Individual admin accounts on an allowlist, signed in with emailed codes (FinDex flow). Separate cookie scoped to `/admin`, `SameSite=Strict`, 12-hour session. | Matches FinDex. Separate accounts give a per-person audit trail. |
| Phone | Mobile number collected and format-checked only. **No SMS of any kind** in Phase 1. | Decided. |
| Payments | Stripe Checkout (subscription mode, one $99/year Price), Stripe Customer Portal for payment-method updates and invoices, signed webhooks. | No card data touches our servers. No Stripe.js on our pages. |
| Email | Postmark REST API, templates stored in the database, every send recorded in `email_messages` with a unique dedupe key. | Brief requires no duplicate sends, editable templates and a delivery log. |
| Bot protection | Honeypot + rate limits (as FinDex), **plus Cloudflare Turnstile on sign-up, sign-in and verify from day one**. | Brief requires protection against automated sign-ups and scraping. |
| Content | Public-site copy in Markdown/EJS files in the repo (`content/`). Legal documents and training content in the database, versioned. | Copy changes are a one-file edit. Legal and training content need version records. |
| Jobs | In-process scheduler (checks every 15 min, records a row in `job_runs` so each daily job runs once), like FinDex. | No extra Render service. Can move to a Render Cron Job later without code changes. |

**Libraries (small set):** `@supabase/supabase-js`, `express`, `ejs`, `helmet`, `express-rate-limit`,
`cookie-parser`, `jsonwebtoken`, `stripe`, `marked` + `sanitize-html` (training/legal Markdown),
`libphonenumber-js` (phone validation).

**Rate limiting note:** `express-rate-limit` keeps counts in memory. That is fine for one Render instance. If we ever run more than one,
the counters move to Postgres. No change is needed for launch.

---

## 3. Decisions

### Decided (round 1)

| # | Decision | Outcome |
|---|---|---|
| D1 | Legal entity / accounts | Everything is under Duncan Consulting LLC, and all brands are DBAs. Existing accounts are reused. Broker Registry gets its own Stripe product, Postmark server/sending domain and statement descriptor. |
| D2 | Registrant auth | Emailed sign-in codes, as in FinDex. |
| D3 | SMS | **None.** The mobile number is collected and format-checked only. |
| D6 | Registration number | `BR-` + 8 random digits, never reused. |
| D7 | Lookup for a registration on admin hold | Same "No registration was found for that number" response as not-found. |
| D8 | Possible duplicates | Checkout is blocked. The registrant sees "Please contact us to finish your registration", and an admin clears or merges the flag. |
| D10 | Rejoining after expiry | Allowed. The same number is reactivated by paying again. No new training or assessment. |
| D12 | Refunds | No refunds (payment is the last step). No refund feature in admin. A refund (e.g. to settle a card dispute) is done by hand in the Stripe dashboard; the `charge.refunded` webhook records it but does **not** change registration status automatically. |
| D13 | Sales tax | Not collected (registration fee). Stripe Tax off. |
| D4 | Eligibility | 18+ and U.S.-based. |
| D5 | Name on lookup | First + last name only, laid out like the approved mock-up: number, Full Name, Registration Status (✓ Active), Valid Through date. |
| D22 | Hosting | **Everything on one Render service at `broker-registry.org`** (no GitHub Pages, no subdomain). Public pages at `/`, `/about`, `/registration`, `/verify`, `/legal/*`; registrant portal under `/portal`; admin under `/admin`. |
| D15 | Admin roles and auth | Individual admin accounts on an allowlist, emailed-code sign-in, no MFA, one role. |
| D19 | Supabase | Shared Aquamark project, `csbfp_` table prefix. |
| D20 | Retention / deletion | Data is kept in Supabase while the account exists. The registrant can request full deletion from the portal at any time (see §5, "Deletion requests"). |

| D11 | Assessment retakes | 10 attempts, then the registrant contacts support and an admin resets the counter (logged). 1 hour between attempts. Both are admin settings. |
| D20a | What deletion keeps | Admin processes deletion requests. All personal data is deleted. A nameless record is kept: the retired number (never reissued), Stripe ids, amounts and dates, and the auto-renewal consent record (version + timestamp). |
| D9 | Failed renewal | **No grace period.** If the renewal charge fails, the registration becomes **Inactive** right away (the lookup shows Inactive) and the registrant is emailed. They sign in and pay to reactivate. Stripe also retries the card automatically; any successful payment reactivates. If they never pay, it stays Inactive. **Expired** is kept for registrations that reach their end date without renewal (e.g. auto-renewal canceled). |
| D18 | From / reply-to | `Broker Registry <no-reply@broker-registry.org>` from a new Postmark server in the existing account. Reply-to `support@broker-registry.org`, forwarded by Namecheap to `info@aquamark.io`. |
| D23 | Admin users | `christina@aquamark.io` (the `ADMIN_EMAILS` env var). More can be added later. |
| D24 | Statement descriptor | `BROKER REGISTRY` |

### Recommended, proceeding unless you say otherwise

| # | Decision | Recommendation |
|---|---|---|
| D14 | Name change after activation | Applies after admin approval (it changes public output). |
| D16 | Emails 8 + 9 | Sent as one "Your registration is active" email with the number. |
| D17 | Annual info review | Dashboard banner + a line in the 30-day renewal reminder. No extra email. |
| D21 | Training video | YouTube (privacy-enhanced) or Vimeo embed by URL. |

---

## 4. Database schema and relationships

Tables live in `public` in the shared Aquamark project. Every table is prefixed `csbfp_` (names below omit the prefix for readability). Every table has RLS enabled with no policies. Timestamps are
`timestamptz`. `updated_at` is set by trigger. No SSNs are stored anywhere. DOB is encrypted with AES-256-GCM
plus an HMAC "blind index" for duplicate matching (FinDex `lib/crypto.js` pattern).

### Entity overview

```
registrants 1──1 registrations 1──* registration_status_history
     │                 │
     │                 └──* subscriptions 1──* payments
     ├──* employment_relationships *──1 job_titles
     ├──* registrant_products *──1 financing_products
     ├──* registrant_states
     ├──* legal_acceptances *──1 legal_documents (key, version)
     ├──* training_progress *──1 modules *──1 curriculum_versions
     ├──* assessment_attempts ─────────────────┘
     ├──* email_messages
     ├──* support_requests
     ├──* duplicate_flags
     ├──* login_codes
     └──* events (registrant activity)

admin_users 1──* admin_audit_log
questions 1──* question_options        (bank, linked to curriculum_versions)
email_templates, settings, stripe_events, postmark_events, verify_lookups, job_runs
```

### Tables

**Identity & profile**

- `registrants`: one row per person/account.
  `id uuid pk`, `email citext unique` (lowercase), `email_verified_at`, `phone_e164` (no SMS verification),
  `legal_first_name`, `middle_name null`, `legal_last_name`, `dob_enc`, `dob_hash`, `zip5`,
  `industry_start_month date` (first of month), `employment_status` (`working` | `not_currently_employed`),
  `products_other text null`, `profile_completed_at`, `info_confirmed_at` (annual review),
  `account_status` (`active` | `locked` | `deletion_requested` | `deleted`), `pending_name_change jsonb null` (D14), `is_test bool`,
  `last_login_at`, timestamps.
- `login_codes`: `registrant_id`, `code_hash` (HMAC), `expires_at`, `attempts`, `used_at`, `ip`. Same rules as FinDex.
- `job_titles`: admin-configurable list (`label`, `position`, `active`). Seeded with the brief's 11 titles.
- `employment_relationships`: one row per employer or contracting relationship (supports several current ones).
  `registrant_id`, `relationship_type` (`employee` | `contractor_1099` | `self_employed`), `company_name`,
  `company_website null`, `city`, `state`, `start_month date`, `work_arrangement` (`remote` | `hybrid` | `on_site`),
  `job_title_id`, `job_title_other null`, `is_current bool`, `end_month null`, timestamps.
  "Not currently employed" is `registrants.employment_status`, not a row.
- `financing_products`: admin-configurable (seeded with the brief's 6). `registrant_products(registrant_id, product_id)`.
- `registrant_states(registrant_id, state char(2))`: states where the person solicits or brokers.

**Registration lifecycle**

- `registrations`: one per registrant (`registrant_id unique`).
  `registration_number text unique null` (assigned at first activation, never changed, never reused),
  `status` (`pending` | `active` | `inactive` | `expired`), `admin_hold bool`, `admin_hold_reason`,
  `first_activated_at` (shown as "Registration date"), `current_period_start`, `expires_at`,
  timestamps.
- `registration_status_history`: `registration_id`, `from_status`, `to_status`, `hold_change null`, `reason`
  (required), `actor_type` (`system` | `registrant` | `admin` | `stripe`), `actor_id null`, `source_ref`
  (e.g. Stripe event id), `created_at`. All status changes go through a single database function
  `set_registration_status(...)` that writes the row and the history in one transaction.

**Billing**

- `subscriptions`: `registrant_id`, `stripe_customer_id`, `stripe_subscription_id unique`, `stripe_status`,
  `cancel_at_period_end`, `current_period_start/end`, `canceled_at`, timestamps. Several rows are possible over time
  (re-subscribing after expiry).
- `payments`: `registrant_id`, `subscription_id`, `stripe_invoice_id unique`, `stripe_payment_intent_id`,
  `amount_cents`, `currency`, `billing_reason` (`initial` | `renewal`), `status` (`paid` | `failed` | `refunded` |
  `partially_refunded`; refunds only by hand in Stripe), `period_start/end`, `hosted_invoice_url`, `paid_at`, `failure_message`, `refunded_cents`.
- `stripe_events`: `id` (Stripe `evt_…` pk), `type`, `received_at`, `processed_at`, `error`.
  This makes every webhook idempotent.

**Legal**

- `legal_documents`: `key` (`terms`, `privacy`, `registration_agreement`, `auto_renewal_terms`, `disclaimer`,
  `acknowledgments`), `version`, `title`, `body_md`, `effective_at`, `status` (`draft` | `published`). Unique `(key, version)`.
- `legal_acceptances`: `registrant_id`, `document_key`, `document_version`, `context` (`signup` | `acknowledgments` |
  `checkout` | `renewal_terms_update`), `ref` (e.g. Checkout Session id), `accepted_at`, `ip`, `user_agent`.
  Insert-only. This is the stored evidence of auto-renewal consent the brief requires.

**Training & assessment**

- `curriculum_versions`: `label` (e.g. "2027.1"), `status` (`draft` | `published` | `retired`), `published_at`,
  `is_required` (the version new and renewing registrants must complete). Editing published training creates a new
  draft version by copying it, so a completion always refers to the exact content the person saw.
- `modules`: `curriculum_version_id`, `stable_key` (identifies "Module 2" across versions), `position`, `title`,
  `body_md`, `video_url null`, `estimated_minutes`.
- `training_progress`: `registrant_id`, `module_id`, `started_at`, `completed_at`. Unique per pair.
- `assessment_settings` (per curriculum version): `question_count` (40), `pass_percent` (80),
  `cooldown_minutes` (60), `max_attempts_total` (10, then admin reset, D11).
- `assessment_resets`: `registrant_id`, `admin_id`, `reason`, `created_at` (an attempt counter reset).
- `questions`: `curriculum_version_id`, `module_stable_key null`, `prompt`, `explanation`, `active`.
  `question_options`: `question_id`, `text`, `is_correct`, `position`.
- `assessment_attempts`: `registrant_id`, `curriculum_version_id`, `started_at`, `submitted_at`,
  `questions_snapshot jsonb` (the exact questions and options served, in served order), `answers jsonb`,
  `correct_count`, `question_count`, `score_percent`, `pass_percent_applied`, `passed`. Scores are never public.

**Email**

- `email_templates`: `key` (19 keys, §6), `subject`, `body_md` with `{{placeholders}}`, `version`, `updated_by`.
  The layout (header and footer disclaimer) stays in code, and only the body is editable.
- `email_messages`: `registrant_id null`, `template_key`, `template_version`, `dedupe_key unique`, `to_email`,
  `status` (`queued` | `sent` | `delivered` | `bounced` | `failed`), `postmark_message_id`, `error`, `attempts`,
  `sent_at`. Inserting the row *before* sending, with a unique `dedupe_key`
  (e.g. `renewal_reminder:<subscription>:<period_end>`), is what prevents duplicate sends.
- `postmark_events`: raw delivery, bounce and spam-complaint webhooks, linked by message id.

**Admin, audit, operations**

- `admin_users`: `email`, `name`, `active`,
  `last_login_at`. `admin_login_codes` is the same shape as `login_codes`.
- `admin_audit_log`: `admin_id`, `action`, `target_type`, `target_id`, `reason`, `detail jsonb` (field *names*
  changed, never DOB values), `ip`, `created_at`. Insert-only.
- `events`: registrant activity log (sign-ins, profile changes, training completions), like `fx_events`.
- `duplicate_flags`: `registrant_id`, `matched_registrant_id`, `match_reason` (`dob+last_name+zip`,
  `phone`, `dob+first+last`), `status` (`open` | `dismissed` | `merged`), `reviewed_by`, `reviewed_at`, `note`.
- `support_requests`: `registrant_id null`, `contact_email`, `category` (`account_recovery` | `data_correction` |
  `data_deletion` | `billing` | `duplicate_review` | `assessment_reset` | `other`), `message`, `status`, `admin_note`, timestamps.
- `verify_lookups`: `created_at`, `ip_hash` (HMAC, rotated key), `found bool`. No query text, 90-day retention.
  Used only to spot scraping.
- `settings`: key/value (`reminder_days`, `retake_*` defaults…).
- `job_runs`: `job`, `run_date`, `started_at`, `finished_at`, `result`. Unique `(job, run_date)`.

**Reporting** is a set of read-only SQL views (counts by status, new registrations by month, renewal rate,
training completion rate, payment status). They are used only by `/admin/reports` and contain no personal data.

---

## 5. Registration and billing lifecycle

### Registrant journey (status `pending` throughout until payment)

```
Sign up (email, phone, Turnstile) ─► code email ─► email verified, account created
   ─► Personal info ─► Employment & products ─► Acknowledgments (6 checkboxes, versioned)
   ─► Training modules 1→5 (sequential, resumable, can revisit)
   ─► Assessment (40 random Q, 80%) ── fail ─► email 7, cooldown, retry
          │ pass
          ▼
   Duplicate flag or admin hold open? ── yes ─► "Under review" (D8)
          │ no
          ▼
   Checkout page: fee, renewal date, auto-renewal terms shown in full,
   unticked "I agree to automatic annual renewal…" checkbox  ─► legal_acceptances row
          ▼
   Stripe Checkout (subscription, $99/yr) ─► webhook checkout.session.completed / invoice.paid
          ▼
   ACTIVE: number assigned (if first time), first_activated_at, expires_at = Stripe period end,
   history row, email 8/9 (D16)
```

### Webhook-driven states (Stripe is the source of truth for money; we are the source of truth for status)

| Stripe event | Effect |
|---|---|
| `checkout.session.completed` (paid) | Upsert subscription and payment, activate registration (only if requirements are still met). |
| `invoice.paid` (`subscription_cycle`) | Record payment, set `expires_at` = new period end, Active (reactivating if it had lapsed), email 12. |
| `invoice.payment_failed` (renewal) | Record failed payment, set the registration **Inactive** with reason "renewal payment failed", email 13 (sign in → update card → pay). Stripe's automatic retries carry on; a later `invoice.paid` reactivates. Email 14 is sent 3 days later if still unpaid. |
| `customer.subscription.updated` | Sync `cancel_at_period_end`/period. Turning it on sends email 15. Turning it off is recorded quietly. |
| `customer.subscription.deleted` | Mark subscription ended. Registration stays Active until `expires_at`, then the daily job expires it. They can rejoin through Checkout. |
| `charge.refunded` | Record the refund (done by hand in Stripe). No automatic status change; an admin decides (D12). |

Every handler: verify the signature → insert into `stripe_events` (stop if already processed) → apply changes in
one transaction → queue emails by dedupe key. Stripe retries anything we return 5xx for.

### Daily job (once a day, early morning Pacific)

1. **Expire:** `status = active` and `now() > expires_at` (e.g. auto-renewal was canceled) → Expired, email 16.
2. **Renewal reminder:** active, auto-renew on, `expires_at` 30 days out → email 11 (dedupe per period). This is our own
   reminder, not Stripe's, so the content and timing are under our control. Stripe's own customer emails
   are turned off to avoid duplicates.
3. **Payment-method reminder:** renewal invoice still unpaid 3 days after it failed → email 14.
4. **Housekeeping:** purge expired codes and old `verify_lookups`.

The public lookup also checks `expires_at` itself, so a job delay can never show a lapsed
registration as Active.

**Cancellation:** a "Cancel automatic renewal" button on `/billing`, with a confirm page, sets Stripe
`cancel_at_period_end`. The registration stays Active to `expires_at` and can be turned back on until then.
Payment-method updates and invoice downloads use the Stripe Customer Portal (limited to those features).

**Rejoining after expiry (D10):** an Expired registrant signs in, checks their information is still current, accepts the
current auto-renewal terms and goes through Checkout again. A new subscription starts, the **same** number becomes
Active, and `expires_at` is set to the new period end. No retraining. The duplicate/hold check still applies.

**Deletion requests (D20):** *Account → Privacy → Delete my data* shows what will be deleted and that the registration
will stop being verifiable. Confirming does the following:
1. Turns off auto-renewal right away (`cancel_at_period_end`) and sets `account_status = deletion_requested`.
2. Sends email 17 and puts the request in the admin support queue.
3. An admin processes it (the target is within 30 days; legal sets the final timeframe): Stripe subscription canceled,
   all personal rows deleted (profile, DOB, employment, products, states, training progress, attempts, emails log,
   events, support messages). What remains is the minimal nameless record in D20a. The number is marked **retired**:
   the lookup returns "not found" and the number is never reissued.

Deletion goes through admin rather than happening instantly so that an accidental click, an active payment or a
duplicate-review case can be dealt with first. If you'd rather it be immediate, that's a small change.

**Future refresher training:** publishing a new curriculum version with `is_required` lets admins require it
before the next renewal. Phase 1 builds the data model and the dashboard check but does **not** turn on any refresher rule.

---

## 6. Pages, endpoints and email automations

### Public (no sign-in)

All on `broker-registry.org`. Portal routes in the next table sit under `/portal` (e.g. `/portal/login`, `/portal/dashboard`).

| Route | Purpose |
|---|---|
| `GET /` | Headline, subtitle, supporting text, Register / Verify buttons, "How registration works" (6 steps), disclaimer |
| `GET /about` | Program, independence, operator, governance statement (§12 of the brief) |
| `GET /registration` | Registration information (who can register, required info, training, fee, auto-renewal, keeping information current, verification, "does not replace licenses") |
| `GET /verify`, `POST /verify` | Number lookup. Turnstile, rate limit (proposed 10 per 10 min and 50 per day per IP), the same response shape for not-found / pending / hold. Shows number, Full Name (first + last), Registration Status, and Valid Through (labelled "Expired On" when expired), per the mock-up. `noindex`, no caching, no JSON API. |
| `GET /legal/:key` | Terms, Privacy, Registration Agreement, Auto-Renewal Terms, Disclaimer (current published version, with earlier versions listed) |
| `GET /support`, `POST /support` | Contact / account recovery / data request form (Turnstile) |
| `GET /health` | Render health check |

The footer on every page carries the disclaimer: *privately operated, not a government agency or licensing authority,
does not replace legally required licenses or registrations; operated by Duncan Consulting LLC.*

### Registrant portal

| Route | Purpose |
|---|---|
| `GET/POST /signup` | Email + mobile + Terms/Privacy acceptance → code |
| `GET/POST /login`, `/login/verify`, `POST /login/resend`, `POST /logout` | Email-code sign-in (FinDex flow) |
| `GET /dashboard` | Status, number, dates, training/assessment status, info-review banner, next step |
| `GET/POST /profile/personal` | Personal information (name change → review, D14) |
| `GET/POST /profile/employment`, `POST /profile/employment/:id/end` | Relationships CRUD, employment status |
| `GET/POST /profile/products` | Products, other products, states |
| `GET/POST /acknowledgments` | Six acknowledgments (versioned) |
| `GET /training`, `GET /training/:moduleKey`, `POST /training/:moduleKey/complete` | Sequential modules |
| `GET /assessment`, `POST /assessment/start`, `POST /assessment/submit`, `GET /assessment/result/:id` | Assessment |
| `GET /checkout`, `POST /checkout` | Consent page → create Stripe Checkout Session |
| `GET /checkout/return` | "Payment received, activating…" (polls status, as activation comes from the webhook) |
| `GET /billing`, `POST /billing/portal`, `POST /billing/cancel`, `POST /billing/resume` | Fee, renewal date, payment history, Stripe portal, cancel/resume auto-renewal |
| `GET/POST /account/email` (+ verify new address) | Change email: a code goes to the new address, and the old address is notified (email 4) |
| `GET /account/security`, `GET/POST /account/privacy` | Sign out everywhere. Correction requests, and **Delete my data** (confirmation page → deletion request, §5) |
| `GET /confirmation` | Printable registration confirmation (print CSS, browser "Save as PDF"). Labeled "Registration Confirmation — not a license or certification" |

### Admin (`/admin`, emailed-code sign-in)

`/admin/login`, `/admin/registrants` (search by name, email or number), `/admin/registrants/:id`
(details with DOB masked, edit with a reason, hold/unhold, status override with a reason, history, payments, emails,
acceptances, attempts), `/admin/duplicates`, `/admin/support`, `/admin/training` (versions, modules, reorder,
publish), `/admin/questions`, `/admin/assessment-settings`, `/admin/payments` (subscriptions, failed payments,
upcoming renewals, links to Stripe dashboard), `/admin/emails` (templates with preview and test-send, delivery log,
failures, resend), `/admin/legal` (document versions), `/admin/lists` (job titles, products), `/admin/reports`,
`/admin/audit`, `/admin/users` (admin role only).

### Webhooks

`POST /webhooks/stripe` (raw body, signature verification), `POST /webhooks/postmark` (token, delivery/bounce/spam).

### Email automations

| # | Template key | Trigger |
|---|---|---|
| 1 | `email_verification` | Sign-up (code) and new-email verification |
| 2 | `welcome` | First successful verification |
| 3 | `sign_in_code` | `/login` |
| 4 | `email_changed` | Email change completed (sent to the **old** address) |
| 5 | `training_completed` | Last required module completed |
| 6 | `assessment_passed` | Passing attempt |
| 7 | `assessment_failed` | Failing attempt (with when they can retry) |
| 8 | `registration_activated` | First activation (see D16) |
| 9 | `registration_confirmation` | First activation (number; see D16) |
| 10 | `registration_info_updated` | Profile/employment/products saved (at most one per day) |
| 11 | `renewal_reminder` | Daily job, 30 days before `expires_at` (date, $99, automatic charge, update-card and cancel links) |
| 12 | `renewal_succeeded` | `invoice.paid` renewal (receipt link) |
| 13 | `renewal_failed` | `invoice.payment_failed` |
| 14 | `payment_method_reminder` | Daily job, 3 days after a failed renewal if still unpaid |
| 15 | `auto_renewal_canceled` | Cancel turned on |
| 16 | `registration_expired` | Daily job expiry |
| 17 | `support_request_received` | `/support` submission |
| 18 | `identity_review_required` | Admin action on recovery/duplicate review |
| 19 | `program_update` | Admin-initiated, for material program or training changes (one template per send, dedupe per registrant) |

All emails are plain, administrative and untracked (no open or click tracking, like FinDex). DOB is never included.

---

## 7. Security, privacy and legal review checkpoints

### Built-in controls

- RLS on every table with no policies, and no `anon`/`authenticated` grants. The service-role key exists only on Render.
  Every portal query is scoped to the signed-in registrant id (one helper, no exceptions).
- The public lookup is one server route that selects an **allowlist** of four fields from a view. Internal ids are never
  returned. The same response is given for pending, hold and not-found.
- Number format (D6), Turnstile and per-IP limits on lookup, sign-up and sign-in, lookup logging for abuse review.
- No SSN fields anywhere. DOB is encrypted at rest with a blind index. No full addresses. No card data.
- Server-side validation on every form. CSRF: `SameSite` cookies, POST-only state changes and an origin check.
  Helmet CSP (`script-src 'self'`, Turnstile and video embed allowlist only).
- Admin: individual allowlisted accounts, emailed codes, 12-hour sessions, lockout, insert-only audit log. (No MFA by decision; admin security then depends on the admins' email accounts, so those mailboxes should have MFA turned on.)
- Webhooks: Stripe signature verification, idempotency through `stripe_events`. Postmark token check.
- Secrets only in Render env vars. Encryption and HMAC keys are backed up offline (lost keys mean unreadable DOBs).
- Logs never include request bodies (FinDex rule).
- Backups: Supabase Pro daily backups, plus a documented restore drill before launch.

### Review checkpoints (things that need a human sign-off)

| When | Checkpoint | Who |
|---|---|---|
| Before Step 1 copy is final | All public copy: no implication of licensing, legal requirement, government status, or SBFA / Main Street Capital Partnership control | Legal |
| Before launch | Terms, Privacy Policy, Registration Agreement, Auto-Renewal Terms, Disclaimer, Acknowledgments text | Legal |
| Before launch | Auto-renewal compliance (checkout disclosure, affirmative consent, reminder timing, easy online cancel), checked against the strictest applicable state ARL (e.g. California) | Legal |
| Before launch | Immediate expiry on failed renewal (D9), no-refund statement in the auto-renewal terms (D12), deletion and what is kept (D20a), sales tax (D13) | Legal / accounting |
| Before publishing training | All five modules and the question bank: content review (the brief says no legal content is published as authoritative without review) | Subject-matter + legal |
| Step 7 | Lookup output and anti-enumeration settings | You |
| Before launch | Security review: RLS check (Supabase advisors), dependency audit, admin sign-in and allowlist test, webhook replay test, rate-limit test | Engineering |
| Before launch | Stripe live-mode setup under the right entity, statement descriptor `BROKER REGISTRY`, Customer Portal limited to payment method + invoices | You |

---

## 8. Recommended implementation sequence

Each step ends in something deployable and testable on Render (staging), using Stripe **test mode** until step 11.

0. **Setup.** `csbfp_` migrations in the Aquamark Supabase project, Render service and custom domain, Postmark server and sending domain
   (DKIM, Return-Path), Stripe account and test-mode Price, Cloudflare Turnstile keys, `.env.example`, health check.
1. **Skeleton + public site.** Express app, layout, CSS (white, understated, mobile first), home, about, registration
   info, legal placeholder pages, disclaimer footer. Public copy lives in `content/`. Initial migration with all tables.
2. **Accounts.** Sign-up, email codes, sessions, personal/employment/products forms, acknowledgments, duplicate
   detection → `duplicate_flags`, dashboard shell.
3. **Admin foundation.** Admin users (allowlist, code sign-in), registrant list/detail/search, edits with reasons, holds, audit log,
   duplicates and support queues, configurable lists.
4. **Training.** Curriculum versions, module editor (Markdown, images, video URL), publish/reorder, registrant
   module flow and progress. Seed with clearly marked **placeholder** text only.
5. **Assessment.** Question bank admin, settings, randomized attempts with snapshots, scoring, retake rules.
6. **Payments & activation.** Consent page, Checkout, webhooks, number assignment, activation, billing page,
   cancel/resume, Customer Portal, reactivation after expiry. Test every path with **Stripe test clocks**
   (renewal, failed renewal → Expired → pay → Active, cancel → expiry, rejoin after expiry).
7. **Public verify.** Lookup, Turnstile, limits, lookup log, admin abuse view.
8. **Email system.** Templates table, editor/preview/test-send, dedupe, delivery log, Postmark webhooks, all 19
   triggers wired.
9. **Daily job.** Expiry, reminders, info-review prompt, housekeeping.
10. **Reporting & confirmation.** Admin reports views, printable confirmation.
11. **Hardening & launch.** Automated tests for the lifecycle logic (status transitions, webhook idempotency, lookup
    allowlist), security checklist (§7), backup restore drill, final copy/legal/training sign-off, switch Stripe to
    live, DNS cutover.

Steps 4–5 and 6–7 can overlap. Training and legal content can arrive at any time, because they are admin-edited
data and not code.
