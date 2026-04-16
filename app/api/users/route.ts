import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import sql from '@/lib/db';

export async function GET() {
  const session = await auth();
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin;
  if (!isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const users = await sql`
    SELECT id, name, email, created_at
    FROM users
    ORDER BY created_at ASC
  `;
  return NextResponse.json({ users });
}
