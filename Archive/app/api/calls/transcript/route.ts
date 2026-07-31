import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';
import { detectAgentFromTranscript, detectHoldMusicFromTranscript } from '@/lib/deepgram';
import { notifyAgentDetected } from '@/lib/notifications';

/**
 * Twilio transcription callback — called after each recorded audio chunk.
 * Twilio posts: CallSid, TranscriptionText, TranscriptionStatus, RecordingSid
 */
export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const callSid = formData.get('CallSid') as string;
  const transcript = (formData.get('TranscriptionText') as string) ?? '';
  const status = formData.get('TranscriptionStatus') as string;

  if (!callSid || status !== 'completed' || !transcript.trim()) {
    return NextResponse.json({ ok: true });
  }

  // Find the call
  const rows = await sql`
    SELECT c.*, u.notification_phone
    FROM calls c
    JOIN users u ON u.id = c.user_id
    WHERE c.twilio_call_sid = ${callSid}
    LIMIT 1
  `;

  if (rows.length === 0) return NextResponse.json({ ok: true });
  const call = rows[0];
  const callId = call.id as string;

  // Save transcript as event
  await sql`
    INSERT INTO call_events (call_id, event_type, details)
    VALUES (${callId}, 'transcript', ${JSON.stringify({ text: transcript, speaker: 'cruise_line' })})
  `;

  // Detect agent
  if (call.status === 'on_hold' && detectAgentFromTranscript(transcript)) {
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
    const baseUrl = process.env.PUBLIC_URL ?? process.env.NEXTAUTH_URL ?? '';
    if (call.notification_phone) {
      await notifyAgentDetected(callId, call.notification_phone as string, baseUrl);
    }
  }

  return NextResponse.json({ ok: true });
}
