import { NextResponse } from 'next/server';
import sql from '@/lib/db';

// Public endpoint — returns basic user info for the login page profile picker
export async function GET() {
  const users = await sql`
    SELECT id, name, email
    FROM users
    ORDER BY created_at ASC
  `;
  return NextResponse.json({ users });
}
