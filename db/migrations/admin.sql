ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Mark the platform owner as admin
UPDATE users SET is_admin = TRUE WHERE email = 'alighauriai@gmail.com';
