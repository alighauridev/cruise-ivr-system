-- Phase 5 migration: record which AI engine and models handled each call
-- Run once against the production database (safe to re-run).

-- e.g. "Claude claude-sonnet-5-5 · listening Deepgram nova-2-phonecall · voice Deepgram aura-2-thalia-en"
--      "OpenAI gpt-realtime-2.1 (confirmed by OpenAI) · voice coral"
ALTER TABLE calls ADD COLUMN IF NOT EXISTS ai_engine_used TEXT;
