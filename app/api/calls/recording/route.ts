import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';

/**
 * Twilio recording status callback.
 * Called when a call recording is complete and available.
 * Saves the recording URL to the calls table.
 */
export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const callSid = formData.get('CallSid') as string;
  const recordingUrl = formData.get('RecordingUrl') as string;
  const recordingStatus = formData.get('RecordingStatus') as string;
  const recordingDuration = formData.get('RecordingDuration') as string;

  if (!callSid || !recordingUrl || recordingStatus !== 'completed') {
    return NextResponse.json({ ok: true });
  }

  // Twilio recording URL — append .mp3 for direct playback
  const mp3Url = `${recordingUrl}.mp3`;

  await sql`
    UPDATE calls
    SET recording_url = ${mp3Url}, updated_at = NOW()
    WHERE twilio_call_sid = ${callSid}
  `;

  await sql`
    INSERT INTO call_events (call_id, event_type, details)
    SELECT id, 'recording_ready', ${JSON.stringify({ url: mp3Url, duration: recordingDuration })}
    FROM calls WHERE twilio_call_sid = ${callSid}
  `;

  return NextResponse.json({ ok: true });
}
