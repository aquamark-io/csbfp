-- CSBFP: certification statuses, demo credentials, one-time screening records (provider not integrated),
-- appeals/disputes, primary role, revised product list and job titles.
--
-- Internal status values (labels shown in the app):
--   pending            In Progress        application, training or payment not finished
--   pending_screening  Pending Screening  paid, waiting on the one-time background screening (when enabled)
--   under_review       Under Review       an authorized reviewer is deciding eligibility
--   not_approved       Not Approved       eligibility denied (internal only; never shown publicly)
--   active             Certified          all initial requirements met and term current
--   inactive           Inactive           renewal payment failed
--   expired            Expired            term ended
--   suspended          Suspended          temporary action pending review
--   revoked            Revoked            final withdrawal under program rules

alter table public.csbfp_registrations drop constraint if exists csbfp_registrations_status_check;
alter table public.csbfp_registrations add constraint csbfp_registrations_status_check
  check (status in ('pending', 'pending_screening', 'under_review', 'not_approved', 'active', 'inactive', 'expired', 'suspended', 'revoked'));

alter table public.csbfp_registrations drop constraint if exists csbfp_registrations_number_when_live;
alter table public.csbfp_registrations add constraint csbfp_registrations_number_when_live
  check (status in ('pending', 'pending_screening', 'under_review', 'not_approved') or registration_number is not null);

alter table public.csbfp_registrations
  -- Issued while background screening was switched off: never shown publicly as a genuine certification.
  add column if not exists is_demo      boolean not null default false,
  add column if not exists paid_at      timestamptz,          -- first initial payment (term starts on approval)
  add column if not exists approved_at  timestamptz,          -- final eligibility approval
  add column if not exists approved_by  uuid references public.csbfp_admin_users (id);

alter table public.csbfp_registration_status_history
  add column if not exists effective_at  timestamptz,
  add column if not exists evidence_ref  text;

-- Explicit transitions. Suspension, revocation, not-approved and leaving those states need an admin.
create or replace function public.csbfp_status_transition_allowed(p_from text, p_to text, p_actor text) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when p_to in ('suspended', 'revoked', 'not_approved') and p_actor <> 'admin' then false
    when p_from in ('revoked', 'not_approved') and p_actor <> 'admin' then false
    when p_from = 'suspended' and p_to <> 'expired' and p_actor <> 'admin' then false
    else (p_from, p_to) in (
      ('pending', 'pending_screening'), ('pending', 'under_review'), ('pending', 'active'),
      ('pending_screening', 'under_review'), ('pending_screening', 'not_approved'),
      ('under_review', 'active'), ('under_review', 'not_approved'), ('under_review', 'pending_screening'),
      ('not_approved', 'under_review'),
      ('active', 'inactive'), ('active', 'expired'), ('active', 'suspended'), ('active', 'revoked'),
      ('inactive', 'active'), ('inactive', 'expired'), ('inactive', 'suspended'), ('inactive', 'revoked'),
      ('expired', 'active'), ('expired', 'suspended'), ('expired', 'revoked'),
      ('suspended', 'active'), ('suspended', 'inactive'), ('suspended', 'expired'), ('suspended', 'revoked'),
      ('revoked', 'active'))
  end $$;

drop function if exists public.csbfp_set_registration_status(uuid, text, text, text, uuid, text);
create or replace function public.csbfp_set_registration_status(
  p_registration_id uuid,
  p_to_status       text,
  p_reason          text,
  p_actor_type      text,
  p_actor_id        uuid default null,
  p_source_ref      text default null,
  p_effective_at    timestamptz default null,
  p_evidence_ref    text default null
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
  if not public.csbfp_status_transition_allowed(v_from, p_to_status, p_actor_type) then
    raise exception 'Status change % -> % is not allowed for %', v_from, p_to_status, p_actor_type;
  end if;
  update public.csbfp_registrations set status = p_to_status where id = p_registration_id;
  insert into public.csbfp_registration_status_history
    (registration_id, from_status, to_status, reason, actor_type, actor_id, source_ref, effective_at, evidence_ref)
  values (p_registration_id, v_from, p_to_status, p_reason, p_actor_type, p_actor_id, p_source_ref,
          coalesce(p_effective_at, now()), p_evidence_ref);
end $$;

-- Permanent number: configurable prefix + 8 random digits (random, so numbers can't be walked).
drop function if exists public.csbfp_assign_registration_number(uuid);
create or replace function public.csbfp_assign_registration_number(p_registration_id uuid, p_prefix text default 'CSBFP')
returns text
language plpgsql set search_path = '' as $$
declare
  v_existing  text;
  v_candidate text;
begin
  if p_prefix !~ '^[A-Z]{2,10}$' then
    raise exception 'Invalid number prefix %', p_prefix;
  end if;
  select registration_number into v_existing from public.csbfp_registrations where id = p_registration_id for update;
  if not found then
    raise exception 'Registration % not found', p_registration_id;
  end if;
  if v_existing is not null then
    return v_existing;
  end if;
  for i in 1..20 loop
    v_candidate := p_prefix || '-' || lpad(floor(random() * 100000000)::bigint::text, 8, '0');
    begin
      update public.csbfp_registrations set registration_number = v_candidate where id = p_registration_id;
      return v_candidate;
    exception when unique_violation then
    end;
  end loop;
  raise exception 'Could not assign a unique number';
end $$;

-- ---------------------------------------------------------------------------
-- One-time background screening. Workflow status only: no reports, SSNs or provider payloads are stored.
-- ---------------------------------------------------------------------------
create table if not exists public.csbfp_screenings (
  id                   uuid primary key default gen_random_uuid(),
  registrant_id        uuid not null references public.csbfp_registrants (id),
  registration_id      uuid not null references public.csbfp_registrations (id),
  provider             text not null,                 -- e.g. 'none' (not integrated), later 'checkr'
  requirement_version  text not null,                 -- screening policy version applied
  status               text not null default 'not_started'
                       check (status in ('not_started', 'awaiting_authorization', 'in_progress', 'review_required',
                                         'approved', 'not_approved', 'disputed')),
  external_ref         text,                          -- provider's candidate/report id, once integrated
  idempotency_key      text unique,
  requested_at         timestamptz,
  completed_at         timestamptz,
  reviewer_id          uuid references public.csbfp_admin_users (id),
  decision             text check (decision in ('approved', 'not_approved')),
  decision_reason      text,
  decided_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create unique index if not exists csbfp_screenings_one_per_registration on public.csbfp_screenings (registration_id);
create index if not exists csbfp_screenings_status_idx on public.csbfp_screenings (status, created_at);

create trigger csbfp_screenings_touch before update on public.csbfp_screenings
  for each row execute function public.csbfp_touch_updated_at();

create table if not exists public.csbfp_screening_events (
  id            bigint generated always as identity primary key,
  screening_id  uuid not null references public.csbfp_screenings (id),
  from_status   text,
  to_status     text not null,
  note          text,
  actor_type    text not null check (actor_type in ('system', 'admin', 'provider')),
  actor_id      uuid,
  source_ref    text,                                 -- e.g. provider webhook id (idempotency)
  created_at    timestamptz not null default now()
);

create unique index if not exists csbfp_screening_events_source_uq on public.csbfp_screening_events (source_ref) where source_ref is not null;
create index if not exists csbfp_screening_events_screening_idx on public.csbfp_screening_events (screening_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Appeals, disputes and reconsideration requests (recorded by admins; procedures pending program-owner approval).
-- ---------------------------------------------------------------------------
create table if not exists public.csbfp_appeals (
  id               uuid primary key default gen_random_uuid(),
  registrant_id    uuid not null references public.csbfp_registrants (id),
  registration_id  uuid references public.csbfp_registrations (id),
  kind             text not null check (kind in ('appeal', 'dispute', 'reconsideration')),
  subject          text not null check (subject in ('not_approved', 'suspension', 'revocation', 'screening', 'other')),
  status           text not null default 'open' check (status in ('open', 'under_review', 'upheld', 'reversed', 'withdrawn')),
  statement        text,                                -- the applicant's statement, as received
  decision_note    text,
  opened_by        uuid references public.csbfp_admin_users (id),
  decided_by       uuid references public.csbfp_admin_users (id),
  decided_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists csbfp_appeals_registrant_idx on public.csbfp_appeals (registrant_id, created_at desc);
create index if not exists csbfp_appeals_status_idx on public.csbfp_appeals (status, created_at);

create trigger csbfp_appeals_touch before update on public.csbfp_appeals
  for each row execute function public.csbfp_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Employment: primary role; job title is free text.
-- ---------------------------------------------------------------------------
alter table public.csbfp_employment_relationships
  add column if not exists primary_role text check (primary_role in ('brokerage_sales', 'funding_lending', 'underwriting_credit',
    'operations_servicing', 'compliance_risk', 'management_ownership', 'other')),
  add column if not exists primary_role_other text;

alter table public.csbfp_employment_relationships drop constraint if exists csbfp_employment_title;
alter table public.csbfp_employment_relationships add constraint csbfp_employment_title
  check (job_title_id is not null or job_title_other is not null);

update public.csbfp_job_titles set active = false;

-- Financing products (the last one is exclusive: it can't be combined with the others).
update public.csbfp_financing_products set active = false;
insert into public.csbfp_financing_products (label, position, active) values
  ('Revenue-Based Financing / Merchant Cash Advances', 1, true),
  ('Equipment Leasing / Equipment Loans', 2, true),
  ('Asset-Based Lending', 3, true),
  ('Invoice Factoring', 4, true),
  ('Business Loans', 5, true),
  ('Business Lines of Credit', 6, true),
  ('Not directly involved with financing products', 99, true)
on conflict (label) do update set position = excluded.position, active = true;

-- RLS on, no policies, service role only (same as every other csbfp_ object).
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' and tablename like 'csbfp\_%' loop
    execute format('alter table public.%I enable row level security', t.tablename);
    execute format('revoke all on public.%I from anon, authenticated', t.tablename);
  end loop;
  for t in select sequencename from pg_sequences where schemaname = 'public' and sequencename like 'csbfp\_%' loop
    execute format('revoke all on sequence public.%I from anon, authenticated', t.sequencename);
  end loop;
end $$;
revoke all on function public.csbfp_set_registration_status(uuid, text, text, text, uuid, text, timestamptz, text) from public, anon, authenticated;
revoke all on function public.csbfp_assign_registration_number(uuid, text) from public, anon, authenticated;
revoke all on function public.csbfp_status_transition_allowed(text, text, text) from public, anon, authenticated;
grant execute on function public.csbfp_set_registration_status(uuid, text, text, text, uuid, text, timestamptz, text) to service_role;
grant execute on function public.csbfp_assign_registration_number(uuid, text) to service_role;
grant execute on function public.csbfp_status_transition_allowed(text, text, text) to service_role;
