-- Phase 2 migration: AI conversation mode
-- Run once against the production database

-- Add ai_task column to store the user's typed task/goal
ALTER TABLE calls ADD COLUMN IF NOT EXISTS ai_task TEXT;

-- Extend the status CHECK constraint to include 'ai_conversation'
ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_status_check;
ALTER TABLE calls ADD CONSTRAINT calls_status_check CHECK (
  status IN (
    'initiating', 'navigating_ivr', 'on_hold',
    'agent_detected', 'ai_conversation',
    'transferring', 'connected', 'completed', 'failed', 'cancelled'
  )
);
