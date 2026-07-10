-- ============================================================================
-- Orion Commercial Partners — org hierarchy migration (brief §8, July 2026)
-- Run in the Supabase SQL editor (DDL cannot run through PostgREST).
-- Idempotent: safe to re-run.
--
-- NOTE (deviation from brief §1): the flat `brokers` table did NOT exist in this
-- project, so this migration creates it. The §1 flat single-row insert is
-- superseded by the §8 org hierarchy below — inserting both would duplicate
-- Matthew Hinrichs. Brand config, logo, and the bot token live on the ORG row;
-- the four broker rows carry contact info only.
--
-- The pipeline works BEFORE this runs (webhook/generate-pdf fall back to the
-- same Orion defaults baked into the code); running it makes the brand DB-driven.
-- ============================================================================

-- 8a. orgs — one row per firm; ONE Telegram bot token for the whole firm
CREATE TABLE IF NOT EXISTS orgs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_name           text NOT NULL,
  firm_address       text,
  firm_website       text,
  logo_url           text,
  brand_config       jsonb,
  telegram_bot_token text UNIQUE,
  subscription_tier  text DEFAULT 'firm',   -- 'solo' | 'team' | 'firm' | 'enterprise'
  active             boolean DEFAULT true,
  created_at         timestamptz DEFAULT now()
);

-- 8b. brokers — created here (did not previously exist). org_id nullable: solo
-- brokers (Jessie) have no org and keep their token on their own row.
CREATE TABLE IF NOT EXISTS brokers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid REFERENCES orgs(id),
  telegram_bot_token text UNIQUE,
  broker_name        text NOT NULL,
  broker_email       text,
  broker_phone       text,
  firm_name          text,
  firm_address       text,
  firm_website       text,
  logo_url           text,
  headshot_url       text,
  brand_config       jsonb,
  active             boolean DEFAULT true,
  created_at         timestamptz DEFAULT now()
);

-- 8c. Orion org row (logo already uploaded to storage — URL below is live)
INSERT INTO orgs (org_name, firm_address, firm_website, logo_url, brand_config, telegram_bot_token, subscription_tier, active)
SELECT
  'Orion Commercial Partners',
  '1218 Third Avenue, Suite 2200, Seattle, WA 98101',
  'www.orioncp.com',
  'https://rnswcjeqbnmuretlukvw.supabase.co/storage/v1/object/public/brokeros-photos/broker-branding/orion-logo.png',
  '{
    "primary_color": "#D9591B",
    "secondary_color": "#3a3a3a",
    "font_heading": "Instrument Serif",
    "font_body": "Helvetica Neue, Arial",
    "doc_types": ["flyer"],
    "dot_pattern": "orion",
    "co_brokers": [
      {"name": "Chase Silver",      "phone": "425.326.0766", "email": "csilver@orioncp.com"},
      {"name": "Matthew Hinrichs",  "phone": "206.852.3325", "email": "mhinrichs@orioncp.com"},
      {"name": "Jack Deane",        "phone": "206.707.1315", "email": "jdeane@orioncp.com"},
      {"name": "Bojidar Gabrovski", "phone": "847.275.8474", "email": "bgabrovski@orioncp.com"}
    ]
  }'::jsonb,
  'ORION_BOT_TOKEN_PLACEHOLDER',   -- Joe: replace after creating the bot in BotFather (see below)
  'firm',
  true
WHERE NOT EXISTS (SELECT 1 FROM orgs WHERE org_name = 'Orion Commercial Partners');

-- 8d. Orion broker rows — all under the same org
DO $$
DECLARE orion_org_id uuid;
BEGIN
  SELECT id INTO orion_org_id FROM orgs WHERE org_name = 'Orion Commercial Partners';

  INSERT INTO brokers (org_id, broker_name, broker_email, broker_phone, active)
  SELECT orion_org_id, v.name, v.email, v.phone, true
  FROM (VALUES
    ('Matthew Hinrichs',  'mhinrichs@orioncp.com',  '206.852.3325'),
    ('Chase Silver',      'csilver@orioncp.com',    '425.326.0766'),
    ('Jack Deane',        'jdeane@orioncp.com',     '206.707.1315'),
    ('Bojidar Gabrovski', 'bgabrovski@orioncp.com', '847.275.8474')
  ) AS v(name, email, phone)
  WHERE NOT EXISTS (
    SELECT 1 FROM brokers b WHERE b.org_id = orion_org_id AND b.broker_email = v.email
  );
END $$;

-- After creating the Orion bot in BotFather:
-- UPDATE orgs SET telegram_bot_token = 'REAL_TOKEN_HERE'
-- WHERE org_name = 'Orion Commercial Partners';
