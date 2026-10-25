import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';
import { getAuthContext } from '@/lib/admin';

// Saves the agency ID (IATA/CLIA) used when calling one cruise line (lead). Empty clears it.
export async function PUT(req: NextRequest) {
  const ctx = await getAuthContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { leadId, agencyId } = await req.json();
  if (!leadId || typeof leadId !== 'string') {
    return NextResponse.json({ error: 'leadId is required' }, { status: 400 });
  }
  const ownerId = ctx.effectiveUserId;
  const owned = await sql`SELECT 1 FROM leads WHERE id = ${leadId} AND user_id = ${ownerId} LIMIT 1`;
  if (owned.length === 0) return NextResponse.json({ error: 'Lead not found' }, { status: 404 });

  const key = `agency_id:${leadId}`;
  const value = typeof agencyId === 'string' ? agencyId.trim().slice(0, 1000) : '';
  if (!value) {
    await sql`DELETE FROM settings WHERE user_id = ${ownerId} AND key = ${key}`;
  } else {
    await sql`
      INSERT INTO settings (user_id, key, value)
      VALUES (${ownerId}, ${key}, ${value})
      ON CONFLICT (user_id, key) DO UPDATE SET value = ${value}, updated_at = NOW()
    `;
  }
  return NextResponse.json({ ok: true });
}
