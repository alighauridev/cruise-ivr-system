-- CruisePro IVR System - Database Schema

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  transfer_phone VARCHAR(50),
  notification_preference VARCHAR(20) DEFAULT 'sms' CHECK (notification_preference IN ('sms', 'push', 'both')),
  notification_phone VARCHAR(50),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Directories table
CREATE TABLE IF NOT EXISTS directories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- IVR Configs table (defined before leads due to FK)
CREATE TABLE IF NOT EXISTS ivr_configs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id UUID,
  name VARCHAR(255) NOT NULL,
  steps JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Leads table
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  directory_id UUID NOT NULL REFERENCES directories(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  phone_number VARCHAR(50) NOT NULL,
  category VARCHAR(100),
  ivr_config_id UUID REFERENCES ivr_configs(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add FK from ivr_configs to leads
ALTER TABLE ivr_configs ADD CONSTRAINT fk_ivr_configs_lead
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;

-- Calls table
CREATE TABLE IF NOT EXISTS calls (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  twilio_call_sid VARCHAR(100) UNIQUE,
  status VARCHAR(50) NOT NULL DEFAULT 'initiating' CHECK (
    status IN ('initiating', 'navigating_ivr', 'on_hold', 'agent_detected', 'transferring', 'connected', 'completed', 'failed', 'cancelled')
  ),
  cruise_line_number VARCHAR(50),
  transfer_number VARCHAR(50),
  ivr_config_id UUID REFERENCES ivr_configs(id) ON DELETE SET NULL,
  hold_start_time TIMESTAMP WITH TIME ZONE,
  agent_detected_time TIMESTAMP WITH TIME ZONE,
  hold_duration_seconds INTEGER,
  total_duration_seconds INTEGER,
  recording_url VARCHAR(500),
  transcript JSONB,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Call Events table
CREATE TABLE IF NOT EXISTS call_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  call_id UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  event_type VARCHAR(100) NOT NULL,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Settings table
CREATE TABLE IF NOT EXISTS settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key VARCHAR(100) NOT NULL,
  value TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, key)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_leads_user_id ON leads(user_id);
CREATE INDEX IF NOT EXISTS idx_leads_directory_id ON leads(directory_id);
CREATE INDEX IF NOT EXISTS idx_calls_user_id ON calls(user_id);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);
CREATE INDEX IF NOT EXISTS idx_calls_created_at ON calls(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_events_call_id ON call_events(call_id);

-- Seed data: default directory and cruise lines (run after user creation)
-- See seed.sql for seed data
