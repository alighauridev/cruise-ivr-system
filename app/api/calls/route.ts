import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import sql from '@/lib/db';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status');
  const limit = parseInt(searchParams.get('limit') ?? '50');
  const offset = parseInt(searchParams.get('offset') ?? '0');
  // viewAs: admin can view another user's data
  const viewAs = searchParams.get('viewAs') ?? session.user.id;

  let rows;
  if (status) {
    rows = await sql`
      SELECT c.*, l.name as lead_name, l.phone_number as lead_phone
      FROM calls c
      LEFT JOIN leads l ON l.id = c.lead_id
      WHERE c.user_id = ${viewAs} AND c.status = ${status}
      ORDER BY c.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    rows = await sql`
      SELECT c.*, l.name as lead_name, l.phone_number as lead_phone
      FROM calls c
      LEFT JOIN leads l ON l.id = c.lead_id
      WHERE c.user_id = ${viewAs}
      ORDER BY c.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  return NextResponse.json({ calls: rows });
}
