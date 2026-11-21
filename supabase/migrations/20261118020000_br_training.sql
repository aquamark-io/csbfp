-- Broker Registry: training and assessment additions (schema only; content is loaded separately and is
-- never stored in this repository).

-- Curriculum-level text shown to learners: the training overview and the completion message.
alter table public.br_curriculum_versions
  add column overview_md   text not null default '',
  add column completion_md text not null default '';

-- Questions are shown in a fixed order.
alter table public.br_questions
  add column position int not null default 0;

create index br_questions_order_idx on public.br_questions (curriculum_version_id, position);

-- The professional standards acknowledgment (Module 3.5) is confirmed before starting the assessment.
alter table public.br_legal_documents drop constraint br_legal_documents_key_check;
alter table public.br_legal_documents add constraint br_legal_documents_key_check
  check (key in ('terms', 'privacy', 'registration_agreement', 'automatic_renewal', 'disclaimer',
                 'acknowledgments', 'conduct_standards'));

alter table public.br_legal_acceptances drop constraint br_legal_acceptances_context_check;
alter table public.br_legal_acceptances add constraint br_legal_acceptances_context_check
  check (context in ('signup', 'acknowledgments', 'checkout', 'terms_update', 'assessment'));
