-- Phase 4 migration: AI call agent rebuild
-- Run once against the production database (safe to re-run).

-- Structured task form (booking number, guest, request, what the AI may agree to, etc.)
ALTER TABLE calls ADD COLUMN IF NOT EXISTS ai_task_details JSONB;

-- Outcome written when the AI ends or hands off the call
ALTER TABLE calls ADD COLUMN IF NOT EXISTS ai_outcome VARCHAR(30);
ALTER TABLE calls ADD COLUMN IF NOT EXISTS ai_summary TEXT;
