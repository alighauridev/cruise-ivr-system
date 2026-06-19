import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';
import { getAuthContext } from '@/lib/admin';
import { pressDigitOnCall } from '@/server/media-ws';

export async function POST(req: NextRequest) {
  const ctx = await getAuthContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { callId, digit } = await req.json();
  if (!callId || !digit) return NextResponse.json({ error: 'callId and digit required' }, { status: 400 });

  const safeDigit = String(digit).charAt(0);
  if (!/^[0-9*#]$/.test(safeDigit)) {
    return NextResponse.json({ error: 'Invalid digit — must be 0-9, *, or #' }, { status: 400 });
  }

  const rows = await sql`
    SELECT id, status FROM calls
    WHERE id = ${callId} AND user_id = ${ctx.effectiveUserId}
    LIMIT 1
  `;
  if (rows.length === 0) return NextResponse.json({ error: 'Call not found' }, { status: 404 });

  const { status } = rows[0];
  if (!['navigating_ivr', 'on_hold', 'agent_detected'].includes(status as string)) {
    return NextResponse.json({ error: `Cannot press digit in call status: ${status}` }, { status: 400 });
  }

  const result = await pressDigitOnCall(callId, safeDigit);
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 503 });
  }

  return NextResponse.json({ ok: true, digit: safeDigit });
}
