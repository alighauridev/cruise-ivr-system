import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';

/**
 * Twilio recording status callback.
 * Called when a call recording is complete and available.
 * Saves the recording URL and kicks off transcription.
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

  // Transcribe in background — don't block the Twilio callback
  transcribeRecording(callSid, mp3Url).catch((err) =>
    console.error(`[Transcribe] Error for callSid=${callSid}:`, err?.message ?? err)
  );

  return NextResponse.json({ ok: true });
}

/**
 * Fetch the recording from Twilio and transcribe it via Deepgram pre-recorded API.
 */
async function transcribeRecording(callSid: string, mp3Url: string) {
  const dgKey = process.env.DEEPGRAM_API_KEY;
  if (!dgKey) {
    console.warn('[Transcribe] DEEPGRAM_API_KEY not set — skipping transcription');
    return;
  }

  // Fetch audio from Twilio with Basic Auth
  const twilioAuth = Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  console.log(`[Transcribe] Fetching recording for callSid=${callSid}`);
  const audioResp = await fetch(mp3Url, {
    headers: { Authorization: `Basic ${twilioAuth}` },
  });

  if (!audioResp.ok) {
    console.error(`[Transcribe] Failed to fetch recording: ${audioResp.status}`);
    return;
  }

  const audioBuffer = await audioResp.arrayBuffer();
  console.log(`[Transcribe] Sending ${audioBuffer.byteLength} bytes to Deepgram`);

  // Send to Deepgram pre-recorded API
  const dgResp = await fetch('https://api.deepgram.com/v1/listen?model=nova-2-phonecall&smart_format=true&diarize=true&utterances=true', {
    method: 'POST',
    headers: {
      Authorization: `Token ${dgKey}`,
      'Content-Type': 'audio/mpeg',
    },
    body: audioBuffer,
  });

  if (!dgResp.ok) {
    const errText = await dgResp.text();
    console.error(`[Transcribe] Deepgram error ${dgResp.status}: ${errText}`);
    return;
  }

  const result = await dgResp.json();

  // Extract utterances with speaker labels — all marked as speaker 0 (IVR side)
  const dgUtterances: Array<{ speaker: number; text: string; start: number; end: number }> =
    result?.results?.utterances?.map((u: any) => ({
      speaker: 0, // IVR / cruise line
      text: u.transcript,
      start: u.start,
      end: u.end,
    })) ?? [];

  // Look up callId so we can merge in SAY actions from call_events
  const callRows = await sql`SELECT id, created_at FROM calls WHERE twilio_call_sid = ${callSid} LIMIT 1`;
  const callId = callRows[0]?.id as string | undefined;
  const callCreatedAt = callRows[0]?.created_at ? new Date(callRows[0].created_at as string).getTime() : 0;

  // Merge in our SAY actions as speaker 1 (Our System) — interleave by timestamp
  let utterances = dgUtterances;
  if (callId && callCreatedAt) {
    const sayEvents = await sql`
      SELECT details, created_at FROM call_events
      WHERE call_id = ${callId} AND event_type = 'ai_action'
      ORDER BY created_at ASC
    `;
    for (const ev of sayEvents) {
      const details = typeof ev.details === 'string' ? JSON.parse(ev.details as string) : ev.details;
      if (details?.action !== 'SAY' || !details?.phrase) continue;
      const ts = (new Date(ev.created_at as string).getTime() - callCreatedAt) / 1000;
      utterances.push({ speaker: 1, text: details.phrase, start: ts, end: ts + 1 });
    }
    // Sort by start time so SAY actions interleave correctly with IVR speech
    utterances.sort((a, b) => a.start - b.start);
  }

  // Build plain text transcript
  const plainTranscript = utterances
    .map((u) => `${u.speaker === 0 ? 'IVR' : 'System'}: ${u.text}`)
    .join('\n');

  // Also get the full single transcript
  const fullText = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? plainTranscript;

  console.log(`[Transcribe] Got ${utterances.length} utterances (${dgUtterances.length} from Deepgram + ${utterances.length - dgUtterances.length} SAY actions) for callSid=${callSid}`);

  // Save transcript to DB
  await sql`
    UPDATE calls
    SET transcript = ${JSON.stringify({ utterances, text: fullText })}, updated_at = NOW()
    WHERE twilio_call_sid = ${callSid}
  `;

  // Also save as a call event
  await sql`
    INSERT INTO call_events (call_id, event_type, details)
    SELECT id, 'transcript_ready', ${JSON.stringify({ utteranceCount: utterances.length, textLength: fullText.length })}
    FROM calls WHERE twilio_call_sid = ${callSid}
  `;
}
