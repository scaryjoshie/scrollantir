
  create table "public"."annotations" (
    "id" uuid not null,
    "scope" text not null,
    "scope_ref" text not null,
    "body" text not null,
    "origin" text not null default 'user'::text,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "deleted_at" timestamp with time zone
      );


alter table "public"."annotations" enable row level security;


  create table "public"."devices" (
    "device_id" text not null,
    "label" text not null,
    "platform" text not null,
    "note" text,
    "created_at" timestamp with time zone not null default now(),
    "retired_at" timestamp with time zone
      );


alter table "public"."devices" enable row level security;


  create table "public"."events" (
    "id" uuid not null,
    "device" text not null,
    "source" text not null,
    "timestamp_utc" timestamp with time zone not null,
    "duration_s" double precision not null,
    "data" jsonb not null,
    "schema_version" smallint not null default 1,
    "received_at" timestamp with time zone not null default now(),
    "is_backfill" boolean not null default false
      );


alter table "public"."events" enable row level security;


  create table "public"."prompts" (
    "id" uuid not null,
    "asked_by" text not null,
    "kind" text not null,
    "question" text not null,
    "context" jsonb not null default '{}'::jsonb,
    "answer_schema" jsonb,
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone not null default now(),
    "answered_at" timestamp with time zone,
    "dismissed_at" timestamp with time zone
      );


alter table "public"."prompts" enable row level security;


  create table "public"."reports" (
    "id" uuid not null,
    "title" text not null,
    "body" text not null,
    "origin" text not null default 'agent'::text,
    "window_start" timestamp with time zone,
    "window_end" timestamp with time zone,
    "tags" text[] not null default ARRAY[]::text[],
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "deleted_at" timestamp with time zone
      );


alter table "public"."reports" enable row level security;


  create table "public"."source_tags" (
    "device" text not null,
    "source" text not null,
    "tag" text not null,
    "created_at" timestamp with time zone not null default now()
      );


alter table "public"."source_tags" enable row level security;

CREATE UNIQUE INDEX annotations_pkey ON public.annotations USING btree (id);

CREATE INDEX annotations_scope ON public.annotations USING btree (scope, scope_ref);

CREATE UNIQUE INDEX devices_pkey ON public.devices USING btree (device_id);

CREATE INDEX events_device_source_time ON public.events USING btree (device, source, timestamp_utc);

CREATE UNIQUE INDEX events_pkey ON public.events USING btree (id);

CREATE INDEX events_time_desc ON public.events USING btree (timestamp_utc DESC);

CREATE INDEX prompts_pending ON public.prompts USING btree (created_at DESC) WHERE ((answered_at IS NULL) AND (dismissed_at IS NULL));

CREATE UNIQUE INDEX prompts_pkey ON public.prompts USING btree (id);

CREATE UNIQUE INDEX reports_pkey ON public.reports USING btree (id);

CREATE UNIQUE INDEX source_tags_pkey ON public.source_tags USING btree (device, source, tag);

alter table "public"."annotations" add constraint "annotations_pkey" PRIMARY KEY using index "annotations_pkey";

alter table "public"."devices" add constraint "devices_pkey" PRIMARY KEY using index "devices_pkey";

alter table "public"."events" add constraint "events_pkey" PRIMARY KEY using index "events_pkey";

alter table "public"."prompts" add constraint "prompts_pkey" PRIMARY KEY using index "prompts_pkey";

alter table "public"."reports" add constraint "reports_pkey" PRIMARY KEY using index "reports_pkey";

alter table "public"."source_tags" add constraint "source_tags_pkey" PRIMARY KEY using index "source_tags_pkey";

alter table "public"."annotations" add constraint "annotations_body_nonempty" CHECK ((length(btrim(body)) > 0)) not valid;

alter table "public"."annotations" validate constraint "annotations_body_nonempty";

alter table "public"."annotations" add constraint "annotations_origin_valid" CHECK ((origin = ANY (ARRAY['agent'::text, 'user'::text, 'system'::text]))) not valid;

alter table "public"."annotations" validate constraint "annotations_origin_valid";

alter table "public"."annotations" add constraint "annotations_scope_valid" CHECK ((scope = ANY (ARRAY['event'::text, 'time_range'::text, 'source'::text, 'device'::text, 'day'::text]))) not valid;

alter table "public"."annotations" validate constraint "annotations_scope_valid";

alter table "public"."devices" add constraint "devices_label_nonempty" CHECK ((length(btrim(label)) > 0)) not valid;

alter table "public"."devices" validate constraint "devices_label_nonempty";

alter table "public"."devices" add constraint "devices_platform_valid" CHECK ((platform = ANY (ARRAY['macos'::text, 'android'::text, 'ios'::text, 'linux'::text]))) not valid;

alter table "public"."devices" validate constraint "devices_platform_valid";

alter table "public"."events" add constraint "events_device_fkey" FOREIGN KEY (device) REFERENCES public.devices(device_id) not valid;

alter table "public"."events" validate constraint "events_device_fkey";

alter table "public"."events" add constraint "events_duration_finite_nonneg" CHECK (((duration_s >= (0)::double precision) AND (duration_s < 'Infinity'::double precision))) not valid;

alter table "public"."events" validate constraint "events_duration_finite_nonneg";

alter table "public"."events" add constraint "events_schema_version_pos" CHECK ((schema_version > 0)) not valid;

alter table "public"."events" validate constraint "events_schema_version_pos";

alter table "public"."events" add constraint "events_source_nonempty" CHECK ((length(btrim(source)) > 0)) not valid;

alter table "public"."events" validate constraint "events_source_nonempty";

alter table "public"."prompts" add constraint "prompts_answered_xor_dismissed" CHECK (((answered_at IS NULL) OR (dismissed_at IS NULL))) not valid;

alter table "public"."prompts" validate constraint "prompts_answered_xor_dismissed";

alter table "public"."prompts" add constraint "prompts_kind_nonempty" CHECK ((length(btrim(kind)) > 0)) not valid;

alter table "public"."prompts" validate constraint "prompts_kind_nonempty";

alter table "public"."prompts" add constraint "prompts_question_nonempty" CHECK ((length(btrim(question)) > 0)) not valid;

alter table "public"."prompts" validate constraint "prompts_question_nonempty";

alter table "public"."reports" add constraint "reports_origin_valid" CHECK ((origin = ANY (ARRAY['agent'::text, 'user'::text, 'system'::text]))) not valid;

alter table "public"."reports" validate constraint "reports_origin_valid";

alter table "public"."reports" add constraint "reports_title_nonempty" CHECK ((length(btrim(title)) > 0)) not valid;

alter table "public"."reports" validate constraint "reports_title_nonempty";

alter table "public"."source_tags" add constraint "source_tags_device_nonempty" CHECK ((length(btrim(device)) > 0)) not valid;

alter table "public"."source_tags" validate constraint "source_tags_device_nonempty";

alter table "public"."source_tags" add constraint "source_tags_source_nonempty" CHECK ((length(btrim(source)) > 0)) not valid;

alter table "public"."source_tags" validate constraint "source_tags_source_nonempty";

alter table "public"."source_tags" add constraint "source_tags_tag_nonempty" CHECK ((length(btrim(tag)) > 0)) not valid;

alter table "public"."source_tags" validate constraint "source_tags_tag_nonempty";

create or replace view "public"."events_enriched" as  SELECT e.id,
    e.device,
    d.label AS device_label,
    d.platform AS device_platform,
    e.source,
    e.timestamp_utc,
    e.duration_s,
    e.data,
    e.schema_version,
    e.received_at,
    e.is_backfill,
    COALESCE(( SELECT array_agg(t.tag ORDER BY t.tag) AS array_agg
           FROM public.source_tags t
          WHERE ((t.device = e.device) AND (t.source = e.source))), ARRAY[]::text[]) AS tags
   FROM (public.events e
     JOIN public.devices d ON ((d.device_id = e.device)));


grant select on table "public"."annotations" to "agent_role";

grant delete on table "public"."annotations" to "service_role";

grant insert on table "public"."annotations" to "service_role";

grant references on table "public"."annotations" to "service_role";

grant select on table "public"."annotations" to "service_role";

grant trigger on table "public"."annotations" to "service_role";

grant truncate on table "public"."annotations" to "service_role";

grant update on table "public"."annotations" to "service_role";

grant delete on table "public"."annotations" to "user_role";

grant insert on table "public"."annotations" to "user_role";

grant select on table "public"."annotations" to "user_role";

grant update on table "public"."annotations" to "user_role";

grant select on table "public"."devices" to "agent_role";

grant delete on table "public"."devices" to "service_role";

grant insert on table "public"."devices" to "service_role";

grant references on table "public"."devices" to "service_role";

grant select on table "public"."devices" to "service_role";

grant trigger on table "public"."devices" to "service_role";

grant truncate on table "public"."devices" to "service_role";

grant update on table "public"."devices" to "service_role";

grant select on table "public"."devices" to "user_role";

grant select on table "public"."events" to "agent_role";

grant delete on table "public"."events" to "service_role";

grant insert on table "public"."events" to "service_role";

grant references on table "public"."events" to "service_role";

grant select on table "public"."events" to "service_role";

grant trigger on table "public"."events" to "service_role";

grant truncate on table "public"."events" to "service_role";

grant update on table "public"."events" to "service_role";

grant select on table "public"."events" to "user_role";

grant select on table "public"."prompts" to "agent_role";

grant delete on table "public"."prompts" to "service_role";

grant insert on table "public"."prompts" to "service_role";

grant references on table "public"."prompts" to "service_role";

grant select on table "public"."prompts" to "service_role";

grant trigger on table "public"."prompts" to "service_role";

grant truncate on table "public"."prompts" to "service_role";

grant update on table "public"."prompts" to "service_role";

grant delete on table "public"."prompts" to "user_role";

grant insert on table "public"."prompts" to "user_role";

grant select on table "public"."prompts" to "user_role";

grant update on table "public"."prompts" to "user_role";

grant select on table "public"."reports" to "agent_role";

grant delete on table "public"."reports" to "service_role";

grant insert on table "public"."reports" to "service_role";

grant references on table "public"."reports" to "service_role";

grant select on table "public"."reports" to "service_role";

grant trigger on table "public"."reports" to "service_role";

grant truncate on table "public"."reports" to "service_role";

grant update on table "public"."reports" to "service_role";

grant delete on table "public"."reports" to "user_role";

grant insert on table "public"."reports" to "user_role";

grant select on table "public"."reports" to "user_role";

grant update on table "public"."reports" to "user_role";

grant select on table "public"."source_tags" to "agent_role";

grant delete on table "public"."source_tags" to "service_role";

grant insert on table "public"."source_tags" to "service_role";

grant references on table "public"."source_tags" to "service_role";

grant select on table "public"."source_tags" to "service_role";

grant trigger on table "public"."source_tags" to "service_role";

grant truncate on table "public"."source_tags" to "service_role";

grant update on table "public"."source_tags" to "service_role";

grant delete on table "public"."source_tags" to "user_role";

grant insert on table "public"."source_tags" to "user_role";

grant select on table "public"."source_tags" to "user_role";

grant update on table "public"."source_tags" to "user_role";


  create policy "agent_role_read_annotations"
  on "public"."annotations"
  as permissive
  for select
  to agent_role
using (true);



  create policy "user_role_all_annotations"
  on "public"."annotations"
  as permissive
  for all
  to user_role
using (true)
with check (true);



  create policy "agent_role_read_devices"
  on "public"."devices"
  as permissive
  for select
  to agent_role
using (true);



  create policy "user_role_read_devices"
  on "public"."devices"
  as permissive
  for select
  to user_role
using (true);



  create policy "agent_role_read_events"
  on "public"."events"
  as permissive
  for select
  to agent_role
using (true);



  create policy "user_role_read_events"
  on "public"."events"
  as permissive
  for select
  to user_role
using (true);



  create policy "agent_role_read_prompts"
  on "public"."prompts"
  as permissive
  for select
  to agent_role
using (true);



  create policy "user_role_all_prompts"
  on "public"."prompts"
  as permissive
  for all
  to user_role
using (true)
with check (true);



  create policy "agent_role_read_reports"
  on "public"."reports"
  as permissive
  for select
  to agent_role
using (true);



  create policy "user_role_all_reports"
  on "public"."reports"
  as permissive
  for all
  to user_role
using (true)
with check (true);



  create policy "agent_role_read_source_tags"
  on "public"."source_tags"
  as permissive
  for select
  to agent_role
using (true);



  create policy "user_role_all_source_tags"
  on "public"."source_tags"
  as permissive
  for all
  to user_role
using (true)
with check (true);


create schema if not exists "private";


  create table "private"."ingest_rate_limit" (
    "token_hash" text not null,
    "window_start" timestamp with time zone not null,
    "hits" integer not null default 0
      );


alter table "private"."ingest_rate_limit" enable row level security;


  create table "private"."tokens" (
    "token_hash" text not null,
    "token_prefix" text not null,
    "device_id" text not null,
    "note" text,
    "created_at" timestamp with time zone not null default now(),
    "last_used_at" timestamp with time zone,
    "superseded_at" timestamp with time zone,
    "revoked_at" timestamp with time zone
      );


alter table "private"."tokens" enable row level security;

CREATE UNIQUE INDEX ingest_rate_limit_pkey ON private.ingest_rate_limit USING btree (token_hash, window_start);

CREATE INDEX ingest_rate_limit_window ON private.ingest_rate_limit USING btree (window_start);

CREATE INDEX tokens_active ON private.tokens USING btree (token_hash) WHERE (revoked_at IS NULL);

CREATE INDEX tokens_device_id ON private.tokens USING btree (device_id);

CREATE UNIQUE INDEX tokens_pkey ON private.tokens USING btree (token_hash);

alter table "private"."ingest_rate_limit" add constraint "ingest_rate_limit_pkey" PRIMARY KEY using index "ingest_rate_limit_pkey";

alter table "private"."tokens" add constraint "tokens_pkey" PRIMARY KEY using index "tokens_pkey";

alter table "private"."ingest_rate_limit" add constraint "rate_limit_hits_nonneg" CHECK ((hits >= 0)) not valid;

alter table "private"."ingest_rate_limit" validate constraint "rate_limit_hits_nonneg";

alter table "private"."tokens" add constraint "tokens_device_id_fkey" FOREIGN KEY (device_id) REFERENCES public.devices(device_id) not valid;

alter table "private"."tokens" validate constraint "tokens_device_id_fkey";

alter table "private"."tokens" add constraint "tokens_hash_looks_like_sha256" CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text)) not valid;

alter table "private"."tokens" validate constraint "tokens_hash_looks_like_sha256";

alter table "private"."tokens" add constraint "tokens_prefix_length" CHECK (((length(token_prefix) >= 4) AND (length(token_prefix) <= 12))) not valid;

alter table "private"."tokens" validate constraint "tokens_prefix_length";

alter table "private"."tokens" add constraint "tokens_prefix_nonempty" CHECK ((length(btrim(token_prefix)) > 0)) not valid;

alter table "private"."tokens" validate constraint "tokens_prefix_nonempty";

create schema if not exists "ingest_api";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION ingest_api.accept_event(p_token text, p_id uuid, p_device text, p_source text, p_timestamp_utc timestamp with time zone, p_duration_s double precision, p_data jsonb, p_schema_version smallint DEFAULT 1)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_hash         TEXT;
  v_device_id    TEXT;
  v_window       TIMESTAMPTZ := date_trunc('minute', NOW());
  v_hits         INTEGER;
  v_is_backfill  BOOLEAN;
  v_data         JSONB;
BEGIN
  -- Token validation. Superseded tokens are valid for up to 48h
  -- past superseded_at to support rotation overlap.
  v_hash := encode(digest(p_token, 'sha256'), 'hex');
  SELECT device_id
    INTO v_device_id
    FROM private.tokens
   WHERE token_hash = v_hash
     AND revoked_at IS NULL
     AND (superseded_at IS NULL
          OR superseded_at > NOW() - INTERVAL '48 hours');
  IF v_device_id IS NULL THEN
    RAISE EXCEPTION 'invalid or revoked token' USING ERRCODE = '28000';
  END IF;

  -- Device-label spoofing guard.
  IF v_device_id <> p_device THEN
    RAISE EXCEPTION 'device mismatch: token bound to %, event claims %',
      v_device_id, p_device USING ERRCODE = '28000';
  END IF;

  -- Retired-device guard. A device can be retired via admin CLI
  -- without revoking its tokens (to preserve history); explicit
  -- reject here means retired-device events never land.
  IF EXISTS (
    SELECT 1 FROM public.devices
     WHERE device_id = p_device AND retired_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'device % is retired', p_device USING ERRCODE = '28000';
  END IF;

  -- Fixed-window rate limit.
  INSERT INTO private.ingest_rate_limit (token_hash, window_start, hits)
  VALUES (v_hash, v_window, 1)
  ON CONFLICT (token_hash, window_start)
  DO UPDATE SET hits = private.ingest_rate_limit.hits + 1
  RETURNING hits INTO v_hits;

  IF v_hits > 200 THEN
    RAISE EXCEPTION 'rate limit exceeded (% hits/min)', v_hits
      USING ERRCODE = '54000';  -- program_limit_exceeded
  END IF;

  -- Timestamp bounds.
  IF p_timestamp_utc > NOW() + INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'timestamp too far in future';
  END IF;
  IF p_timestamp_utc < NOW() - INTERVAL '30 days' THEN
    RAISE EXCEPTION 'timestamp too far in past (>30 days)';
  END IF;

  v_is_backfill := p_timestamp_utc < NOW() - INTERVAL '1 day';

  -- Location precision reduction at write time.
  v_data := p_data;
  IF p_source = 'phone.location' AND v_data ? 'lat' AND v_data ? 'lng' THEN
    v_data := jsonb_set(v_data, '{lat}',
      to_jsonb(round((v_data->>'lat')::numeric, 4)));
    v_data := jsonb_set(v_data, '{lng}',
      to_jsonb(round((v_data->>'lng')::numeric, 4)));
  END IF;

  -- Update last_used_at opportunistically.
  UPDATE private.tokens SET last_used_at = NOW() WHERE token_hash = v_hash;

  -- Insert. Idempotent on retry via deterministic UUIDs.
  INSERT INTO public.events (
    id, device, source, timestamp_utc, duration_s, data, schema_version, is_backfill
  ) VALUES (
    p_id, p_device, p_source, p_timestamp_utc, p_duration_s, v_data, p_schema_version, v_is_backfill
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN p_id;
END
$function$
;

CREATE OR REPLACE FUNCTION ingest_api.accept_prompt_answer(p_token text, p_prompt_id uuid, p_answer_event_id uuid, p_data jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_hash      TEXT;
  v_device_id TEXT;
  v_kind      TEXT;
  v_source    TEXT;
BEGIN
  -- Token validation (same policy as accept_event).
  v_hash := encode(digest(p_token, 'sha256'), 'hex');
  SELECT device_id
    INTO v_device_id
    FROM private.tokens
   WHERE token_hash = v_hash
     AND revoked_at IS NULL
     AND (superseded_at IS NULL
          OR superseded_at > NOW() - INTERVAL '48 hours');
  IF v_device_id IS NULL THEN
    RAISE EXCEPTION 'invalid or revoked token' USING ERRCODE = '28000';
  END IF;

  -- Look up and lock the prompt, confirming it's still answerable.
  SELECT kind
    INTO v_kind
    FROM public.prompts
   WHERE id = p_prompt_id
     AND answered_at IS NULL
     AND dismissed_at IS NULL
     AND (expires_at IS NULL OR expires_at > NOW())
   FOR UPDATE;

  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'prompt not answerable (missing, already answered, dismissed, or expired)';
  END IF;

  v_source := 'prompt.' || v_kind;

  -- Order matters: INSERT the answer event FIRST, without ON CONFLICT,
  -- so a UUID collision raises and rolls back the whole transaction.
  -- If we did the prompt UPDATE first and INSERT second, a silent
  -- ON CONFLICT DO NOTHING would leave the prompt marked answered
  -- with no answer event on record.
  INSERT INTO public.events (
    id, device, source, timestamp_utc, duration_s, data, schema_version
  ) VALUES (
    p_answer_event_id, v_device_id, v_source, NOW(), 0, p_data, 1
  );

  UPDATE public.prompts   SET answered_at   = NOW() WHERE id = p_prompt_id;
  UPDATE private.tokens   SET last_used_at  = NOW() WHERE token_hash = v_hash;

  RETURN p_answer_event_id;
END
$function$
;

CREATE OR REPLACE FUNCTION ingest_api.pending_prompts(p_token text)
 RETURNS TABLE(id uuid, kind text, question text, context jsonb, answer_schema jsonb, created_at timestamp with time zone, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_hash      TEXT;
  v_device_id TEXT;
BEGIN
  v_hash := encode(digest(p_token, 'sha256'), 'hex');
  SELECT device_id
    INTO v_device_id
    FROM private.tokens
   WHERE token_hash = v_hash
     AND revoked_at IS NULL
     AND (superseded_at IS NULL
          OR superseded_at > NOW() - INTERVAL '48 hours');
  IF v_device_id IS NULL THEN
    RAISE EXCEPTION 'invalid or revoked token' USING ERRCODE = '28000';
  END IF;

  UPDATE private.tokens SET last_used_at = NOW() WHERE token_hash = v_hash;

  RETURN QUERY
  SELECT p.id, p.kind, p.question, p.context, p.answer_schema,
         p.created_at, p.expires_at
    FROM public.prompts p
   WHERE p.answered_at IS NULL
     AND p.dismissed_at IS NULL
     AND (p.expires_at IS NULL OR p.expires_at > NOW())
   ORDER BY p.created_at DESC
   LIMIT 50;
END
$function$
;

create schema if not exists "agent_api";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION agent_api.create_prompt(p_kind text, p_question text, p_context jsonb DEFAULT '{}'::jsonb, p_answer_schema jsonb DEFAULT NULL::jsonb, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_asked_by text DEFAULT 'agent.ad_hoc'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO public.prompts (
    id, asked_by, kind, question, context, answer_schema, expires_at
  ) VALUES (
    v_id, p_asked_by, p_kind, p_question, p_context, p_answer_schema, p_expires_at
  );
  RETURN v_id;
END
$function$
;

CREATE OR REPLACE FUNCTION agent_api.soft_delete_annotation(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.annotations
     SET deleted_at = NOW(),
         updated_at = NOW()
   WHERE id = p_id
     AND origin = 'agent'
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'annotation % not deletable by agent', p_id;
  END IF;
END
$function$
;

CREATE OR REPLACE FUNCTION agent_api.soft_delete_report(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.reports
     SET deleted_at = NOW(),
         updated_at = NOW()
   WHERE id = p_id
     AND origin = 'agent'
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'report % not deletable by agent', p_id;
  END IF;
END
$function$
;

CREATE OR REPLACE FUNCTION agent_api.upsert_annotation(p_id uuid, p_scope text, p_scope_ref text, p_body text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id UUID;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO public.annotations (id, scope, scope_ref, body, origin)
    VALUES (gen_random_uuid(), p_scope, p_scope_ref, p_body, 'agent')
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;

  UPDATE public.annotations
     SET scope      = p_scope,
         scope_ref  = p_scope_ref,
         body       = p_body,
         updated_at = NOW()
   WHERE id = p_id
     AND origin = 'agent'
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'annotation % not mutable by agent', p_id;
  END IF;
  RETURN p_id;
END
$function$
;

CREATE OR REPLACE FUNCTION agent_api.upsert_report(p_id uuid, p_title text, p_body text, p_tags text[] DEFAULT ARRAY[]::text[], p_window_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_window_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id UUID;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO public.reports (id, title, body, origin, tags, window_start, window_end)
    VALUES (gen_random_uuid(), p_title, p_body, 'agent', p_tags, p_window_start, p_window_end)
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;

  UPDATE public.reports
     SET title        = p_title,
         body         = p_body,
         tags         = p_tags,
         window_start = p_window_start,
         window_end   = p_window_end,
         updated_at   = NOW()
   WHERE id = p_id
     AND origin = 'agent'
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'report % not mutable by agent (missing, wrong origin, or deleted)', p_id;
  END IF;
  RETURN p_id;
END
$function$
;




-- ─────────────────────────────────────────────────────────────────
-- Schema USAGE + function EXECUTE grants. The declarative diff
-- tool doesn't capture these, so we append explicitly to make the
-- migration self-contained and reproducible from a fresh Supabase
-- project without relying on `--include-seed` of the schemas/ tree.
-- Mirrors 50_grants.sql.
-- ─────────────────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA ingest_api TO ingest_role;

GRANT EXECUTE ON FUNCTION ingest_api.accept_event(
    TEXT, UUID, TEXT, TEXT, TIMESTAMPTZ, DOUBLE PRECISION, JSONB, SMALLINT
  ) TO ingest_role;
GRANT EXECUTE ON FUNCTION ingest_api.accept_prompt_answer(TEXT, UUID, UUID, JSONB)
  TO ingest_role;
GRANT EXECUTE ON FUNCTION ingest_api.pending_prompts(TEXT) TO ingest_role;

GRANT USAGE ON SCHEMA public TO user_role;
GRANT USAGE ON SCHEMA public, agent_api TO agent_role;

GRANT EXECUTE ON FUNCTION agent_api.upsert_report(
    UUID, TEXT, TEXT, TEXT[], TIMESTAMPTZ, TIMESTAMPTZ
  ) TO agent_role;
GRANT EXECUTE ON FUNCTION agent_api.soft_delete_report(UUID) TO agent_role;

GRANT EXECUTE ON FUNCTION agent_api.upsert_annotation(UUID, TEXT, TEXT, TEXT)
  TO agent_role;
GRANT EXECUTE ON FUNCTION agent_api.soft_delete_annotation(UUID) TO agent_role;

GRANT EXECUTE ON FUNCTION agent_api.create_prompt(
    TEXT, TEXT, JSONB, JSONB, TIMESTAMPTZ, TEXT
  ) TO agent_role;

REVOKE ALL ON SCHEMA private FROM user_role, agent_role, anon, authenticated, PUBLIC;


-- security_invoker on events_enriched: declarative diff tool doesn't
-- capture view options, so we set it explicitly here. Makes the view
-- run with the caller's privileges (so RLS on underlying tables
-- applies to the querying role).
ALTER VIEW "public"."events_enriched" SET (security_invoker = true);
