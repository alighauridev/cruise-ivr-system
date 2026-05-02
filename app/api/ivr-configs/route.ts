import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import sql from '@/lib/db';

const ADMIN_EMAIL = 'alighauridev@gmail.com';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const leadId = searchParams.get('leadId');
  const isAdmin = session.user.email === ADMIN_EMAIL;

  let rows;
  if (isAdmin && leadId) {
    rows = await sql`
      SELECT ic.*, l.name as lead_name, u.name as owner_name, u.id as owner_user_id
      FROM ivr_configs ic
      LEFT JOIN leads l ON l.id = ic.lead_id
      JOIN users u ON u.id = ic.user_id
      WHERE ic.lead_id = ${leadId}
      ORDER BY ic.name
    `;
  } else if (isAdmin) {
    rows = await sql`
      SELECT ic.*, l.name as lead_name, u.name as owner_name, u.id as owner_user_id
      FROM ivr_configs ic
      LEFT JOIN leads l ON l.id = ic.lead_id
      JOIN users u ON u.id = ic.user_id
      ORDER BY u.name, ic.name
    `;
  } else if (leadId) {
    rows = await sql`
      SELECT * FROM ivr_configs WHERE user_id = ${session.user.id} AND lead_id = ${leadId}
      ORDER BY created_at DESC
    `;
  } else {
    rows = await sql`
      SELECT ic.*, l.name as lead_name
      FROM ivr_configs ic
      LEFT JOIN leads l ON l.id = ic.lead_id
      WHERE ic.user_id = ${session.user.id}
      ORDER BY ic.name
    `;
  }

  return NextResponse.json({ configs: rows });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { name, leadId, steps } = await req.json();
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });

  const rows = await sql`
    INSERT INTO ivr_configs (user_id, lead_id, name, steps)
    VALUES (${session.user.id}, ${leadId ?? null}, ${name}, ${JSON.stringify(steps ?? [])})
    RETURNING *
  `;

  return NextResponse.json({ config: rows[0] }, { status: 201 });
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, name, steps } = await req.json();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const rows = await sql`
    UPDATE ivr_configs
    SET name = ${name}, steps = ${JSON.stringify(steps ?? [])}, updated_at = NOW()
    WHERE id = ${id} AND user_id = ${session.user.id}
    RETURNING *
  `;

  return NextResponse.json({ config: rows[0] });
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  await sql`DELETE FROM ivr_configs WHERE id = ${id} AND user_id = ${session.user.id}`;

  return NextResponse.json({ ok: true });
}
