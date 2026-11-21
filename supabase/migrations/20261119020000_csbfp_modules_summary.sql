-- Short one-line description per module, shown under the module title on the Training page.
alter table public.csbfp_modules add column if not exists summary text;
