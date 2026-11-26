-- CSBFP: initial schema.
--
-- Lives in the shared Aquamark project. Every object is prefixed csbfp_.
-- Access model (same as FinDex): RLS on, no policies, no grants to anon/authenticated.
-- The CSBFP server (service role) is the only access path.
--
-- Never store: Social Security numbers, full home addresses, card details.
-- DOB is stored encrypted (dob_enc, AES-256-GCM in the app) with an HMAC match key (dob_hash).

-- ---------------------------------------------------------------------------
-- Shared trigger: updated_at
-- ---------------------------------------------------------------------------
create or replace function public.csbfp_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ===========================================================================
-- PEOPLE
-- ===========================================================================

-- One row per person / account. Personal fields fill in as the registrant completes their profile.
-- On a deletion request, an admin scrubs the personal fields and sets account_status = 'deleted';
-- the row stays as the anchor for the nameless record (payments, consent, retired number).
create table public.csbfp_registrants (
  id                    uuid primary key default gen_random_uuid(),
  email                 text check (email = lower(email)),
  email_verified_at     timestamptz,
  phone_e164            text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),

  legal_first_name      text,
  middle_name           text,
  legal_last_name       text,
  dob_enc               text,
  dob_hash              text,
  zip5                  text check (zip5 ~ '^[0-9]{5}$'),
  industry_start_month  date check (extract(day from industry_start_month) = 1),
  employment_status     text check (employment_status in ('working', 'not_currently_employed')),
  products_other        text,

  profile_completed_at  timestamptz,
  info_confirmed_at     timestamptz,            -- last annual "my information is current"
  pending_name_change   jsonb,                  -- name change awaiting admin approval

  account_status        text not null default 'active'
                        check (account_status in ('active', 'locked', 'deletion_requested', 'deleted')),
  is_test               boolean not null default false,
  last_login_at         timestamptz,
  deletion_requested_at timestamptz,
  deleted_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint csbfp_registrants_email_required check (account_status = 'deleted' or email is not null)
);

create unique index csbfp_registrants_email_uq on public.csbfp_registrants (email) where email is not null;
create index csbfp_registrants_dob_hash_idx on public.csbfp_registrants (dob_hash) where dob_hash is not null;
create index csbfp_registrants_phone_idx on public.csbfp_registrants (phone_e164) where phone_e164 is not null;
create index csbfp_registrants_last_name_idx on public.csbfp_registrants (lower(legal_last_name));

create trigger csbfp_registrants_touch before update on public.csbfp_registrants
  for each row execute function public.csbfp_touch_updated_at();

-- One-time email codes (sign-in, email verification, email change). Stored as HMAC, never plaintext.
create table public.csbfp_login_codes (
  id             uuid primary key default gen_random_uuid(),
  registrant_id  uuid not null references public.csbfp_registrants (id) on delete cascade,
  purpose        text not null default 'sign_in' check (purpose in ('sign_in', 'verify_email', 'change_email')),
  new_email      text check (new_email = lower(new_email)),   -- only for change_email
  code_hash      text not null,
  expires_at     timestamptz not null,
  attempts       int not null default 0,
  used_at        timestamptz,
  ip             text,
  created_at     timestamptz not null default now()
);

create index csbfp_login_codes_registrant_created_idx on public.csbfp_login_codes (registrant_id, created_at desc);
create index csbfp_login_codes_expires_idx on public.csbfp_login_codes (expires_at);

-- Admin-configurable lists.
create table public.csbfp_job_titles (
  id         int generated always as identity primary key,
  label      text not null unique,
  position   int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.csbfp_financing_products (
  id         int generated always as identity primary key,
  label      text not null unique,
  position   int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Employers / contracting relationships. Several can be current at once.
create table public.csbfp_employment_relationships (
  id                 uuid primary key default gen_random_uuid(),
  registrant_id      uuid not null references public.csbfp_registrants (id) on delete cascade,
  relationship_type  text not null check (relationship_type in ('employee', 'contractor_1099', 'self_employed')),
  company_name       text not null,
  company_website    text,
  city               text not null,
  state              text not null check (state ~ '^[A-Z]{2}$'),
  start_month        date not null check (extract(day from start_month) = 1),
  work_arrangement   text not null check (work_arrangement in ('remote', 'hybrid', 'on_site')),
  job_title_id       int references public.csbfp_job_titles (id),
  job_title_other    text,
  is_current         boolean not null default true,
  end_month          date check (extract(day from end_month) = 1),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint csbfp_employment_title check (job_title_id is not null or job_title_other is not null),
  constraint csbfp_employment_end check (is_current or end_month is not null)
);

create index csbfp_employment_registrant_idx on public.csbfp_employment_relationships (registrant_id);

create trigger csbfp_employment_touch before update on public.csbfp_employment_relationships
  for each row execute function public.csbfp_touch_updated_at();

create table public.csbfp_registrant_products (
  registrant_id  uuid not null references public.csbfp_registrants (id) on delete cascade,
  product_id     int not null references public.csbfp_financing_products (id),
  primary key (registrant_id, product_id)
);

-- States where the individual solicits or brokers financing.
create table public.csbfp_registrant_states (
  registrant_id  uuid not null references public.csbfp_registrants (id) on delete cascade,
  state          text not null check (state ~ '^[A-Z]{2}$'),
  primary key (registrant_id, state)
);

-- ===========================================================================
-- REGISTRATION
-- ===========================================================================

-- One per registrant. The number is assigned at first activation and never changes or gets reused.
-- Public statuses: active, inactive (renewal payment failed), expired. Pending is never public.
create table public.csbfp_registrations (
  id                    uuid primary key default gen_random_uuid(),
  registrant_id         uuid not null unique references public.csbfp_registrants (id),
  registration_number   text unique check (registration_number ~ '^[A-Z]{2,10}-[0-9]{8}$'),
  status                text not null default 'pending'
                        check (status in ('pending', 'active', 'inactive', 'expired')),
  admin_hold            boolean not null default false,   -- internal only; lookup shows "not found"
  admin_hold_reason     text,
  retired_at            timestamptz,                       -- set on data deletion; lookup shows "not found"
  first_activated_at    timestamptz,                       -- shown as "Registration date"
  current_period_start  timestamptz,
  expires_at            timestamptz,                       -- shown as "Valid Through"
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint csbfp_registrations_hold_reason check (not admin_hold or admin_hold_reason is not null),
  constraint csbfp_registrations_number_when_live check (status = 'pending' or registration_number is not null)
);

create index csbfp_registrations_status_expires_idx on public.csbfp_registrations (status, expires_at);

create trigger csbfp_registrations_touch before update on public.csbfp_registrations
  for each row execute function public.csbfp_touch_updated_at();

-- A registration number, once set, can never change.
create or replace function public.csbfp_registrations_number_locked() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.registration_number is not null and new.registration_number is distinct from old.registration_number then
    raise exception 'Registration numbers cannot be changed (registration %)', old.id;
  end if;
  return new;
end $$;

create trigger csbfp_registrations_number_locked before update on public.csbfp_registrations
  for each row execute function public.csbfp_registrations_number_locked();

create table public.csbfp_registration_status_history (
  id               bigint generated always as identity primary key,
  registration_id  uuid not null references public.csbfp_registrations (id),
  from_status      text,
  to_status        text not null,
  hold_change      text check (hold_change in ('placed', 'released')),
  reason           text not null,
  actor_type       text not null check (actor_type in ('system', 'registrant', 'admin', 'stripe')),
  actor_id         uuid,             -- admin id when actor_type = 'admin'
  source_ref       text,             -- e.g. Stripe event id
  created_at       timestamptz not null default now()
);

create index csbfp_status_history_registration_idx on public.csbfp_registration_status_history (registration_id, created_at desc);

-- Change status and write history in one step. The app never updates status directly.
create or replace function public.csbfp_set_registration_status(
  p_registration_id uuid,
  p_to_status       text,
  p_reason          text,
  p_actor_type      text,
  p_actor_id        uuid default null,
  p_source_ref      text default null
) returns void
language plpgsql set search_path = '' as $$
declare
  v_from text;
begin
  select status into v_from from public.csbfp_registrations where id = p_registration_id for update;
  if not found then
    raise exception 'Registration % not found', p_registration_id;
  end if;
  if v_from = p_to_status then
    return;
  end if;
  update public.csbfp_registrations set status = p_to_status where id = p_registration_id;
  insert into public.csbfp_registration_status_history (registration_id, from_status, to_status, reason, actor_type, actor_id, source_ref)
  values (p_registration_id, v_from, p_to_status, p_reason, p_actor_type, p_actor_id, p_source_ref);
end $$;

-- Give a registration its permanent number: prefix plus 8 random digits. Returns the existing number if it has one.
create or replace function public.csbfp_assign_registration_number(p_registration_id uuid) returns text
language plpgsql set search_path = '' as $$
declare
  v_existing  text;
  v_candidate text;
begin
  select registration_number into v_existing from public.csbfp_registrations where id = p_registration_id for update;
  if not found then
    raise exception 'Registration % not found', p_registration_id;
  end if;
  if v_existing is not null then
    return v_existing;
  end if;
  for i in 1..20 loop
    v_candidate := 'BR-' || lpad(floor(random() * 100000000)::bigint::text, 8, '0');
    begin
      update public.csbfp_registrations set registration_number = v_candidate where id = p_registration_id;
      return v_candidate;
    exception when unique_violation then
      -- taken; try another
    end;
  end loop;
  raise exception 'Could not assign a unique registration number';
end $$;

-- ===========================================================================
-- BILLING (Stripe holds card details; we keep ids, amounts and dates)
-- ===========================================================================

create table public.csbfp_subscriptions (
  id                      uuid primary key default gen_random_uuid(),
  registrant_id           uuid not null references public.csbfp_registrants (id),
  registration_id         uuid not null references public.csbfp_registrations (id),
  stripe_customer_id      text not null,
  stripe_subscription_id  text not null unique,
  stripe_status           text not null,
  cancel_at_period_end    boolean not null default false,
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  canceled_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index csbfp_subscriptions_registrant_idx on public.csbfp_subscriptions (registrant_id);

create trigger csbfp_subscriptions_touch before update on public.csbfp_subscriptions
  for each row execute function public.csbfp_touch_updated_at();

create table public.csbfp_payments (
  id                        uuid primary key default gen_random_uuid(),
  registrant_id             uuid not null references public.csbfp_registrants (id),
  registration_id           uuid not null references public.csbfp_registrations (id),
  subscription_id           uuid references public.csbfp_subscriptions (id),
  stripe_invoice_id         text not null unique,
  stripe_payment_intent_id  text,
  amount_cents              int not null check (amount_cents >= 0),
  currency                  text not null default 'usd',
  billing_reason            text not null check (billing_reason in ('initial', 'renewal', 'reactivation')),
  status                    text not null check (status in ('open', 'paid', 'failed', 'refunded', 'partially_refunded')),
  refunded_cents            int not null default 0,   -- refunds are only ever done by hand in Stripe
  period_start              timestamptz,
  period_end                timestamptz,
  hosted_invoice_url        text,
  paid_at                   timestamptz,
  failure_message           text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index csbfp_payments_registrant_idx on public.csbfp_payments (registrant_id, created_at desc);
create index csbfp_payments_status_idx on public.csbfp_payments (status, created_at desc);

create trigger csbfp_payments_touch before update on public.csbfp_payments
  for each row execute function public.csbfp_touch_updated_at();

-- Every Stripe webhook, by event id: makes webhook handling idempotent.
create table public.csbfp_stripe_events (
  id            text primary key,     -- evt_...
  type          text not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  error         text
);

-- ===========================================================================
-- LEGAL
-- ===========================================================================

create table public.csbfp_legal_documents (
  id            uuid primary key default gen_random_uuid(),
  key           text not null check (key in ('terms', 'privacy', 'registration_agreement', 'automatic_renewal',
                                               'disclaimer', 'acknowledgments')),
  version       int not null check (version > 0),
  title         text not null,
  body_md       text not null,
  status        text not null default 'draft' check (status in ('draft', 'published')),
  effective_at  timestamptz,
  published_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (key, version)
);

create trigger csbfp_legal_documents_touch before update on public.csbfp_legal_documents
  for each row execute function public.csbfp_touch_updated_at();

-- Insert-only evidence of what each registrant accepted, and when.
create table public.csbfp_legal_acceptances (
  id                bigint generated always as identity primary key,
  registrant_id     uuid not null references public.csbfp_registrants (id),
  document_key      text not null,
  document_version  int not null,
  context           text not null check (context in ('signup', 'acknowledgments', 'checkout', 'terms_update')),
  ref               text,                 -- e.g. Stripe Checkout Session id
  accepted_at       timestamptz not null default now(),
  ip                text,
  user_agent        text,
  foreign key (document_key, document_version) references public.csbfp_legal_documents (key, version)
);

create index csbfp_legal_acceptances_registrant_idx on public.csbfp_legal_acceptances (registrant_id, accepted_at desc);

-- ===========================================================================
-- TRAINING
-- ===========================================================================

-- Editing published training creates a new draft version, so a completion always points at what the person saw.
create table public.csbfp_curriculum_versions (
  id            uuid primary key default gen_random_uuid(),
  label         text not null unique,
  status        text not null default 'draft' check (status in ('draft', 'published', 'retired')),
  is_required   boolean not null default false,
  published_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Only one curriculum version is required at a time.
create unique index csbfp_curriculum_one_required_uq on public.csbfp_curriculum_versions (is_required) where is_required;

create trigger csbfp_curriculum_versions_touch before update on public.csbfp_curriculum_versions
  for each row execute function public.csbfp_touch_updated_at();

create table public.csbfp_modules (
  id                     uuid primary key default gen_random_uuid(),
  curriculum_version_id  uuid not null references public.csbfp_curriculum_versions (id) on delete cascade,
  stable_key             text not null,        -- identifies "the same module" across versions
  position               int not null,
  title                  text not null,
  body_md                text not null default '',
  video_url              text,
  estimated_minutes      int,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (curriculum_version_id, stable_key),
  constraint csbfp_modules_position_uq unique (curriculum_version_id, position) deferrable initially deferred
);

create trigger csbfp_modules_touch before update on public.csbfp_modules
  for each row execute function public.csbfp_touch_updated_at();

create table public.csbfp_training_progress (
  registrant_id  uuid not null references public.csbfp_registrants (id) on delete cascade,
  module_id      uuid not null references public.csbfp_modules (id),
  started_at     timestamptz not null default now(),
  completed_at   timestamptz,
  primary key (registrant_id, module_id)
);

-- ===========================================================================
-- ASSESSMENT
-- ===========================================================================

create table public.csbfp_assessment_settings (
  curriculum_version_id  uuid primary key references public.csbfp_curriculum_versions (id) on delete cascade,
  question_count         int not null default 40 check (question_count between 1 and 200),
  pass_percent           int not null default 80 check (pass_percent between 1 and 100),
  cooldown_minutes       int not null default 60 check (cooldown_minutes >= 0),
  max_attempts_total     int default 10 check (max_attempts_total is null or max_attempts_total > 0),  -- null = unlimited
  updated_at             timestamptz not null default now()
);

create trigger csbfp_assessment_settings_touch before update on public.csbfp_assessment_settings
  for each row execute function public.csbfp_touch_updated_at();

create table public.csbfp_questions (
  id                     uuid primary key default gen_random_uuid(),
  curriculum_version_id  uuid not null references public.csbfp_curriculum_versions (id) on delete cascade,
  module_stable_key      text,
  prompt                 text not null,
  explanation            text,
  active                 boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index csbfp_questions_version_idx on public.csbfp_questions (curriculum_version_id) where active;

create trigger csbfp_questions_touch before update on public.csbfp_questions
  for each row execute function public.csbfp_touch_updated_at();

create table public.csbfp_question_options (
  id           uuid primary key default gen_random_uuid(),
  question_id  uuid not null references public.csbfp_questions (id) on delete cascade,
  text         text not null,
  is_correct   boolean not null default false,
  position     int not null
);

create index csbfp_question_options_question_idx on public.csbfp_question_options (question_id);

-- Each attempt keeps a snapshot of exactly what was served, so later edits never change past results.
-- Scores are never shown publicly.
create table public.csbfp_assessment_attempts (
  id                     uuid primary key default gen_random_uuid(),
  registrant_id          uuid not null references public.csbfp_registrants (id) on delete cascade,
  curriculum_version_id  uuid not null references public.csbfp_curriculum_versions (id),
  started_at             timestamptz not null default now(),
  submitted_at           timestamptz,
  questions_snapshot     jsonb not null,
  answers                jsonb,
  question_count         int not null,
  correct_count          int,
  score_percent          numeric(5, 2),
  pass_percent_applied   int not null,
  passed                 boolean
);

create index csbfp_attempts_registrant_idx on public.csbfp_assessment_attempts (registrant_id, started_at desc);

-- An admin reset of the attempt limit. Attempts before the latest reset no longer count toward it.
create table public.csbfp_assessment_resets (
  id             bigint generated always as identity primary key,
  registrant_id  uuid not null references public.csbfp_registrants (id) on delete cascade,
  admin_id       uuid not null,
  reason         text not null,
  created_at     timestamptz not null default now()
);

create index csbfp_assessment_resets_registrant_idx on public.csbfp_assessment_resets (registrant_id, created_at desc);

-- ===========================================================================
-- EMAIL
-- ===========================================================================

-- Body only; the layout (header, disclaimer footer) stays in code.
create table public.csbfp_email_templates (
  key         text primary key,
  subject     text not null,
  body_md     text not null,
  version     int not null default 1,
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);

-- One row per send. The row is inserted before sending, and the unique dedupe_key prevents duplicates.
create table public.csbfp_email_messages (
  id                   uuid primary key default gen_random_uuid(),
  registrant_id        uuid references public.csbfp_registrants (id) on delete cascade,
  template_key         text not null,
  template_version     int,
  dedupe_key           text not null unique,
  to_email             text not null,
  status               text not null default 'queued' check (status in ('queued', 'sent', 'delivered', 'bounced', 'failed')),
  postmark_message_id  text,
  error                text,
  attempts             int not null default 0,
  created_at           timestamptz not null default now(),
  sent_at              timestamptz,
  updated_at           timestamptz not null default now()
);

create index csbfp_email_messages_registrant_idx on public.csbfp_email_messages (registrant_id, created_at desc);
create index csbfp_email_messages_status_idx on public.csbfp_email_messages (status, created_at desc);
create index csbfp_email_messages_postmark_idx on public.csbfp_email_messages (postmark_message_id) where postmark_message_id is not null;

create trigger csbfp_email_messages_touch before update on public.csbfp_email_messages
  for each row execute function public.csbfp_touch_updated_at();

-- Raw Postmark webhook outcomes (delivery, bounce, spam complaint).
create table public.csbfp_postmark_events (
  id           bigint generated always as identity primary key,
  message_id   text,
  record_type  text not null,
  payload      jsonb not null,
  received_at  timestamptz not null default now()
);

create index csbfp_postmark_events_message_idx on public.csbfp_postmark_events (message_id);

-- ===========================================================================
-- ADMIN AND OPERATIONS
-- ===========================================================================

-- Admin access is limited to the ADMIN_EMAILS allowlist in the app; rows are created on first sign-in.
create table public.csbfp_admin_users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null unique check (email = lower(email)),
  name           text,
  active         boolean not null default true,
  last_login_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger csbfp_admin_users_touch before update on public.csbfp_admin_users
  for each row execute function public.csbfp_touch_updated_at();

create table public.csbfp_admin_login_codes (
  id          uuid primary key default gen_random_uuid(),
  admin_id    uuid not null references public.csbfp_admin_users (id) on delete cascade,
  code_hash   text not null,
  expires_at  timestamptz not null,
  attempts    int not null default 0,
  used_at     timestamptz,
  ip          text,
  created_at  timestamptz not null default now()
);

create index csbfp_admin_login_codes_admin_created_idx on public.csbfp_admin_login_codes (admin_id, created_at desc);

alter table public.csbfp_assessment_resets
  add constraint csbfp_assessment_resets_admin_fk foreign key (admin_id) references public.csbfp_admin_users (id);

-- Insert-only record of admin actions. detail holds field names changed, never DOB values.
create table public.csbfp_admin_audit_log (
  id           bigint generated always as identity primary key,
  admin_id     uuid references public.csbfp_admin_users (id),
  action       text not null,
  target_type  text,
  target_id    text,
  reason       text,
  detail       jsonb not null default '{}'::jsonb,
  ip           text,
  created_at   timestamptz not null default now()
);

create index csbfp_admin_audit_target_idx on public.csbfp_admin_audit_log (target_type, target_id, created_at desc);
create index csbfp_admin_audit_created_idx on public.csbfp_admin_audit_log (created_at desc);

-- Registrant activity (sign-ins, profile changes, training completions). Never contains DOB.
create table public.csbfp_events (
  id             bigint generated always as identity primary key,
  registrant_id  uuid references public.csbfp_registrants (id) on delete cascade,
  event          text not null,
  actor          text not null check (actor in ('registrant', 'admin', 'system', 'stripe')),
  detail         jsonb not null default '{}'::jsonb,
  ip             text,
  created_at     timestamptz not null default now()
);

create index csbfp_events_registrant_idx on public.csbfp_events (registrant_id, created_at desc);

-- Possible duplicate accounts. An open flag blocks checkout until an admin clears it.
create table public.csbfp_duplicate_flags (
  id                     uuid primary key default gen_random_uuid(),
  registrant_id          uuid not null references public.csbfp_registrants (id) on delete cascade,
  matched_registrant_id  uuid not null references public.csbfp_registrants (id) on delete cascade,
  match_reason           text not null check (match_reason in ('dob_last_name_zip', 'dob_full_name', 'phone')),
  status                 text not null default 'open' check (status in ('open', 'dismissed', 'merged')),
  reviewed_by            uuid references public.csbfp_admin_users (id),
  reviewed_at            timestamptz,
  note                   text,
  created_at             timestamptz not null default now(),
  unique (registrant_id, matched_registrant_id, match_reason)
);

create index csbfp_duplicate_flags_open_idx on public.csbfp_duplicate_flags (registrant_id) where status = 'open';

create table public.csbfp_support_requests (
  id             uuid primary key default gen_random_uuid(),
  registrant_id  uuid references public.csbfp_registrants (id) on delete set null,
  contact_email  text not null,
  category       text not null check (category in ('account_recovery', 'data_correction', 'data_deletion', 'billing',
                                                   'duplicate_review', 'assessment_reset', 'other')),
  message        text not null,
  status         text not null default 'open' check (status in ('open', 'in_progress', 'closed')),
  admin_note     text,
  closed_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index csbfp_support_requests_status_idx on public.csbfp_support_requests (status, created_at desc);

create trigger csbfp_support_requests_touch before update on public.csbfp_support_requests
  for each row execute function public.csbfp_touch_updated_at();

-- Public lookups, for spotting scraping. No query text, only a keyed hash of the IP. Kept 90 days.
create table public.csbfp_verify_lookups (
  id          bigint generated always as identity primary key,
  ip_hash     text not null,
  found       boolean not null,
  created_at  timestamptz not null default now()
);

create index csbfp_verify_lookups_created_idx on public.csbfp_verify_lookups (created_at);
create index csbfp_verify_lookups_ip_idx on public.csbfp_verify_lookups (ip_hash, created_at desc);

create table public.csbfp_settings (
  key         text primary key,
  value       jsonb not null,
  updated_by  uuid references public.csbfp_admin_users (id),
  updated_at  timestamptz not null default now()
);

-- Each daily job runs once per day.
create table public.csbfp_job_runs (
  id           bigint generated always as identity primary key,
  job          text not null,
  run_date     date not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  result       jsonb,
  unique (job, run_date)
);

-- ===========================================================================
-- STARTING DATA (all editable in admin later)
-- ===========================================================================

insert into public.csbfp_job_titles (label, position) values
  ('Sales Representative', 1),
  ('Account Executive', 2),
  ('Senior Account Executive', 3),
  ('Business Development Representative', 4),
  ('Business Development Manager', 5),
  ('Sales Manager', 6),
  ('Director of Sales', 7),
  ('Broker / Independent Broker', 8),
  ('Managing Broker', 9),
  ('Owner / Principal', 10),
  ('Other', 11);

insert into public.csbfp_financing_products (label, position) values
  ('Merchant Cash Advance / Revenue-Based Financing', 1),
  ('Equipment Financing / Leasing', 2),
  ('Asset-Based Lending', 3),
  ('Factoring / Accounts Receivable Financing', 4),
  ('Business Loans / Lines of Credit', 5),
  ('Other', 6);

insert into public.csbfp_settings (key, value) values
  ('renewal_reminder_days', '30'::jsonb),
  ('payment_method_reminder_days', '3'::jsonb);

-- ===========================================================================
-- LOCK DOWN: RLS on with no policies; strip API-role access from every csbfp_ object.
-- ===========================================================================

do $$
declare
  t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' and tablename like 'csbfp\_%' loop
    execute format('alter table public.%I enable row level security', t.tablename);
    execute format('revoke all on public.%I from anon, authenticated', t.tablename);
  end loop;
  for t in select sequencename from pg_sequences where schemaname = 'public' and sequencename like 'csbfp\_%' loop
    execute format('revoke all on sequence public.%I from anon, authenticated', t.sequencename);
  end loop;
end $$;

revoke all on function public.csbfp_touch_updated_at() from public, anon, authenticated;
revoke all on function public.csbfp_registrations_number_locked() from public, anon, authenticated;
revoke all on function public.csbfp_set_registration_status(uuid, text, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.csbfp_assign_registration_number(uuid) from public, anon, authenticated;
grant execute on function public.csbfp_set_registration_status(uuid, text, text, text, uuid, text) to service_role;
grant execute on function public.csbfp_assign_registration_number(uuid) to service_role;
