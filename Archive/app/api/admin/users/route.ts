import { NextResponse } from 'next/server';
import sql from '@/lib/db';
import { getAuthContext } from '@/lib/admin';

// List all users (admin only) for the impersonation switcher.
export async function GET() {
  const ctx = await getAuthContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!ctx.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const users = await sql`
    SELECT
      u.id,
      u.name,
      u.email,
      u.is_admin,
      (SELECT COUNT(*)::INTEGER FROM leads l WHERE l.user_id = u.id) AS lead_count,
      (SELECT COUNT(*)::INTEGER FROM calls c WHERE c.user_id = u.id) AS call_count
    FROM users u
    ORDER BY u.is_admin DESC, u.name
  `;

  return NextResponse.json({ users });
}
