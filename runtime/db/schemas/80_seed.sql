-- Seed: devices and source_tags. Idempotent via ON CONFLICT — this file
-- runs once on first boot from /docker-entrypoint-initdb.d/, but we
-- write it idempotently so a manual re-run during ops doesn't error.

-- Devices. Two physical, two synthetic services. Synthetic devices
-- exist so events whose source segment-zero is non-physical (cloud-
-- polled APIs, user prompt answers) satisfy the events.device FK.
--   cloud  — service-polled (github, spotify, gcal — emitted by agent)
--   prompt — user prompt answers (source format `prompt.<kind>` per
--            data-model.md §2 prompt-answer pseudo-sources)
INSERT INTO public.devices (id, kind, label, platform)
VALUES
  ('phone',  'physical', 'Pixel 9',               'android'),
  ('mac',    'physical', 'MacBook',                'macos'),
  ('cloud',  'service',  'Service-polled events',  'service'),
  ('prompt', 'service',  'User prompt answers',    'service')
ON CONFLICT (id) DO NOTHING;

-- Source tags (ontology). Cross-cutting categorization keyed on full
-- dotted source. Add more as new content streams ship.
INSERT INTO public.source_tags (source, tag) VALUES
  ('phone.youtube.shorts',    'short_form'),
  ('phone.instagram.reels',   'short_form'),
  ('phone.tiktok.feed',       'short_form'),
  ('phone.instagram.reels',   'social_feed'),
  ('phone.instagram.stories', 'social_feed'),
  ('phone.instagram.feed',    'social_feed')
ON CONFLICT (source, tag) DO NOTHING;
