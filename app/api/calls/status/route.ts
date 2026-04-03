import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const callSid = formData.get('CallSid') as string;
  const callStatus = formData.get('CallStatus') as string;
  const callDuration = formData.get('CallDuration') as string;

  if (!callSid) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const rows = await sql`SELECT id, status FROM calls WHERE twilio_call_sid = ${callSid} LIMIT 1`;
  if (rows.length === 0) {
    return NextResponse.json({ ok: true });
  }

  const call = rows[0];
  const callId = call.id as string;

  // Map Twilio status to our status
  let newStatus: string | null = null;
  if (callStatus === 'completed' || callStatus === 'busy' || callStatus === 'no-answer') {
    newStatus = (call.status as string) === 'connected' ? 'completed' :
                callStatus === 'completed' ? 'completed' : 'failed';
  } else if (callStatus === 'failed' || callStatus === 'canceled') {
    newStatus = 'cancelled';
  }

  if (newStatus) {
    await sql`
      UPDATE calls
      SET status = ${newStatus},
          total_duration_seconds = ${callDuration ? parseInt(callDuration) : null},
          updated_at = NOW()
      WHERE id = ${callId}
    `;
  }

  await sql`
    INSERT INTO call_events (call_id, event_type, details)
    VALUES (${callId}, 'twilio_status', ${JSON.stringify({ callStatus, callDuration })})
  `;

  return NextResponse.json({ ok: true });
}
