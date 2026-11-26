-- CSBFP: version 1 of each legal document, so sign-up and acknowledgments can record acceptance.
-- The five legal documents are PLACEHOLDERS: reviewed text will be published as version 2 before launch.
-- The acknowledgments are the six statements from the project brief; each "- " line is one checkbox.

insert into public.csbfp_legal_documents (key, version, title, body_md, status, effective_at, published_at) values
  ('terms', 1, 'Terms of Service',
   'Placeholder. The Terms of Service are being prepared and will be published here before registration opens.',
   'published', now(), now()),
  ('privacy', 1, 'Privacy Policy',
   'Placeholder. The Privacy Policy is being prepared and will be published here before registration opens.',
   'published', now(), now()),
  ('registration_agreement', 1, 'Registration Agreement',
   'Placeholder. The Registration Agreement is being prepared and will be published here before registration opens.',
   'published', now(), now()),
  ('automatic_renewal', 1, 'Automatic Renewal Terms',
   'Placeholder. The Automatic Renewal Terms are being prepared and will be published here before registration opens.',
   'published', now(), now()),
  ('disclaimer', 1, 'Disclaimer',
   'CSBFP is a private, voluntary certification program operated by Duncan Consulting LLC. It is not a government agency or licensing authority.

Registration is not a license, does not replace any license or registration required by law, and does not authorize anyone to perform activities that require a state license.

Placeholder. The full disclaimer is being prepared and will be published here before registration opens.',
   'published', now(), now()),
  ('acknowledgments', 1, 'Registrant Acknowledgments',
   'By confirming, I acknowledge that:

- The information I have submitted is accurate.
- I will keep my employment and contact information current.
- My registration belongs to me and cannot be transferred to anyone else.
- Registration is not a government license.
- Completing registration does not guarantee compliance with any particular law.
- Misrepresenting my registration status is prohibited.',
   'published', now(), now());
