import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import sql from '@/lib/db';

const ADMIN_EMAIL = 'alighauridev@gmail.com';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status');
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '25'), 100);
  const offset = parseInt(searchParams.get('offset') ?? '0');
  const isAdmin = session.user.email === ADMIN_EMAIL;

  const [rows, countRows] = await Promise.all([
    isAdmin
      ? status
        ? sql`
            SELECT c.*, l.name as lead_name, l.phone_number as lead_phone, u.name as owner_name, u.email as owner_email
            FROM calls c
            LEFT JOIN leads l ON l.id = c.lead_id
            JOIN users u ON u.id = c.user_id
            WHERE c.status = ${status}
            ORDER BY c.created_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `
        : sql`
            SELECT c.*, l.name as lead_name, l.phone_number as lead_phone, u.name as owner_name, u.email as owner_email
            FROM calls c
            LEFT JOIN leads l ON l.id = c.lead_id
            JOIN users u ON u.id = c.user_id
            ORDER BY c.created_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `
      : status
        ? sql`
            SELECT c.*, l.name as lead_name, l.phone_number as lead_phone
            FROM calls c
            LEFT JOIN leads l ON l.id = c.lead_id
            WHERE c.user_id = ${session.user.id} AND c.status = ${status}
            ORDER BY c.created_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `
        : sql`
            SELECT c.*, l.name as lead_name, l.phone_number as lead_phone
            FROM calls c
            LEFT JOIN leads l ON l.id = c.lead_id
            WHERE c.user_id = ${session.user.id}
            ORDER BY c.created_at DESC
            LIMIT ${limit} OFFSET ${offset}
          `,
    isAdmin
      ? status
        ? sql`SELECT COUNT(*)::int AS total FROM calls WHERE status = ${status}`
        : sql`SELECT COUNT(*)::int AS total FROM calls`
      : status
        ? sql`SELECT COUNT(*)::int AS total FROM calls WHERE user_id = ${session.user.id} AND status = ${status}`
        : sql`SELECT COUNT(*)::int AS total FROM calls WHERE user_id = ${session.user.id}`,
  ]);

  return NextResponse.json({ calls: rows, total: countRows[0]?.total ?? 0, limit, offset, isAdmin });
}
