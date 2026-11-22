-- Employer certification credits. An employer requests an Employer ID (no sign-in), buys credits through Stripe
-- (one credit = one first-year certification fee), and employees enter the ID at the payment step instead of a card.
-- Credits are non-refundable, never expire and cover one year (no automatic renewal on the employer).

create table public.csbfp_employers (
  id                 uuid primary key default gen_random_uuid(),
  employer_number    text not null unique check (employer_number ~ '^ER-[A-Z0-9]{6}$'),
  company_name       text not null,
  contact_name       text,
  email              text not null check (email = lower(email)),
  active             boolean not null default true,
  credits_purchased  int not null default 0 check (credits_purchased >= 0),
  credits_adjusted   int not null default 0,              -- admin corrections (+/-)
  credits_used       int not null default 0 check (credits_used >= 0),
  replaced_by        uuid references public.csbfp_employers (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index csbfp_employers_email_idx on public.csbfp_employers (email);
create trigger csbfp_employers_touch before update on public.csbfp_employers for each row execute function public.csbfp_touch_updated_at();

create table public.csbfp_employer_purchases (
  id                 uuid primary key default gen_random_uuid(),
  employer_id        uuid not null references public.csbfp_employers (id),
  stripe_session_id  text not null unique,
  quantity           int not null check (quantity > 0),
  amount_cents       int not null check (amount_cents >= 0),
  status             text not null default 'open' check (status in ('open', 'paid')),
  paid_at            timestamptz,
  created_at         timestamptz not null default now()
);
create index csbfp_employer_purchases_employer_idx on public.csbfp_employer_purchases (employer_id, created_at desc);

create table public.csbfp_employer_credit_uses (
  id               bigint generated always as identity primary key,
  employer_id      uuid not null references public.csbfp_employers (id),
  registration_id  uuid references public.csbfp_registrations (id),          -- null for admin adjustments
  kind             text not null default 'use' check (kind in ('use', 'adjustment')),
  amount           int not null default 1,
  note             text,
  actor_id         uuid,
  created_at       timestamptz not null default now()
);
create index csbfp_employer_credit_uses_employer_idx on public.csbfp_employer_credit_uses (employer_id, created_at desc);
create unique index csbfp_employer_credit_one_use on public.csbfp_employer_credit_uses (registration_id) where kind = 'use';

alter table public.csbfp_registrations
  add column if not exists paid_by_employer_id uuid references public.csbfp_employers (id);

-- Use one credit atomically. Returns the employer id, or raises if the ID is unknown, inactive or out of credits.
create or replace function public.csbfp_use_employer_credit(p_employer_number text, p_registration_id uuid) returns uuid
language plpgsql set search_path = '' as $$
declare e public.csbfp_employers;
begin
  select * into e from public.csbfp_employers where employer_number = upper(trim(p_employer_number)) and active for update;
  if not found then raise exception 'EMPLOYER_NOT_FOUND'; end if;
  if e.credits_purchased + e.credits_adjusted - e.credits_used < 1 then raise exception 'NO_CREDITS'; end if;
  insert into public.csbfp_employer_credit_uses (employer_id, registration_id, kind, amount) values (e.id, p_registration_id, 'use', 1);
  update public.csbfp_employers set credits_used = credits_used + 1 where id = e.id;
  update public.csbfp_registrations set paid_by_employer_id = e.id where id = p_registration_id;
  return e.id;
end $$;

-- Add purchased credits once per Stripe Checkout Session.
create or replace function public.csbfp_add_employer_credits(p_session_id text) returns boolean
language plpgsql set search_path = '' as $$
declare p public.csbfp_employer_purchases;
begin
  select * into p from public.csbfp_employer_purchases where stripe_session_id = p_session_id for update;
  if not found then raise exception 'PURCHASE_NOT_FOUND'; end if;
  if p.status = 'paid' then return false; end if;
  update public.csbfp_employer_purchases set status = 'paid', paid_at = now() where id = p.id;
  update public.csbfp_employers set credits_purchased = credits_purchased + p.quantity where id = p.employer_id;
  return true;
end $$;

do $$
declare t text;
begin
  foreach t in array array['csbfp_employers', 'csbfp_employer_purchases', 'csbfp_employer_credit_uses'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence public.csbfp_employer_credit_uses_id_seq from anon, authenticated;
revoke all on function public.csbfp_use_employer_credit(text, uuid) from public, anon, authenticated;
revoke all on function public.csbfp_add_employer_credits(text) from public, anon, authenticated;
grant execute on function public.csbfp_use_employer_credit(text, uuid) to service_role;
grant execute on function public.csbfp_add_employer_credits(text) to service_role;
