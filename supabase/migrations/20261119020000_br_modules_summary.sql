-- Short one-line description per module, shown under the module title on the Training page.
alter table public.br_modules add column if not exists summary text;
