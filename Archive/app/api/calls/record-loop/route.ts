import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';

/**
 * Called by Twilio after each 15-second recording chunk completes.
 * Checks if the call is still active and re-issues another Record,
 * creating a continuous transcription loop until agent is detected.
 */
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const callId = searchParams.get('callId');

  if (!callId) {
    return new NextResponse('<Response><Hangup/></Response>', { headers: { 'Content-Type': 'text/xml' } });
  }

  const rows = await sql`SELECT status FROM calls WHERE id = ${callId} LIMIT 1`;
  const status = rows[0]?.status as string;

  // Stop looping if agent detected, connected, completed, or cancelled
  if (!status || ['agent_detected', 'connected', 'completed', 'failed', 'cancelled'].includes(status)) {
    return new NextResponse('<Response><Pause length="3600"/></Response>', { headers: { 'Content-Type': 'text/xml' } });
  }

  const baseUrl = process.env.PUBLIC_URL ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3001';
  const transcriptCallback = `${baseUrl}/api/calls/transcript`;
  const recordLoopUrl = `${baseUrl}/api/calls/record-loop?callId=${callId}`;

  const twiml = `<Response>
  <Record maxLength="15" transcribe="true" transcribeCallback="${transcriptCallback}" action="${recordLoopUrl}" playBeep="false"/>
</Response>`;

  return new NextResponse(twiml, { headers: { 'Content-Type': 'text/xml' } });
}

export async function GET(req: NextRequest) {
  return POST(req);
}
