import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import sql from '@/lib/db';

export async function GET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const users = await sql`
    SELECT id, name, email, created_at
    FROM users
    ORDER BY created_at ASC
  `;

  return NextResponse.json({ users });
}
