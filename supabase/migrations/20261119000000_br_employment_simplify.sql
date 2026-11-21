-- Phase 1: employment asks for current employers only (company, website, job title,
-- how they work with the company, work arrangement, start date). Company city and state
-- are no longer collected; existing values are kept.
alter table public.br_employment_relationships
  alter column city drop not null,
  alter column state drop not null;
