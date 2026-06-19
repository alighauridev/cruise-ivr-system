-- Phase 3 migration: admin role + impersonation
-- Run once against the production database

-- Add an admin flag (replaces the hardcoded ADMIN_EMAIL constant in routes)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- Promote the owner account to admin
UPDATE users SET is_admin = true WHERE email = 'alighauridev@gmail.com';
