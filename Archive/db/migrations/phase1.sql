-- Phase 1 feature migration
-- Run once against the production database

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS transfer_numbers JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS connect_message   TEXT;

-- Seed transfer_numbers from existing transfer_phone so nothing breaks
UPDATE users
SET transfer_numbers = jsonb_build_array(
  jsonb_build_object(
    'id',        gen_random_uuid()::text,
    'name',      'Default',
    'phone',     transfer_phone,
    'isDefault', true
  )
)
WHERE transfer_phone IS NOT NULL
  AND transfer_phone <> ''
  AND transfer_numbers = '[]'::jsonb;
