import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import sql from '@/lib/db';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const callId = searchParams.get('callId');
  if (!callId) return NextResponse.json({ error: 'callId required' }, { status: 400 });

  const events = await sql`
    SELECT ce.*, c.status as call_status
    FROM call_events ce
    JOIN calls c ON c.id = ce.call_id
    WHERE ce.call_id = ${callId} AND c.user_id = ${session.user.id}
    ORDER BY ce.created_at ASC
  `;

  const call = await sql`
    SELECT status, hold_duration_seconds, twilio_call_sid
    FROM calls WHERE id = ${callId} AND user_id = ${session.user.id}
    LIMIT 1
  `;

  return NextResponse.json({ events, call: call[0] ?? null });
}
