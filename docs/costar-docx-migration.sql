-- ============================================================================
-- CoStar comp parser + Word-doc ingestion — schema (July 2026 briefs)
-- Run in the Supabase SQL editor (DDL cannot run through PostgREST).
-- Idempotent: safe to re-run. Code degrades gracefully until this runs
-- (parse endpoints return a clear "table missing — run migration" error).
-- ============================================================================

-- Sale comps extracted from CoStar PDFs
create table if not exists costar_sale_comps (
  id                bigserial primary key,
  telegram_chat_id  text not null,
  org_id            text,
  property_key      text not null,          -- normalized subject property key
  comp_number       int,                    -- position in the CoStar report (1, 2, 3...)
  property_name     text,
  address           text not null,
  city_state_zip    text,
  submarket         text,
  property_type     text,
  sale_date         text,
  sale_price        text,
  price_per_unit    text,
  price_per_sf      text,
  units             text,
  gba_sf            text,
  cap_rate          text,
  pro_forma_cap     text,
  year_built        text,
  land_area         text,
  sale_comp_id      text,
  sale_comp_status  text,
  parcel_numbers    text,
  broker_notes      text,
  photo_base64      text,
  created_at        timestamptz not null default now()
);

-- Rent comps extracted from CoStar PDFs
create table if not exists costar_rent_comps (
  id                bigserial primary key,
  telegram_chat_id  text not null,
  org_id            text,
  property_key      text not null,
  comp_number       int,
  property_name     text,
  address           text not null,
  city_state_zip    text,
  submarket         text,
  property_type     text,
  year_built        text,
  units             text,
  avg_sf            text,
  vacancy_pct       text,
  studio_rent       text,
  one_br_rent       text,
  two_br_rent       text,
  asking_rent_per_unit text,
  rent_per_sf       text,
  stories           text,
  elevators         text,
  photo_base64      text,
  broker_notes      text,
  created_at        timestamptz not null default now()
);

create index if not exists idx_sale_comps_chat_key on costar_sale_comps (telegram_chat_id, property_key);
create index if not exists idx_rent_comps_chat_key on costar_rent_comps (telegram_chat_id, property_key);

-- Word-doc drafts (OM and Proposal in ONE table — the brief's proposal_records
-- covered only proposals while OM storage was left "for now" against an
-- om_records table that does not exist in this project; a single doc_type'd
-- table serves both types with one retrieval path).
create table if not exists docx_drafts (
  id               bigserial primary key,
  telegram_chat_id text not null,
  org_id           text,
  property_key     text not null,
  doc_type         text not null,            -- 'om' | 'proposal'
  property_name    text,
  property_address text,
  payload_json     jsonb not null,
  photo_slots      int default 0,            -- "PHOTO PLACEHOLDER" count found in the doc
  status           text not null default 'draft',   -- 'draft' | 'generated' | 'archived'
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists idx_docx_chat_key on docx_drafts (telegram_chat_id, property_key);

-- Session additions: the active property key (links uploads to a property) and
-- the storage path of a CoStar PDF parked while we ask which property it's for.
alter table telegram_sessions add column if not exists last_property_key text;
alter table telegram_sessions add column if not exists pending_costar_path text;
