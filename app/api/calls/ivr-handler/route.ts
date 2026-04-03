import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';

const XML = { headers: { 'Content-Type': 'text/xml' } };

function getStreamUrl(baseUrl: string, callId: string): string {
  // Convert https:// to wss:// for WebSocket
  const wsBase = baseUrl.replace('https://', 'wss://').replace('http://', 'ws://');
  return `${wsBase}/media-stream?callId=${callId}`;
}

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const callId = searchParams.get('callId');

  if (!callId) {
    return new NextResponse('<Response><Hangup/></Response>', XML);
  }

  const rows = await sql`SELECT id, status FROM calls WHERE id = ${callId} LIMIT 1`;
  if (rows.length === 0) {
    return new NextResponse('<Response><Hangup/></Response>', XML);
  }

  // Mark call as navigating IVR via AI
  await sql`
    UPDATE calls SET status = 'navigating_ivr', hold_start_time = NOW(), updated_at = NOW()
    WHERE id = ${callId}
  `;
  await sql`
    INSERT INTO call_events (call_id, event_type, details)
    VALUES (${callId}, 'ai_ivr_started', '{"mode":"ai_stream"}')
  `;

  const baseUrl = (process.env.PUBLIC_URL ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3003').replace(/\/$/, '');
  const streamUrl = getStreamUrl(baseUrl, callId);

  // Stream audio to our WebSocket AI navigator from the very start
  const twiml = `<Response>
  <Start>
    <Stream url="${streamUrl}"/>
  </Start>
  <Pause length="3600"/>
</Response>`;

  return new NextResponse(twiml, XML);
}

export async function GET(req: NextRequest) {
  return POST(req);
}
