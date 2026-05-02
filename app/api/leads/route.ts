import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import sql from '@/lib/db';

const ADMIN_EMAIL = 'alighauridev@gmail.com';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const directoryId = searchParams.get('directoryId');
  const search = searchParams.get('search');
  const isAdmin = session.user.email === ADMIN_EMAIL;

  let rows;
  if (isAdmin) {
    // Admin sees all users' leads
    if (directoryId && search) {
      rows = await sql`
        SELECT l.*, d.name as directory_name, u.name as owner_name
        FROM leads l JOIN directories d ON d.id = l.directory_id JOIN users u ON u.id = l.user_id
        WHERE l.directory_id = ${directoryId}
          AND (l.name ILIKE ${'%' + search + '%'} OR l.phone_number ILIKE ${'%' + search + '%'})
        ORDER BY l.name
      `;
    } else if (directoryId) {
      rows = await sql`
        SELECT l.*, d.name as directory_name, u.name as owner_name
        FROM leads l JOIN directories d ON d.id = l.directory_id JOIN users u ON u.id = l.user_id
        WHERE l.directory_id = ${directoryId}
        ORDER BY l.name
      `;
    } else if (search) {
      rows = await sql`
        SELECT l.*, d.name as directory_name, u.name as owner_name
        FROM leads l JOIN directories d ON d.id = l.directory_id JOIN users u ON u.id = l.user_id
        WHERE l.name ILIKE ${'%' + search + '%'} OR l.phone_number ILIKE ${'%' + search + '%'}
        ORDER BY l.name
      `;
    } else {
      rows = await sql`
        SELECT l.*, d.name as directory_name, u.name as owner_name
        FROM leads l JOIN directories d ON d.id = l.directory_id JOIN users u ON u.id = l.user_id
        ORDER BY u.name, d.name, l.name
      `;
    }
  } else {
    if (directoryId && search) {
      rows = await sql`
        SELECT l.*, d.name as directory_name
        FROM leads l JOIN directories d ON d.id = l.directory_id
        WHERE l.user_id = ${session.user.id} AND l.directory_id = ${directoryId}
          AND (l.name ILIKE ${'%' + search + '%'} OR l.phone_number ILIKE ${'%' + search + '%'})
        ORDER BY l.name
      `;
    } else if (directoryId) {
      rows = await sql`
        SELECT l.*, d.name as directory_name
        FROM leads l JOIN directories d ON d.id = l.directory_id
        WHERE l.user_id = ${session.user.id} AND l.directory_id = ${directoryId}
        ORDER BY l.name
      `;
    } else if (search) {
      rows = await sql`
        SELECT l.*, d.name as directory_name
        FROM leads l JOIN directories d ON d.id = l.directory_id
        WHERE l.user_id = ${session.user.id}
          AND (l.name ILIKE ${'%' + search + '%'} OR l.phone_number ILIKE ${'%' + search + '%'})
        ORDER BY l.name
      `;
    } else {
      rows = await sql`
        SELECT l.*, d.name as directory_name
        FROM leads l JOIN directories d ON d.id = l.directory_id
        WHERE l.user_id = ${session.user.id}
        ORDER BY d.name, l.name
      `;
    }
  }

  return NextResponse.json({ leads: rows, isAdmin });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { directoryId, name, phone_number, category, notes } = await req.json();
  if (!directoryId || !name || !phone_number) {
    return NextResponse.json({ error: 'directoryId, name, phone_number are required' }, { status: 400 });
  }

  const rows = await sql`
    INSERT INTO leads (user_id, directory_id, name, phone_number, category, notes)
    VALUES (${session.user.id}, ${directoryId}, ${name}, ${phone_number}, ${category ?? null}, ${notes ?? null})
    RETURNING *
  `;

  return NextResponse.json({ lead: rows[0] }, { status: 201 });
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, name, phone_number, category, notes, ivr_config_id } = await req.json();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const isAdmin = session.user.email === ADMIN_EMAIL;
  const rows = isAdmin
    ? await sql`
        UPDATE leads
        SET name = ${name}, phone_number = ${phone_number}, category = ${category ?? null},
            notes = ${notes ?? null}, ivr_config_id = ${ivr_config_id ?? null}, updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `
    : await sql`
        UPDATE leads
        SET name = ${name}, phone_number = ${phone_number}, category = ${category ?? null},
            notes = ${notes ?? null}, ivr_config_id = ${ivr_config_id ?? null}, updated_at = NOW()
        WHERE id = ${id} AND user_id = ${session.user.id}
        RETURNING *
      `;

  return NextResponse.json({ lead: rows[0] });
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const isAdmin = session.user.email === ADMIN_EMAIL;
  if (isAdmin) {
    await sql`DELETE FROM leads WHERE id = ${id}`;
  } else {
    await sql`DELETE FROM leads WHERE id = ${id} AND user_id = ${session.user.id}`;
  }

  return NextResponse.json({ ok: true });
}
