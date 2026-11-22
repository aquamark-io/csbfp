-- Phase 1 background checks: per-state Checkr open invitation links (stored in csbfp_settings, key
-- 'checkr_invitation_links'). Record which state's link an applicant was given and when they opened it,
-- so a reviewer can match the completed report in Checkr by name and email.
alter table public.csbfp_screenings
  add column if not exists state text check (state ~ '^[A-Z]{2}$'),
  add column if not exists link_opened_at timestamptz;
