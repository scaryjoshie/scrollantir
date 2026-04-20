-- Starter tag ontology. Runs after every `supabase db reset` and on
-- first remote push via the Supabase CLI. Idempotent: safe to re-run.

INSERT INTO source_tags (device, source, tag) VALUES
  -- Short-form video (the primary signal we're tracking)
  ('phone', 'youtube.shorts',    'short_form'),
  ('phone', 'instagram.reels',   'short_form'),
  ('phone', 'tiktok.feed',       'short_form'),
  ('phone', 'instagram.stories', 'short_form'),

  -- Broader "social feed" category (superset of short_form, plus static feeds)
  ('phone', 'instagram.reels',   'social_feed'),
  ('phone', 'instagram.stories', 'social_feed'),

  -- Device-activity signals, for Mac-vs-phone disambiguation math
  ('mac',   'system.afk',        'activity_signal'),
  ('mac',   'system.window',     'activity_signal'),
  ('phone', 'system.unlocked',   'activity_signal'),
  ('phone', 'system.foreground', 'activity_signal')
ON CONFLICT DO NOTHING;
