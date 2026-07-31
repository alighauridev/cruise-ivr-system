import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import sql from '@/lib/db';
import { getAuthContext, IMPERSONATE_COOKIE } from '@/lib/admin';

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  secure: process.env.NODE_ENV === 'production',
};

// Start impersonating a user (admin only).
export async function POST(req: NextRequest) {
  const ctx = await getAuthContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!ctx.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { userId } = await req.json();
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

  const rows = await sql`SELECT id, name, email FROM users WHERE id = ${userId} LIMIT 1`;
  if (rows.length === 0) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const store = await cookies();
  if (userId === ctx.realUserId) {
    // Acting as self == exit impersonation.
    store.delete(IMPERSONATE_COOKIE);
  } else {
    store.set(IMPERSONATE_COOKIE, userId, COOKIE_OPTS);
  }

  return NextResponse.json({ ok: true, actingAs: rows[0] });
}

// Stop impersonating (admin only).
export async function DELETE() {
  const ctx = await getAuthContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!ctx.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  (await cookies()).delete(IMPERSONATE_COOKIE);
  return NextResponse.json({ ok: true });
}
