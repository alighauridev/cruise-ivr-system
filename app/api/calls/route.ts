import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';
import { getAuthContext } from '@/lib/admin';

export async function GET(req: NextRequest) {
  const ctx = await getAuthContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status');
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '25'), 100);
  const offset = parseInt(searchParams.get('offset') ?? '0');
  const userId = ctx.effectiveUserId;

  const [rows, countRows] = await Promise.all([
    status
      ? sql`
          SELECT c.*, l.name as lead_name, l.phone_number as lead_phone
          FROM calls c
          LEFT JOIN leads l ON l.id = c.lead_id
          WHERE c.user_id = ${userId} AND c.status = ${status}
          ORDER BY c.created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `
      : sql`
          SELECT c.*, l.name as lead_name, l.phone_number as lead_phone
          FROM calls c
          LEFT JOIN leads l ON l.id = c.lead_id
          WHERE c.user_id = ${userId}
          ORDER BY c.created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `,
    status
      ? sql`SELECT COUNT(*)::int AS total FROM calls WHERE user_id = ${userId} AND status = ${status}`
      : sql`SELECT COUNT(*)::int AS total FROM calls WHERE user_id = ${userId}`,
  ]);

  return NextResponse.json({
    calls: rows,
    total: countRows[0]?.total ?? 0,
    limit,
    offset,
    isAdmin: ctx.isAdmin,
    impersonating: ctx.impersonating,
  });
}
