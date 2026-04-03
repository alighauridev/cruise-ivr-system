import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import sql from '@/lib/db';
import { twilioClient, twilioPhone } from '@/lib/twilio';

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { callId } = await req.json();
  if (!callId) {
    return NextResponse.json({ error: 'callId required' }, { status: 400 });
  }

  const rows = await sql`
    SELECT * FROM calls WHERE id = ${callId} AND user_id = ${session.user.id} LIMIT 1
  `;

  if (rows.length === 0) {
    return NextResponse.json({ error: 'Call not found' }, { status: 404 });
  }

  const call = rows[0];

  if (!['agent_detected', 'on_hold'].includes(call.status as string)) {
    return NextResponse.json({ error: `Cannot transfer call in status: ${call.status}` }, { status: 400 });
  }

  try {
    const transferNumber = call.transfer_number as string;
    const baseUrl = (process.env.PUBLIC_URL ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3003');
    const conferenceRoom = `CruisePro-${callId}`;

    // Move cruise line call into conference
    await twilioClient.calls(call.twilio_call_sid as string).update({
      twiml: `<Response>
  <Dial>
    <Conference>${conferenceRoom}</Conference>
  </Dial>
</Response>`,
    });

    // Call the customer and add them to the conference
    await twilioClient.calls.create({
      to: transferNumber,
      from: twilioPhone,
      twiml: `<Response>
  <Say voice="alice">You are being connected to a live cruise line agent. Please hold for one moment.</Say>
  <Dial>
    <Conference>${conferenceRoom}</Conference>
  </Dial>
</Response>`,
      statusCallback: `${baseUrl}/api/calls/status`,
      statusCallbackMethod: 'POST',
    });

    await sql`
      UPDATE calls SET status = 'connected', updated_at = NOW() WHERE id = ${callId}
    `;

    await sql`
      INSERT INTO call_events (call_id, event_type, details)
      VALUES (${callId}, 'transfer_initiated', ${JSON.stringify({ transferNumber, conferenceRoom })})
    `;

    return NextResponse.json({ ok: true, status: 'connected' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
