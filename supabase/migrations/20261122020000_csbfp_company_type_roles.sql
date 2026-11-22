-- Employer entries use pick lists only: Company Type and Primary Role. Job title is no longer collected
-- (existing values are kept for the record).
alter table public.csbfp_employment_relationships
  add column if not exists company_type text check (company_type in ('broker', 'funder_lender', 'service_provider', 'technology_provider', 'other'));

alter table public.csbfp_employment_relationships drop constraint if exists csbfp_employment_relationships_primary_role_check;
alter table public.csbfp_employment_relationships add constraint csbfp_employment_relationships_primary_role_check
  check (primary_role in ('owner_executive', 'sales_bizdev', 'sales_management', 'underwriting_credit', 'operations',
    'funding_processing', 'servicing_collections', 'compliance_risk', 'legal', 'technology_it', 'marketing',
    'administrative_support', 'other'));

alter table public.csbfp_employment_relationships drop constraint if exists csbfp_employment_title;
