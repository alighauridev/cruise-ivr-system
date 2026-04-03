import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import { DeepgramClient } from '@deepgram/sdk';
import { twilioClient } from '@/lib/twilio';
import { decideAction, ConversationTurn } from './ai-navigator';
import { detectAgentFromTranscript } from '@/lib/deepgram';
import { notifyAgentDetected } from '@/lib/notifications';
import { generateTTS } from '@/lib/openai-tts';
import sql from '@/lib/db';
import fs from 'fs';
import path from 'path';

const deepgramClient = new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY ?? '' });

interface SessionState {
  callId: string;
  callSid: string | null;
  streamSid: string | null;
  history: ConversationTurn[];
  currentTranscript: string;
  isProcessing: boolean;
  isAgentDetected: boolean;
  dgSocket: Awaited<ReturnType<typeof deepgramClient.listen.v1.connect>> | null;
}

const BASE_URL = () =>
  (process.env.PUBLIC_URL ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3003').replace(/\/$/, '');

export async function handleMediaStream(ws: WebSocket, req: IncomingMessage) {
  const url = new URL(req.url ?? '', `http://localhost`);
  const callId = url.searchParams.get('callId') ?? '';

  if (!callId) { ws.close(); return; }

  console.log(`[MediaWS] New stream session callId=${callId} dgKey=${process.env.DEEPGRAM_API_KEY ? 'set' : 'MISSING'}`);

  const state: SessionState = {
    callId,
    callSid: null,
    streamSid: null,
    history: [],
    currentTranscript: '',
    isProcessing: false,
    isAgentDetected: false,
    dgSocket: null,
  };

  // Connect to Deepgram live transcription
  try {
    const dgSocket = await deepgramClient.listen.v1.connect({
      model: 'nova-2-phonecall',
      language: 'en-US',
      encoding: 'mulaw',
      sample_rate: 8000,
      channels: 1,
      interim_results: 'true',
      smart_format: 'true',
      endpointing: 500,
      utterance_end_ms: 1500,
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
    });

    state.dgSocket = dgSocket;

    dgSocket.on('open', () => {
      console.log(`[Deepgram] Connected for callId=${callId}`);
    });

    dgSocket.on('message', async (data) => {
      // Only process transcript results
      if (!('channel' in data)) return;
      const result = data as any;
      const transcript = result?.channel?.alternatives?.[0]?.transcript ?? '';
      const isFinal = result?.is_final ?? false;
      const speechFinal = result?.speech_final ?? false;

      if (!transcript.trim()) return;

      if (isFinal) {
        state.currentTranscript += (state.currentTranscript ? ' ' : '') + transcript;
      }

      if (speechFinal && state.currentTranscript.trim()) {
        const full = state.currentTranscript.trim();
        state.currentTranscript = '';
        await processIVRSpeech(state, full);
      }
    });

    dgSocket.on('error', (err) => {
      console.error(`[Deepgram] Error callId=${callId}:`, err);
    });

    dgSocket.on('close', () => {
      console.log(`[Deepgram] Closed callId=${callId}`);
    });

  } catch (err: any) {
    console.error(`[MediaWS] Failed to connect Deepgram:`, err?.message ?? err);
    // Don't close — keep WS open so Twilio stays on call, just won't transcribe
    return;
  }

  // Handle Twilio Media Stream messages
  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.event) {
        case 'start':
          state.callSid = msg.start?.callSid ?? null;
          state.streamSid = msg.start?.streamSid ?? null;
          console.log(`[MediaWS] Stream started callSid=${state.callSid}`);
          break;

        case 'media':
          if (state.dgSocket && state.dgSocket.readyState === 1) {
            const audioBuffer = Buffer.from(msg.media.payload, 'base64');
            state.dgSocket.sendMedia(audioBuffer);
          }
          break;

        case 'stop':
          console.log(`[MediaWS] Stream stopped callId=${callId}`);
          cleanup(state);
          break;
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.on('close', () => {
    console.log(`[MediaWS] WS closed callId=${callId}`);
    cleanup(state);
  });

  ws.on('error', (err) => {
    console.error(`[MediaWS] WS error callId=${callId}:`, err);
    cleanup(state);
  });
}

async function processIVRSpeech(state: SessionState, transcript: string) {
  if (state.isAgentDetected || state.isProcessing) return;
  if (!state.callSid) return;

  console.log(`[AI] IVR said: "${transcript}"`);

  // Save transcript to DB
  await sql`
    INSERT INTO call_events (call_id, event_type, details)
    VALUES (${state.callId}, 'transcript', ${JSON.stringify({ text: transcript, speaker: 'cruise_line' })})
  `.catch(() => {});

  // Quick phrase check for live agent
  if (detectAgentFromTranscript(transcript)) {
    await handleAgentDetected(state, transcript);
    return;
  }

  state.isProcessing = true;

  try {
    const action = await decideAction(transcript, state.history);
    console.log(`[AI] Action: ${JSON.stringify(action)}`);

    state.history.push({ speaker: 'ivr', text: transcript });

    const baseUrl = BASE_URL();
    const wsBase = baseUrl.replace('https://', 'wss://').replace('http://', 'ws://');
    const streamUrl = `${wsBase}/media-stream?callId=${state.callId}`;

    switch (action.type) {
      case 'AGENT_DETECTED':
        await handleAgentDetected(state, transcript);
        break;

      case 'PRESS': {
        state.history.push({ speaker: 'us', text: `Pressed ${action.digit}` });
        await logAction(state.callId, 'PRESS', { digit: action.digit, ivrSaid: transcript });
        await twilioClient.calls(state.callSid!).update({
          twiml: `<Response><Play digits="${action.digit}"/><Pause length="1"/><Start><Stream url="${streamUrl}"/></Start><Pause length="3600"/></Response>`,
        });
        break;
      }

      case 'SAY': {
        state.history.push({ speaker: 'us', text: action.phrase });
        await logAction(state.callId, 'SAY', { phrase: action.phrase, ivrSaid: transcript });

        // Generate human-sounding voice with OpenAI TTS
        let twiml: string;
        try {
          const audioBuffer = await generateTTS(action.phrase);
          const ttsDir = path.join(process.cwd(), 'public', 'tts');
          if (!fs.existsSync(ttsDir)) fs.mkdirSync(ttsDir, { recursive: true });
          const filename = `tts-${state.callId}-${Date.now()}.mp3`;
          fs.writeFileSync(path.join(ttsDir, filename), audioBuffer);
          const audioUrl = `${baseUrl}/tts/${filename}`;
          twiml = `<Response><Play>${audioUrl}</Play><Pause length="1"/><Start><Stream url="${streamUrl}"/></Start><Pause length="3600"/></Response>`;
        } catch {
          // Fallback to Twilio TTS
          twiml = `<Response><Say voice="alice">${escapeXml(action.phrase)}</Say><Pause length="1"/><Start><Stream url="${streamUrl}"/></Start><Pause length="3600"/></Response>`;
        }

        await twilioClient.calls(state.callSid!).update({ twiml });
        break;
      }

      case 'WAIT':
        // Keep listening
        break;
    }
  } catch (err) {
    console.error(`[AI] Error:`, err);
  } finally {
    state.isProcessing = false;
  }
}

async function handleAgentDetected(state: SessionState, transcript: string) {
  if (state.isAgentDetected) return;
  state.isAgentDetected = true;

  console.log(`[AI] AGENT DETECTED callId=${state.callId}`);

  try {
    const rows = await sql`
      SELECT c.*, u.notification_phone
      FROM calls c
      JOIN users u ON u.id = c.user_id
      WHERE c.id = ${state.callId}
      LIMIT 1
    `;

    if (rows.length === 0) return;
    const call = rows[0];

    await sql`
      UPDATE calls
      SET status = 'agent_detected',
          agent_detected_time = NOW(),
          hold_duration_seconds = EXTRACT(EPOCH FROM (NOW() - hold_start_time))::INTEGER,
          updated_at = NOW()
      WHERE id = ${state.callId}
    `;

    await sql`
      INSERT INTO call_events (call_id, event_type, details)
      VALUES (${state.callId}, 'agent_detected', ${JSON.stringify({ transcript })})
    `;

    // Keep call alive so agent doesn't hang up
    if (state.callSid) {
      await twilioClient.calls(state.callSid).update({
        twiml: `<Response><Pause length="3600"/></Response>`,
      });
    }

    const baseUrl = BASE_URL();
    if (call.notification_phone) {
      await notifyAgentDetected(state.callId, call.notification_phone as string, baseUrl);
    }
  } catch (err) {
    console.error(`[AI] handleAgentDetected error:`, err);
  }
}

async function logAction(callId: string, action: string, details: object) {
  await sql`
    INSERT INTO call_events (call_id, event_type, details)
    VALUES (${callId}, 'ai_action', ${JSON.stringify({ action, ...details })})
  `.catch(() => {});
}

function cleanup(state: SessionState) {
  try {
    if (state.dgSocket) state.dgSocket.close();
  } catch {}
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
