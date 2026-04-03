import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';
import { detectAgentFromTranscript } from '@/lib/deepgram';
import { notifyAgentDetected } from '@/lib/notifications';

/**
 * Deepgram webhook — receives transcription results from real-time streaming.
 * Twilio streams audio to Deepgram; Deepgram posts transcripts here.
 */
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const callId = searchParams.get('callId');

  if (!callId) {
    return NextResponse.json({ ok: false });
  }

  const body = await req.json().catch(() => null);
  const transcript = body?.channel?.alternatives?.[0]?.transcript ?? '';

  if (!transcript) {
    return NextResponse.json({ ok: true });
  }

  const agentDetected = detectAgentFromTranscript(transcript);

  if (agentDetected) {
    // Fetch call to get user info and check current status
    const rows = await sql`
      SELECT c.*, u.notification_phone, u.notification_preference
      FROM calls c
      JOIN users u ON u.id = c.user_id
      WHERE c.id = ${callId} AND c.status = 'on_hold'
      LIMIT 1
    `;

    if (rows.length > 0) {
      const call = rows[0];

      await sql`
        UPDATE calls
        SET status = 'agent_detected',
            agent_detected_time = NOW(),
            hold_duration_seconds = EXTRACT(EPOCH FROM (NOW() - hold_start_time))::INTEGER,
            updated_at = NOW()
        WHERE id = ${callId}
      `;

      await sql`
        INSERT INTO call_events (call_id, event_type, details)
        VALUES (${callId}, 'agent_detected', ${JSON.stringify({ transcript })})
      `;

      const baseUrl = process.env.NEXTAUTH_URL ?? 'http://localhost:3000';
      if (call.notification_phone) {
        await notifyAgentDetected(callId, call.notification_phone as string, baseUrl);
      }
    }
  }

  return NextResponse.json({ ok: true });
}
