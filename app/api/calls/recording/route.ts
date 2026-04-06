import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';

/**
 * Twilio recording status callback.
 * Called when a call recording is complete and available.
 * Saves the recording URL and kicks off transcription.
 */
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const callIdFromUrl = searchParams.get('callId');

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

  // Resolve callId — prefer URL param (most reliable), fall back to DB lookup
  let callId = callIdFromUrl;
  if (!callId) {
    const rows = await sql`SELECT id FROM calls WHERE twilio_call_sid = ${callSid} LIMIT 1`;
    callId = rows[0]?.id as string | null;
  }

  if (callId) {
    await sql`
      INSERT INTO call_events (call_id, event_type, details)
      VALUES (${callId}, 'recording_ready', ${JSON.stringify({ url: mp3Url, duration: recordingDuration })})
    `;
  }

  // Transcribe in background — don't block the Twilio callback
  transcribeRecording(callSid, callId, mp3Url).catch((err) =>
    console.error(`[Transcribe] Error for callSid=${callSid}:`, err?.message ?? err)
  );

  return NextResponse.json({ ok: true });
}

/**
 * Fetch the recording from Twilio and transcribe it via Deepgram pre-recorded API.
 * Merges our SAY actions (speaker 1) with Deepgram IVR utterances (speaker 0).
 */
async function transcribeRecording(callSid: string, callId: string | null, mp3Url: string) {
  const dgKey = process.env.DEEPGRAM_API_KEY;
  if (!dgKey) {
    console.warn('[Transcribe] DEEPGRAM_API_KEY not set — skipping transcription');
    return;
  }

  // Fetch audio from Twilio with Basic Auth
  const twilioAuth = Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  console.log(`[Transcribe] Fetching recording callSid=${callSid} callId=${callId}`);
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

  // Extract utterances — all marked speaker 0 (IVR / cruise line side)
  const dgUtterances: Array<{ speaker: number; text: string; start: number; end: number }> =
    result?.results?.utterances?.map((u: any) => ({
      speaker: 0,
      text: u.transcript,
      start: u.start,
      end: u.end,
    })) ?? [];

  let utterances = [...dgUtterances];

  // Merge our SAY actions as speaker 1 (Our System).
  // Also re-label any Deepgram utterances that overlap in time with our SAY actions
  // (Deepgram picks up our TTS audio and transcribes it as speaker 0 — fix that here).
  if (callId) {
    const callRows = await sql`SELECT created_at FROM calls WHERE id = ${callId} LIMIT 1`;
    const callCreatedAt = callRows[0]?.created_at instanceof Date
      ? callRows[0].created_at.getTime()
      : new Date(callRows[0]?.created_at as string).getTime();

    const sayEvents = await sql`
      SELECT details, created_at FROM call_events
      WHERE call_id = ${callId} AND event_type = 'ai_action'
      ORDER BY created_at ASC
    `;

    console.log(`[Transcribe] Found ${sayEvents.length} ai_action events for callId=${callId}`);

    // Build list of our SAY windows: { start, end, phrase }
    const sayWindows: Array<{ start: number; end: number; phrase: string }> = [];
    for (const ev of sayEvents) {
      const details = (typeof ev.details === 'string' ? JSON.parse(ev.details as string) : ev.details) as Record<string, string>;
      if (details?.action !== 'SAY' || !details?.phrase) continue;
      const evTime = ev.created_at instanceof Date
        ? ev.created_at.getTime()
        : new Date(ev.created_at as string).getTime();
      const ts = (evTime - callCreatedAt) / 1000;
      // Estimate duration: ~150ms per character of the phrase
      const duration = Math.max(1, details.phrase.length * 0.075);
      sayWindows.push({ start: ts, end: ts + duration, phrase: details.phrase });
    }

    // Re-label Deepgram utterances that fall within a SAY window as speaker 1
    // and remove them (we'll use the exact SAY phrase instead)
    const dgFiltered = utterances.filter((u) => {
      const overlap = sayWindows.some(
        (w) => u.start >= w.start - 1 && u.start <= w.end + 1
      );
      return !overlap;
    });

    // Add our SAY actions with exact text and speaker 1
    const sayUtterances = sayWindows.map((w) => ({
      speaker: 1,
      text: w.phrase,
      start: w.start,
      end: w.end,
    }));

    utterances = [...dgFiltered, ...sayUtterances];
    utterances.sort((a, b) => a.start - b.start);
  }

  // Build plain text transcript
  const plainTranscript = utterances
    .map((u) => `${u.speaker === 0 ? 'IVR' : 'System'}: ${u.text}`)
    .join('\n');

  const fullText = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? plainTranscript;

  console.log(`[Transcribe] Got ${utterances.length} utterances (${dgUtterances.length} IVR + ${utterances.length - dgUtterances.length} SAY) for callSid=${callSid}`);

  // Save transcript to DB
  await sql`
    UPDATE calls
    SET transcript = ${JSON.stringify({ utterances, text: fullText })}, updated_at = NOW()
    WHERE twilio_call_sid = ${callSid}
  `;

  if (callId) {
    await sql`
      INSERT INTO call_events (call_id, event_type, details)
      VALUES (${callId}, 'transcript_ready', ${JSON.stringify({ utteranceCount: utterances.length, textLength: fullText.length })})
    `;
  }
}
