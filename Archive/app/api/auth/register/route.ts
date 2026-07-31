import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import sql from '@/lib/db';

export async function POST(req: NextRequest) {
  const { email, name, password } = await req.json();

  if (!email || !name || !password) {
    return NextResponse.json({ error: 'email, name, password are required' }, { status: 400 });
  }

  const existing = await sql`SELECT id FROM users WHERE email = ${email} LIMIT 1`;
  if (existing.length > 0) {
    return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
  }

  const hash = await bcrypt.hash(password, 12);
  const rows = await sql`
    INSERT INTO users (email, name, password_hash, transfer_phone)
    VALUES (${email}, ${name}, ${hash}, ${process.env.DEFAULT_TRANSFER_NUMBER ?? null})
    RETURNING id, email, name
  `;

  // Create default directory
  await sql`
    INSERT INTO directories (user_id, name, description)
    VALUES (${rows[0].id as string}, 'Cruise Lines', 'Major cruise line reservation numbers')
  `;

  return NextResponse.json({ user: rows[0] }, { status: 201 });
}
