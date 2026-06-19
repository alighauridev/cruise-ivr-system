import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';
import { getAuthContext } from '@/lib/admin';
import { endCall } from '@/lib/twilio';

export async function POST(req: NextRequest) {
  const ctx = await getAuthContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { callId } = await req.json();
  if (!callId) {
    return NextResponse.json({ error: 'callId required' }, { status: 400 });
  }

  const rows = await sql`
    SELECT * FROM calls WHERE id = ${callId} AND user_id = ${ctx.effectiveUserId} LIMIT 1
  `;

  if (rows.length === 0) {
    return NextResponse.json({ error: 'Call not found' }, { status: 404 });
  }

  const call = rows[0];

  if (call.twilio_call_sid) {
    try {
      await endCall(call.twilio_call_sid as string);
    } catch {
      // Call may already be ended
    }
  }

  await sql`
    UPDATE calls SET status = 'cancelled', updated_at = NOW() WHERE id = ${callId}
  `;

  await sql`
    INSERT INTO call_events (call_id, event_type, details)
    VALUES (${callId}, 'call_ended_by_user', '{}')
  `;

  return NextResponse.json({ ok: true });
}
