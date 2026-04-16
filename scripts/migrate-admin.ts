import sql from '../lib/db';

await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE`;
await sql`UPDATE users SET is_admin = TRUE WHERE email = 'alighauriai@gmail.com'`;
const rows = await sql`SELECT email, is_admin FROM users`;
console.log('Users:', JSON.stringify(rows, null, 2));
await sql.end();
process.exit(0);
