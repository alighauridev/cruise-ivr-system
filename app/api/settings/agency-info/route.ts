import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';
import { getAuthContext } from '@/lib/admin';

// Saves the agency info / standing answers the AI can use on every call. Empty clears it.
export async function PUT(req: NextRequest) {
  const ctx = await getAuthContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { agencyInfo } = await req.json();
  const ownerId = ctx.effectiveUserId;
  const value = typeof agencyInfo === 'string' ? agencyInfo.trim().slice(0, 4000) : '';
  if (!value) {
    await sql`DELETE FROM settings WHERE user_id = ${ownerId} AND key = 'agency_info'`;
  } else {
    await sql`
      INSERT INTO settings (user_id, key, value)
      VALUES (${ownerId}, 'agency_info', ${value})
      ON CONFLICT (user_id, key) DO UPDATE SET value = ${value}, updated_at = NOW()
    `;
  }
  return NextResponse.json({ ok: true });
}
