
  create table "public"."events" (
    "id" uuid not null,
    "device" text not null,
    "source" text not null,
    "timestamp_utc" timestamp with time zone not null,
    "duration_s" double precision not null,
    "data" jsonb not null,
    "schema_version" smallint not null default 1,
    "received_at" timestamp with time zone not null default now()
      );


alter table "public"."events" enable row level security;


  create table "public"."source_tags" (
    "device" text not null,
    "source" text not null,
    "tag" text not null,
    "created_at" timestamp with time zone not null default now()
      );


alter table "public"."source_tags" enable row level security;

CREATE INDEX events_device_source_time ON public.events USING btree (device, source, timestamp_utc);

CREATE UNIQUE INDEX events_pkey ON public.events USING btree (id);

CREATE INDEX events_time_desc ON public.events USING btree (timestamp_utc DESC);

CREATE UNIQUE INDEX source_tags_pkey ON public.source_tags USING btree (device, source, tag);

alter table "public"."events" add constraint "events_pkey" PRIMARY KEY using index "events_pkey";

alter table "public"."source_tags" add constraint "source_tags_pkey" PRIMARY KEY using index "source_tags_pkey";

alter table "public"."events" add constraint "events_device_nonempty" CHECK ((length(btrim(device)) > 0)) not valid;

alter table "public"."events" validate constraint "events_device_nonempty";

alter table "public"."events" add constraint "events_duration_nonneg" CHECK ((duration_s >= (0)::double precision)) not valid;

alter table "public"."events" validate constraint "events_duration_nonneg";

alter table "public"."events" add constraint "events_source_nonempty" CHECK ((length(btrim(source)) > 0)) not valid;

alter table "public"."events" validate constraint "events_source_nonempty";

alter table "public"."source_tags" add constraint "source_tags_device_nonempty" CHECK ((length(btrim(device)) > 0)) not valid;

alter table "public"."source_tags" validate constraint "source_tags_device_nonempty";

alter table "public"."source_tags" add constraint "source_tags_source_nonempty" CHECK ((length(btrim(source)) > 0)) not valid;

alter table "public"."source_tags" validate constraint "source_tags_source_nonempty";

alter table "public"."source_tags" add constraint "source_tags_tag_nonempty" CHECK ((length(btrim(tag)) > 0)) not valid;

alter table "public"."source_tags" validate constraint "source_tags_tag_nonempty";

grant delete on table "public"."events" to "anon";

grant insert on table "public"."events" to "anon";

grant references on table "public"."events" to "anon";

grant select on table "public"."events" to "anon";

grant trigger on table "public"."events" to "anon";

grant truncate on table "public"."events" to "anon";

grant update on table "public"."events" to "anon";

grant delete on table "public"."events" to "authenticated";

grant insert on table "public"."events" to "authenticated";

grant references on table "public"."events" to "authenticated";

grant select on table "public"."events" to "authenticated";

grant trigger on table "public"."events" to "authenticated";

grant truncate on table "public"."events" to "authenticated";

grant update on table "public"."events" to "authenticated";

grant delete on table "public"."events" to "service_role";

grant insert on table "public"."events" to "service_role";

grant references on table "public"."events" to "service_role";

grant select on table "public"."events" to "service_role";

grant trigger on table "public"."events" to "service_role";

grant truncate on table "public"."events" to "service_role";

grant update on table "public"."events" to "service_role";

grant delete on table "public"."source_tags" to "anon";

grant insert on table "public"."source_tags" to "anon";

grant references on table "public"."source_tags" to "anon";

grant select on table "public"."source_tags" to "anon";

grant trigger on table "public"."source_tags" to "anon";

grant truncate on table "public"."source_tags" to "anon";

grant update on table "public"."source_tags" to "anon";

grant delete on table "public"."source_tags" to "authenticated";

grant insert on table "public"."source_tags" to "authenticated";

grant references on table "public"."source_tags" to "authenticated";

grant select on table "public"."source_tags" to "authenticated";

grant trigger on table "public"."source_tags" to "authenticated";

grant truncate on table "public"."source_tags" to "authenticated";

grant update on table "public"."source_tags" to "authenticated";

grant delete on table "public"."source_tags" to "service_role";

grant insert on table "public"."source_tags" to "service_role";

grant references on table "public"."source_tags" to "service_role";

grant select on table "public"."source_tags" to "service_role";

grant trigger on table "public"."source_tags" to "service_role";

grant truncate on table "public"."source_tags" to "service_role";

grant update on table "public"."source_tags" to "service_role";

create schema if not exists "private";


  create table "private"."tokens" (
    "token_hash" text not null,
    "token_prefix" text not null,
    "device_label" text not null,
    "note" text,
    "created_at" timestamp with time zone not null default now(),
    "last_used_at" timestamp with time zone,
    "revoked_at" timestamp with time zone
      );


alter table "private"."tokens" enable row level security;

CREATE INDEX tokens_active ON private.tokens USING btree (token_hash) WHERE (revoked_at IS NULL);

CREATE INDEX tokens_device_label ON private.tokens USING btree (device_label);

CREATE UNIQUE INDEX tokens_pkey ON private.tokens USING btree (token_hash);

alter table "private"."tokens" add constraint "tokens_pkey" PRIMARY KEY using index "tokens_pkey";

alter table "private"."tokens" add constraint "tokens_device_label_nonempty" CHECK ((length(btrim(device_label)) > 0)) not valid;

alter table "private"."tokens" validate constraint "tokens_device_label_nonempty";

alter table "private"."tokens" add constraint "tokens_hash_looks_like_sha256" CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text)) not valid;

alter table "private"."tokens" validate constraint "tokens_hash_looks_like_sha256";

alter table "private"."tokens" add constraint "tokens_prefix_nonempty" CHECK ((length(btrim(token_prefix)) > 0)) not valid;

alter table "private"."tokens" validate constraint "tokens_prefix_nonempty";


