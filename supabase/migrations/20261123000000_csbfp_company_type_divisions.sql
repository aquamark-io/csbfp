-- Company type adds two combined choices: a funder with a sales division, and a brokerage with a funding division.
-- Existing values are kept (older types stay valid for records saved before the scope change).
alter table public.csbfp_employment_relationships drop constraint if exists csbfp_employment_relationships_company_type_check;
alter table public.csbfp_employment_relationships add constraint csbfp_employment_relationships_company_type_check
  check (company_type in ('broker', 'funder_lender', 'funder_with_sales', 'broker_with_funding',
    'service_provider', 'technology_provider', 'other'));
