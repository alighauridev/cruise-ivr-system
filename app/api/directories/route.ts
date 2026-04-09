import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import sql from '@/lib/db';
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const viewAs = searchParams.get('viewAs') ?? session.user.id;

  const rows = await sql`
    SELECT d.*, COUNT(l.id)::INTEGER as lead_count
    FROM directories d
    LEFT JOIN leads l ON l.directory_id = d.id
    WHERE d.user_id = ${viewAs}
    GROUP BY d.id
    ORDER BY d.name
  `;

  return NextResponse.json({ directories: rows });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { name, description } = await req.json();
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });

  const rows = await sql`
    INSERT INTO directories (user_id, name, description)
    VALUES (${session.user.id}, ${name}, ${description ?? null})
    RETURNING *
  `;

  return NextResponse.json({ directory: rows[0] }, { status: 201 });
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, name, description } = await req.json();
  if (!id || !name) return NextResponse.json({ error: 'id and name required' }, { status: 400 });

  const rows = await sql`
    UPDATE directories SET name = ${name}, description = ${description ?? null}, updated_at = NOW()
    WHERE id = ${id} AND user_id = ${session.user.id}
    RETURNING *
  `;

  return NextResponse.json({ directory: rows[0] });
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  await sql`DELETE FROM directories WHERE id = ${id} AND user_id = ${session.user.id}`;

  return NextResponse.json({ ok: true });
}
