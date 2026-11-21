-- Phase 1 financing product list (applied 2026-11-19). "Other" is retired, not deleted, so past selections stay valid.
update public.csbfp_financing_products set label = v.label, position = v.pos, active = v.active
from (values (1, 'Revenue-Based Financing', 1, true), (2, 'Equipment Leasing', 2, true), (3, 'Asset-Based Lending', 3, true),
             (4, 'Invoice Factoring', 4, true), (5, 'Business Loan', 5, true), (6, 'Other', 99, false)) as v(id, label, pos, active)
where public.csbfp_financing_products.id = v.id;
insert into public.csbfp_financing_products (label, position, active)
select 'Business Line of Credit', 6, true
where not exists (select 1 from public.csbfp_financing_products where label = 'Business Line of Credit');
