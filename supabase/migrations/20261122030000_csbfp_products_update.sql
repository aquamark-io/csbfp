-- Financing products pick list (labels live in the database; Admin > Lists can also edit them).
update public.csbfp_financing_products set label = 'Revenue-Based Financing (MCA)', position = 1 where label = 'Revenue-Based Financing / Merchant Cash Advances';
update public.csbfp_financing_products set label = 'Equipment Leasing & Loans', position = 2 where label = 'Equipment Leasing / Equipment Loans';
update public.csbfp_financing_products set active = false where label = 'Not directly involved with financing products';
insert into public.csbfp_financing_products (label, position, active) values ('SBA', 7, true)
on conflict (label) do update set active = true, position = 7;
