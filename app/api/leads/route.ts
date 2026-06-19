import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';
import { getAuthContext } from '@/lib/admin';

export async function GET(req: NextRequest) {
  const ctx = await getAuthContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const directoryId = searchParams.get('directoryId');
  const search = searchParams.get('search');
  const userId = ctx.effectiveUserId;

  let rows;
  if (directoryId && search) {
    rows = await sql`
      SELECT l.*, d.name as directory_name
      FROM leads l JOIN directories d ON d.id = l.directory_id
      WHERE l.user_id = ${userId} AND l.directory_id = ${directoryId}
        AND (l.name ILIKE ${'%' + search + '%'} OR l.phone_number ILIKE ${'%' + search + '%'})
      ORDER BY l.name
    `;
  } else if (directoryId) {
    rows = await sql`
      SELECT l.*, d.name as directory_name
      FROM leads l JOIN directories d ON d.id = l.directory_id
      WHERE l.user_id = ${userId} AND l.directory_id = ${directoryId}
      ORDER BY l.name
    `;
  } else if (search) {
    rows = await sql`
      SELECT l.*, d.name as directory_name
      FROM leads l JOIN directories d ON d.id = l.directory_id
      WHERE l.user_id = ${userId}
        AND (l.name ILIKE ${'%' + search + '%'} OR l.phone_number ILIKE ${'%' + search + '%'})
      ORDER BY l.name
    `;
  } else {
    rows = await sql`
      SELECT l.*, d.name as directory_name
      FROM leads l JOIN directories d ON d.id = l.directory_id
      WHERE l.user_id = ${userId}
      ORDER BY d.name, l.name
    `;
  }

  return NextResponse.json({ leads: rows, isAdmin: ctx.isAdmin, impersonating: ctx.impersonating });
}

export async function POST(req: NextRequest) {
  const ctx = await getAuthContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { directoryId, name, phone_number, category, notes } = await req.json();
  if (!directoryId || !name || !phone_number) {
    return NextResponse.json({ error: 'directoryId, name, phone_number are required' }, { status: 400 });
  }

  const rows = await sql`
    INSERT INTO leads (user_id, directory_id, name, phone_number, category, notes)
    VALUES (${ctx.effectiveUserId}, ${directoryId}, ${name}, ${phone_number}, ${category ?? null}, ${notes ?? null})
    RETURNING *
  `;

  return NextResponse.json({ lead: rows[0] }, { status: 201 });
}

export async function PUT(req: NextRequest) {
  const ctx = await getAuthContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, name, phone_number, category, notes, ivr_config_id } = await req.json();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const rows = await sql`
    UPDATE leads
    SET name = ${name}, phone_number = ${phone_number}, category = ${category ?? null},
        notes = ${notes ?? null}, ivr_config_id = ${ivr_config_id ?? null}, updated_at = NOW()
    WHERE id = ${id} AND user_id = ${ctx.effectiveUserId}
    RETURNING *
  `;

  return NextResponse.json({ lead: rows[0] });
}

export async function DELETE(req: NextRequest) {
  const ctx = await getAuthContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  await sql`DELETE FROM leads WHERE id = ${id} AND user_id = ${ctx.effectiveUserId}`;

  return NextResponse.json({ ok: true });
}
