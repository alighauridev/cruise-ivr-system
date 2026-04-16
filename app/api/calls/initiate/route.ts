import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import sql from '@/lib/db';
import { twilioClient, twilioPhone } from '@/lib/twilio';

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { leadId, transferNumber, ivrConfigId, aiTask, viewAs } = await req.json();
  if (!leadId) {
    return NextResponse.json({ error: 'leadId is required' }, { status: 400 });
  }

  // Admin can place calls on behalf of another user
  const effectiveUserId = viewAs ?? session.user.id;

  const leads = await sql`
    SELECT l.*, ic.steps, ic.id as ivr_config_id
    FROM leads l
    LEFT JOIN ivr_configs ic ON ic.id = l.ivr_config_id
    WHERE l.id = ${leadId} AND l.user_id = ${effectiveUserId}
    LIMIT 1
  `;

  if (leads.length === 0) {
    return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
  }

  const lead = leads[0];

  // If a specific IVR config was selected, fetch its steps
  let ivrSteps = lead.steps;
  let resolvedIvrConfigId = lead.ivr_config_id as string | null;
  if (ivrConfigId && ivrConfigId !== lead.ivr_config_id) {
    const cfgRows = await sql`SELECT id, steps FROM ivr_configs WHERE id = ${ivrConfigId} AND user_id = ${effectiveUserId} LIMIT 1`;
    if (cfgRows.length > 0) {
      ivrSteps = cfgRows[0].steps;
      resolvedIvrConfigId = cfgRows[0].id as string;
    }
  }

  // transferNumber from request > user's default transfer_phone > env fallback
  const xferNumber = transferNumber ?? process.env.DEFAULT_TRANSFER_NUMBER;

  // Normalize to E.164 — strip dashes/spaces/parens, add +1 if US number
  function toE164(num: string): string {
    const digits = num.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return num.startsWith('+') ? num : `+${digits}`;
  }
  const toNumber = toE164(lead.phone_number as string);

  const callRows = await sql`
    INSERT INTO calls (user_id, lead_id, status, cruise_line_number, transfer_number, ivr_config_id, ai_task)
    VALUES (${effectiveUserId}, ${leadId}, 'initiating', ${lead.phone_number as string}, ${xferNumber}, ${resolvedIvrConfigId}, ${aiTask ?? null})
    RETURNING id
  `;
  const callId = callRows[0].id as string;

  // Use PUBLIC_URL env var if set (tunnel URL), otherwise fall back to NEXTAUTH_URL
  const baseUrl = (process.env.PUBLIC_URL ?? process.env.NEXTAUTH_URL ?? '').trim().replace(/\/$/, '');
  if (!baseUrl || baseUrl.includes('localhost')) {
    await sql`UPDATE calls SET status = 'failed', error_message = 'PUBLIC_URL not set — Twilio requires a public HTTPS URL. Set PUBLIC_URL in .env.local to your tunnel URL (e.g. ngrok/cloudflared).' WHERE id = ${callId}`;
    return NextResponse.json({ error: 'PUBLIC_URL not configured. Twilio requires a public HTTPS URL — set PUBLIC_URL in .env.local to your ngrok or cloudflared tunnel URL.' }, { status: 500 });
  }
  const ivrUrl = `${baseUrl}/api/calls/ivr-handler?callId=${callId}&step=0`;
  const statusCallbackUrl = `${baseUrl}/api/calls/status`;
  console.log(`[Initiate] callId=${callId} ivrUrl=${ivrUrl}`);

  try {
    const recordingCallbackUrl = `${baseUrl}/api/calls/recording?callId=${callId}`;
    const call = await twilioClient.calls.create({
      to: toNumber,
      from: twilioPhone,
      url: ivrUrl,
      statusCallback: statusCallbackUrl,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      record: true,
      recordingStatusCallback: recordingCallbackUrl,
      recordingStatusCallbackMethod: 'POST',
    });

    await sql`
      UPDATE calls
      SET twilio_call_sid = ${call.sid}, status = 'navigating_ivr', updated_at = NOW()
      WHERE id = ${callId}
    `;

    await sql`
      INSERT INTO call_events (call_id, event_type, details)
      VALUES (${callId}, 'call_initiated', ${JSON.stringify({ twilioSid: call.sid, lead: lead.name })})
    `;

    return NextResponse.json({ callId, twilioSid: call.sid, status: 'navigating_ivr' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await sql`
      UPDATE calls SET status = 'failed', error_message = ${message}, updated_at = NOW()
      WHERE id = ${callId}
    `;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
