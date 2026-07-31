import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';
import { getAuthContext } from '@/lib/admin';
import { twilioClient, twilioPhone } from '@/lib/twilio';

const DEFAULT_CONNECT_MESSAGE = "Hello, thank you for taking the call. A live agent will be on the line with you in just one moment. Please hold during the transfer and stay on the line — do not hang up. Connecting you now.";

export async function POST(req: NextRequest) {
  const ctx = await getAuthContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { callId, transferNumberPhone } = await req.json();
  if (!callId) {
    return NextResponse.json({ error: 'callId required' }, { status: 400 });
  }

  const rows = await sql`
    SELECT c.*, u.connect_message, u.transfer_numbers
    FROM calls c
    JOIN users u ON u.id = c.user_id
    WHERE c.id = ${callId} AND c.user_id = ${ctx.effectiveUserId}
    LIMIT 1
  `;

  if (rows.length === 0) {
    return NextResponse.json({ error: 'Call not found' }, { status: 404 });
  }

  const call = rows[0];

  if (!['navigating_ivr', 'agent_detected', 'on_hold', 'ai_conversation'].includes(call.status as string)) {
    return NextResponse.json({ error: `Cannot transfer call in status: ${call.status}` }, { status: 400 });
  }

  // Resolve transfer number: request override > call's stored number > default from transfer_numbers
  let transferNumber = transferNumberPhone ?? call.transfer_number as string | null;
  if (!transferNumber) {
    const nums = (call.transfer_numbers ?? []) as Array<{ phone: string; isDefault: boolean }>;
    const defaultNum = nums.find((n) => n.isDefault) ?? nums[0];
    transferNumber = defaultNum?.phone ?? null;
  }

  if (!transferNumber) {
    return NextResponse.json({ error: 'No transfer number configured' }, { status: 400 });
  }

  const connectMessage = (call.connect_message as string | null) || DEFAULT_CONNECT_MESSAGE;

  try {
    const baseUrl = (process.env.PUBLIC_URL ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3003');
    const conferenceRoom = `CruisePro-${callId}`;

    // Move cruise line agent into conference with custom hold message
    await twilioClient.calls(call.twilio_call_sid as string).update({
      twiml: `<Response>
  <Say voice="Polly.Joanna">${escapeXml(connectMessage)}</Say>
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

    await sql`UPDATE calls SET status = 'connected', updated_at = NOW() WHERE id = ${callId}`;
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

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
