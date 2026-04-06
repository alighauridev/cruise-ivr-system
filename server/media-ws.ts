import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import { twilioClient } from '@/lib/twilio';
import { decideAction, detectAgentWithAI, ConversationTurn } from './ai-navigator';
import { detectAgentFromTranscript, detectVoicemail } from '@/lib/deepgram';
import { notifyAgentDetected } from '@/lib/notifications';
import { generateTTSMulaw } from '@/lib/openai-tts';

import { IVRExecutor, ExecutorAction } from './ivr-executor';
import { IVRStep } from '@/lib/ivr-engine';
import { twilioPhone } from '@/lib/twilio';
import sql from '@/lib/db';

const MAX_CALL_DURATION_MS = 20 * 60 * 1000; // 20 minutes
const DG_RETRY_DELAYS = [500, 1500, 4000];

/**
 * Module-level session map so IVR executor state survives WebSocket reconnections.
 *
 * When dispatchAction (PRESS / SAY) updates Twilio TwiML, Twilio closes the current
 * stream and opens a NEW WebSocket connection seconds later.  Without this map we'd
 * create a brand-new IVRExecutor starting at step 0 every time.  With it, the
 * existing executor keeps running and the new WS just picks up the same state.
 */
const callSessions = new Map<string, SessionState>();

interface SessionState {
  callId: string;
  callSid: string | null;
  streamSid: string | null;
  history: ConversationTurn[];
  currentTranscript: string;
  isProcessing: boolean;
  isAgentDetected: boolean;
  isTerminated: boolean;
  /**
   * Number of TwiML updates we have dispatched to Twilio that have not yet
   * produced their corresponding 'stop' event.  When > 0 a 'stop' event means
   * "redirect in progress" (not a real call end), so we must NOT cleanup.
   */
  pendingRedirects: number;
  /**
   * Number of WS 'close' events that are expected from redirect stop-cycles.
   * Each redirect produces both a 'stop' AND a 'close' on the same WS.
   * stop() consumes one pendingRedirects and flags one pendingClose so the
   * subsequent close() doesn't trigger cleanup.
   */
  pendingCloses: number;
  dgSocket: WebSocket | null;
  ivrSteps: IVRStep[] | null;
  ivrExecutor: IVRExecutor | null;
  maxDurationTimer: ReturnType<typeof setTimeout> | null;
  /** Fires after the last WS closes to clean up if no new WS reconnects. */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  lastTranscriptAt: number;
  holdStatusUpdated: boolean;
  /** Reference to the current Twilio media stream WS — used to send TTS audio back. */
  twilioWs: WebSocket | null;
}

const BASE_URL = () =>
  (process.env.PUBLIC_URL ?? process.env.NEXTAUTH_URL ?? 'http://localhost:3003').trim().replace(/\/$/, '');

const STREAM_URL = () => {
  const base = BASE_URL();
  return base.replace('https://', 'wss://').replace('http://', 'ws://') + '/media-stream';
};

export function handleMediaStream(ws: WebSocket, _req: IncomingMessage) {
  // callId comes via Twilio <Parameter name="callId"> in the 'start' event.
  // Cloudflare tunnels strip query strings from WebSocket upgrade URLs, so we
  // cannot use URL query params for this.

  let state: SessionState | null = null;

  // IMPORTANT: Set up ws.on('message') SYNCHRONOUSLY before any awaits.
  // This ensures we never miss the Twilio 'start' event which arrives first.
  ws.on('message', async (data: WebSocket.RawData, isBinary: boolean) => {
    // Log receipt of any non-media message for diagnostics
    const raw = Array.isArray(data) ? Buffer.concat(data as Buffer[]) : (data instanceof ArrayBuffer ? Buffer.from(data) : (data as Buffer));
    try {
      const text = raw.toString('utf8');
      const msg = JSON.parse(text);
      if (msg.event !== 'media') console.log(`[MediaWS] msg event=${msg.event} isBinary=${isBinary}`);

      switch (msg.event) {
        case 'start': {
          const callSid: string = msg.start?.callSid ?? '';
          const customCallId: string = msg.start?.customParameters?.callId ?? '';
          console.log(`[MediaWS] Start event callSid=${callSid} customCallId=${customCallId}`);

          if (!callSid) {
            console.error('[MediaWS] No callSid in start event — closing');
            ws.close();
            return;
          }

          if (state) return; // already initialised on this WS

          // Resolve callId: prefer customParameter, fall back to DB lookup via callSid
          let callId = customCallId;
          if (!callId) {
            try {
              const rows = await sql`SELECT id FROM calls WHERE twilio_call_sid = ${callSid} LIMIT 1`;
              callId = (rows[0]?.id as string) ?? '';
            } catch (err) {
              console.error('[MediaWS] DB lookup for callSid failed:', err);
            }
          }

          if (!callId) {
            console.error(`[MediaWS] Could not resolve callId for callSid=${callSid} — closing`);
            ws.close();
            return;
          }

          // ── Reconnection path ────────────────────────────────────────────────
          // When dispatchAction sends new TwiML (PRESS/SAY), Twilio closes the
          // current stream and opens a new WebSocket a moment later.  Reuse the
          // existing SessionState so the IVR executor keeps running uninterrupted.
          const existing = callSessions.get(callId);
          if (existing && !existing.isTerminated) {
            console.log(`[MediaWS] Reconnected to existing session callId=${callId}`);
            state = existing;
            state.twilioWs = ws; // Update WS reference for audio injection
            state.streamSid = msg.start?.streamSid ?? state.streamSid;
            // Cancel any pending reconnect-timeout cleanup
            if (state.reconnectTimer) {
              clearTimeout(state.reconnectTimer);
              state.reconnectTimer = null;
            }
            // Reconnect Deepgram only if closed/closing (not if already connecting or open)
            const rs = state.dgSocket?.readyState ?? WebSocket.CLOSED;
            if (rs === WebSocket.CLOSING || rs === WebSocket.CLOSED) {
              connectDeepgram(state, 0).catch((err) =>
                console.error(`[MediaWS] DG reconnect error on WS reconnect:`, err)
              );
            }
            break;
          }

          // ── First connect ────────────────────────────────────────────────────
          console.log(`[MediaWS] Stream started callId=${callId} callSid=${callSid}`);

          state = {
            callId,
            callSid,
            streamSid: msg.start?.streamSid ?? null,
            history: [],
            currentTranscript: '',
            isProcessing: false,
            isAgentDetected: false,
            isTerminated: false,
            pendingRedirects: 0,
            pendingCloses: 0,
            dgSocket: null,
            ivrSteps: null,
            ivrExecutor: null,
            maxDurationTimer: null,
            reconnectTimer: null,
            lastTranscriptAt: Date.now(),
            holdStatusUpdated: false,
            twilioWs: ws,
          };

          callSessions.set(callId, state!);

          // Async setup — runs in background while stream continues
          setupSession(state!, ws).catch((err) => {
            console.error(`[MediaWS] setupSession error callId=${callId}:`, err);
          });
          break;
        }

        case 'media': {
          if (!state) return;
          if (state.dgSocket && state.dgSocket.readyState === WebSocket.OPEN) {
            const audioBuffer = Buffer.from(msg.media.payload, 'base64');
            state.dgSocket.send(audioBuffer);
          }
          break;
        }

        case 'mark': {
          // Twilio sends this when audio playback reaches a mark we sent
          console.log(`[MediaWS] Mark received: ${msg.mark?.name} callId=${state?.callId}`);
          break;
        }

        case 'stop': {
          console.log(`[MediaWS] Stream stopped callId=${state?.callId} pendingRedirects=${state?.pendingRedirects} pendingCloses=${state?.pendingCloses}`);
          if (!state) break;
          if (state.pendingRedirects > 0) {
            // This stop was caused by our own TwiML redirect — a new WS is coming.
            // Mark the corresponding 'close' as expected so it doesn't call cleanup.
            state.pendingRedirects--;
            state.pendingCloses++;
          } else {
            // Real call end (callee hung up, Twilio ended the call, etc.)
            cleanup(state);
          }
          break;
        }
      }
    } catch (err) {
      console.error(`[MediaWS] Message handler error:`, err);
    }
  });

  ws.on('close', () => {
    console.log(`[MediaWS] WS closed callId=${state?.callId ?? 'unknown'} pendingRedirects=${state?.pendingRedirects} pendingCloses=${state?.pendingCloses}`);
    if (!state) return;
    if (state.pendingCloses > 0) {
      // This close is the expected follow-up to a redirect stop — safe to ignore.
      state.pendingCloses--;
      // If all expected closes are consumed, set a reconnect timeout.
      // If no new WS arrives within 10s, the call has genuinely ended.
      if (state.pendingCloses === 0 && !state.reconnectTimer && !state.isTerminated) {
        state.reconnectTimer = setTimeout(() => {
          if (!state!.isTerminated) {
            console.log(`[MediaWS] No WS reconnect within 10s — cleaning up callId=${state!.callId}`);
            cleanup(state!);
          }
        }, 10_000);
      }
    } else if (!state.isTerminated) {
      cleanup(state);
    }
  });

  ws.on('error', (err) => {
    console.error(`[MediaWS] WS error callId=${state?.callId ?? 'unknown'}:`, err);
    if (state && !state.isTerminated) cleanup(state);
  });
}

async function setupSession(state: SessionState, _ws: WebSocket): Promise<void> {
  // Load IVR config from DB
  try {
    const rows = await sql`
      SELECT ic.steps
      FROM calls c
      LEFT JOIN ivr_configs ic ON ic.id = c.ivr_config_id
      WHERE c.id = ${state.callId}
      LIMIT 1
    `;
    if (rows[0]?.steps && Array.isArray(rows[0].steps) && rows[0].steps.length > 0) {
      state.ivrSteps = rows[0].steps as IVRStep[];
      console.log(`[MediaWS] Loaded ${state.ivrSteps.length} IVR steps for callId=${state.callId}`);
    } else {
      console.log(`[MediaWS] No IVR config for callId=${state.callId} — AI fallback mode`);
    }
  } catch (err) {
    console.error(`[MediaWS] Failed to load IVR config:`, err);
  }

  // Start IVR executor IMMEDIATELY — DTMF/wait steps don't need Deepgram.
  // Waiting for Deepgram.open() costs 500-2000ms and the IVR may hang up for lack of input.
  if (state.ivrSteps?.length && !state.ivrExecutor && !state.isTerminated) {
    state.ivrExecutor = new IVRExecutor(
      state.ivrSteps,
      async (action) => dispatchAction(state, action),
      async (stepIndex, step) => {
        await sql`
          INSERT INTO call_events (call_id, event_type, details)
          VALUES (${state.callId}, ${`ivr_step_${stepIndex}`}, ${JSON.stringify({ step: { type: step.type, description: step.description }, stepIndex })})
        `.catch(() => {});
      }
    );
    state.ivrExecutor.start();
    console.log(`[IVR] Executor started for callId=${state.callId}`);
  }

  // Max call duration timer
  if (!state.maxDurationTimer && !state.isTerminated) {
    state.maxDurationTimer = setTimeout(() => endCallMaxDuration(state), MAX_CALL_DURATION_MS);
  }

  // Connect Deepgram for audio transcription (needed for wait-step reset and hold-mode agent detection)
  await connectDeepgram(state, 0);
}

async function connectDeepgram(state: SessionState, attempt: number): Promise<void> {
  if (state.isTerminated) return;

  const dgKey = process.env.DEEPGRAM_API_KEY;
  if (!dgKey) {
    console.error(`[Deepgram] DEEPGRAM_API_KEY not set — transcription disabled`);
    return;
  }

  // Build Deepgram streaming URL with query params (bypass SDK, use raw WebSocket)
  const params = new URLSearchParams({
    model: 'nova-2-phonecall',
    language: 'en-US',
    encoding: 'mulaw',
    sample_rate: '8000',
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    endpointing: '300',
    utterance_end_ms: '1000',
  });
  const dgUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

  console.log(`[Deepgram] Connecting attempt=${attempt} callId=${state.callId} keyLen=${dgKey.length}`);

  try {
    const dgSocket = new WebSocket(dgUrl, {
      headers: { Authorization: `Token ${dgKey}` },
      handshakeTimeout: 10_000,
    });

    state.dgSocket = dgSocket;

    dgSocket.on('open', () => {
      console.log(`[Deepgram] Connected callId=${state.callId} attempt=${attempt}`);
    });

    dgSocket.on('message', async (raw: WebSocket.RawData) => {
      try {
        const data = JSON.parse(raw.toString());
        if (!data?.channel) return;
        const transcript: string = data.channel?.alternatives?.[0]?.transcript ?? '';
        const isFinal: boolean = data.is_final ?? false;
        const speechFinal: boolean = data.speech_final ?? false;

        if (!transcript.trim()) return;

        if (isFinal) {
          state.currentTranscript += (state.currentTranscript ? ' ' : '') + transcript;
        }

        if (speechFinal && state.currentTranscript.trim()) {
          const full = state.currentTranscript.trim();
          state.currentTranscript = '';
          await processIVRSpeech(state, full);
        }
      } catch (err: any) {
        console.error(`[Deepgram] Message parse error:`, err?.message);
      }
    });

    dgSocket.on('error', (err: Error) => {
      console.error(`[Deepgram] Error callId=${state.callId}:`, err?.message ?? err);
    });

    dgSocket.on('close', (code: number, reason: Buffer) => {
      console.log(`[Deepgram] Closed callId=${state.callId} code=${code} reason=${reason?.toString()}`);
      if (!state.isTerminated && attempt < DG_RETRY_DELAYS.length) {
        const delay = DG_RETRY_DELAYS[attempt] ?? 4000;
        console.log(`[Deepgram] Retrying in ${delay}ms (attempt ${attempt + 1})`);
        setTimeout(() => connectDeepgram(state, attempt + 1), delay);
      }
    });

  } catch (err: any) {
    console.error(`[Deepgram] Failed to connect attempt=${attempt}:`, err?.message ?? err);
    if (!state.isTerminated && attempt < DG_RETRY_DELAYS.length) {
      const delay = DG_RETRY_DELAYS[attempt] ?? 4000;
      setTimeout(() => connectDeepgram(state, attempt + 1), delay);
    }
  }
}

async function processIVRSpeech(state: SessionState, transcript: string) {
  if (state.isAgentDetected || state.isTerminated) return;

  state.lastTranscriptAt = Date.now();
  console.log(`[IVR] Said: "${transcript}"`);

  await sql`
    INSERT INTO call_events (call_id, event_type, details)
    VALUES (${state.callId}, 'transcript', ${JSON.stringify({ text: transcript, speaker: 'cruise_line' })})
  `.catch(() => {});

  // 1. Voicemail detection
  if (detectVoicemail(transcript)) {
    await handleVoicemail(state);
    return;
  }

  // 2. Agent phrase detection
  if (detectAgentFromTranscript(transcript)) {
    await handleAgentDetected(state, transcript);
    return;
  }

  // 3. IVR executor mode
  if (state.ivrExecutor && !state.ivrExecutor.isDone()) {
    state.ivrExecutor.onTranscript(transcript);

    if (state.ivrExecutor.isInHoldMode()) {
      await checkHoldStatus(state);
      if (transcript.split(' ').length >= 10) {
        const recentHistory = state.history.slice(-3).map((t) => `${t.speaker}: ${t.text}`);
        const isAgent = await detectAgentWithAI(transcript, recentHistory);
        if (isAgent) await handleAgentDetected(state, transcript);
      }
    }
    return;
  }

  // 4. AI fallback mode
  if (state.isProcessing || !state.callSid) return;

  state.isProcessing = true;
  try {
    const action = await decideAction(transcript, state.history);
    console.log(`[AI] Action: ${JSON.stringify(action)}`);
    state.history.push({ speaker: 'ivr', text: transcript });

    switch (action.type) {
      case 'AGENT_DETECTED':
        await handleAgentDetected(state, transcript);
        break;
      case 'PRESS':
        state.history.push({ speaker: 'us', text: `Pressed ${action.digit}` });
        await dispatchAction(state, { type: 'PRESS', digit: action.digit });
        break;
      case 'SAY':
        state.history.push({ speaker: 'us', text: action.phrase });
        await dispatchAction(state, { type: 'SAY', phrase: action.phrase });
        break;
      case 'WAIT':
        break;
    }
  } catch (err) {
    console.error(`[AI] Error:`, err);
  } finally {
    state.isProcessing = false;
  }
}

async function dispatchAction(state: SessionState, action: ExecutorAction): Promise<void> {
  if (!state.callSid) {
    console.warn(`[dispatchAction] callSid not yet set, skipping action type=${action.type}`);
    return;
  }

  const streamUrl = STREAM_URL();

  // Bidirectional stream TwiML — used when we need to restart the stream (PRESS actions).
  // <Connect> keeps the call alive while the stream is active (no <Pause> needed).
  const streamTwiml = `<Connect><Stream url="${streamUrl}" bidirectional="true"><Parameter name="callId" value="${state.callId}"/></Stream></Connect>`;

  switch (action.type) {
    case 'PRESS': {
      console.log(`[Action] PRESS ${action.digit} callId=${state.callId}`);
      await sql`
        INSERT INTO call_events (call_id, event_type, details)
        VALUES (${state.callId}, 'ai_action', ${JSON.stringify({ action: 'PRESS', digit: action.digit })})
      `.catch(() => {});
      state.pendingRedirects++;
      await twilioClient.calls(state.callSid).update({
        twiml: `<Response><Play digits="${action.digit}"/><Pause length="1"/>${streamTwiml}</Response>`,
      });
      break;
    }

    case 'SAY': {
      console.log(`[Action] SAY "${action.phrase}" callId=${state.callId}`);
      await sql`
        INSERT INTO call_events (call_id, event_type, details)
        VALUES (${state.callId}, 'ai_action', ${JSON.stringify({ action: 'SAY', phrase: action.phrase })})
      `.catch(() => {});

      // Inject OpenAI TTS audio directly through the bidirectional media stream.
      // No TwiML redirect needed — audio plays on the call, captured in recording.
      try {
        const mulawAudio = await generateTTSMulaw(action.phrase);
        console.log(`[Action] Injecting ${mulawAudio.length} bytes of TTS audio for "${action.phrase}"`);

        // Send 20ms chunks (160 bytes at 8kHz mulaw) through the bidirectional WS
        const CHUNK_SIZE = 160;
        for (let i = 0; i < mulawAudio.length; i += CHUNK_SIZE) {
          const chunk = mulawAudio.subarray(i, Math.min(i + CHUNK_SIZE, mulawAudio.length));
          if (state.twilioWs && state.twilioWs.readyState === WebSocket.OPEN) {
            state.twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid: state.streamSid,
              media: { payload: chunk.toString('base64') },
            }));
          }
        }
        // Send a mark so Twilio notifies us when playback finishes
        if (state.twilioWs && state.twilioWs.readyState === WebSocket.OPEN) {
          state.twilioWs.send(JSON.stringify({
            event: 'mark',
            streamSid: state.streamSid,
            mark: { name: `tts-done-${Date.now()}` },
          }));
        }
        // NO pendingRedirects++ — no TwiML redirect needed for SAY
      } catch (ttsErr: any) {
        // Fallback: use Twilio's built-in <Say> if OpenAI TTS fails
        console.error(`[Action] OpenAI TTS failed, falling back to Twilio <Say>:`, ttsErr?.message);
        state.pendingRedirects++;
        await twilioClient.calls(state.callSid).update({
          twiml: `<Response><Say voice="Polly.Joanna">${escapeXml(action.phrase)}</Say><Pause length="1"/>${streamTwiml}</Response>`,
        });
      }
      break;
    }

    case 'ENTER_HOLD_MODE': {
      console.log(`[Action] ENTER_HOLD_MODE callId=${state.callId}`);
      await sql`
        UPDATE calls SET status = 'on_hold', hold_start_time = NOW(), updated_at = NOW()
        WHERE id = ${state.callId} AND status = 'navigating_ivr'
      `.catch(() => {});
      await sql`
        INSERT INTO call_events (call_id, event_type, details)
        VALUES (${state.callId}, 'entered_hold', '{}')
      `.catch(() => {});
      state.holdStatusUpdated = true;
      break;
    }
  }
}

async function checkHoldStatus(state: SessionState): Promise<void> {
  if (state.holdStatusUpdated) return;
  if (Date.now() - state.lastTranscriptAt > 30000) {
    await sql`
      UPDATE calls SET status = 'on_hold', hold_start_time = COALESCE(hold_start_time, NOW()), updated_at = NOW()
      WHERE id = ${state.callId} AND status NOT IN ('agent_detected', 'connected', 'completed', 'failed', 'cancelled')
    `.catch(() => {});
    state.holdStatusUpdated = true;
  }
}

async function handleAgentDetected(state: SessionState, transcript: string) {
  if (state.isAgentDetected || state.isTerminated) return;
  state.isAgentDetected = true;
  state.ivrExecutor?.destroy();

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
          hold_duration_seconds = CASE
            WHEN hold_start_time IS NOT NULL
            THEN EXTRACT(EPOCH FROM (NOW() - hold_start_time))::INTEGER
            ELSE 0
          END,
          updated_at = NOW()
      WHERE id = ${state.callId}
    `;

    await sql`
      INSERT INTO call_events (call_id, event_type, details)
      VALUES (${state.callId}, 'agent_detected', ${JSON.stringify({ transcript })})
    `;

    if (state.callSid) {
      // Tell the agent to hold — prevents them from hanging up while we connect the customer.
      // Loop the message every 30s so they know someone is coming.
      await twilioClient.calls(state.callSid).update({
        twiml: `<Response><Say voice="Polly.Joanna">Thank you for your patience. We are connecting you to our customer now. Please hold for just a moment.</Say><Pause length="25"/><Say voice="Polly.Joanna">We are still connecting you. Please hold.</Say><Pause length="25"/><Say voice="Polly.Joanna">Thank you for waiting. Our customer will be with you shortly.</Say><Pause length="3600"/></Response>`,
      });
    }

    const baseUrl = BASE_URL();
    if (call.notification_phone) {
      await notifyAgentDetected(state.callId, call.notification_phone as string, baseUrl);
    }

    // Auto-callback: check if user has auto_callback_enabled, then auto-bridge
    const transferNumber = call.transfer_number as string | null;
    if (transferNumber) {
      const autoSetting = await sql`
        SELECT value FROM settings WHERE user_id = ${call.user_id as string} AND key = 'auto_callback_enabled' LIMIT 1
      `;
      if (autoSetting[0]?.value === 'true') {
        console.log(`[AI] Auto-callback enabled — bridging callId=${state.callId} to ${transferNumber}`);
        await autoTransferToConference(state.callId, call.twilio_call_sid as string, transferNumber, baseUrl);
      }
    }
  } catch (err) {
    console.error(`[AI] handleAgentDetected error:`, err);
  }
}

async function handleVoicemail(state: SessionState) {
  if (state.isTerminated) return;
  state.isTerminated = true;
  callSessions.delete(state.callId);
  state.ivrExecutor?.destroy();

  console.log(`[AI] VOICEMAIL DETECTED callId=${state.callId}`);

  try {
    await sql`UPDATE calls SET status = 'failed', error_message = 'Voicemail detected', updated_at = NOW() WHERE id = ${state.callId}`;
    await sql`INSERT INTO call_events (call_id, event_type, details) VALUES (${state.callId}, 'voicemail_detected', '{}')`;
    await saveLiveTranscript(state.callId).catch(() => {});
    if (state.callSid) {
      await twilioClient.calls(state.callSid).update({ status: 'completed' }).catch(() => {});
    }
  } catch (err) {
    console.error(`[AI] handleVoicemail error:`, err);
  }
}

async function endCallMaxDuration(state: SessionState) {
  if (state.isTerminated) return;
  state.isTerminated = true;
  callSessions.delete(state.callId);
  state.ivrExecutor?.destroy();

  console.log(`[MediaWS] Max duration reached callId=${state.callId}`);

  try {
    await sql`UPDATE calls SET status = 'failed', error_message = 'Max call duration exceeded', updated_at = NOW() WHERE id = ${state.callId}`;
    await sql`INSERT INTO call_events (call_id, event_type, details) VALUES (${state.callId}, 'max_duration_exceeded', '{}')`;
    await saveLiveTranscript(state.callId).catch(() => {});
    if (state.callSid) {
      await twilioClient.calls(state.callSid).update({ status: 'completed' }).catch(() => {});
    }
  } catch (err) {
    console.error(`[MediaWS] endCallMaxDuration error:`, err);
  }
}

/**
 * Auto-transfer: bridge the cruise line call with the customer's phone via Twilio conference.
 * Same logic as /api/calls/transfer but triggered automatically on agent detection.
 */
async function autoTransferToConference(callId: string, twilioCallSid: string, transferNumber: string, baseUrl: string) {
  try {
    const conferenceRoom = `CruisePro-${callId}`;

    // Move cruise line call into conference
    await twilioClient.calls(twilioCallSid).update({
      twiml: `<Response><Dial><Conference>${conferenceRoom}</Conference></Dial></Response>`,
    });

    // Call the customer and add them to the conference
    await twilioClient.calls.create({
      to: transferNumber,
      from: twilioPhone,
      twiml: `<Response><Say voice="alice">You are being connected to a live cruise line agent. Please hold for one moment.</Say><Dial><Conference>${conferenceRoom}</Conference></Dial></Response>`,
      statusCallback: `${baseUrl}/api/calls/status`,
      statusCallbackMethod: 'POST',
    });

    await sql`UPDATE calls SET status = 'connected', updated_at = NOW() WHERE id = ${callId}`;
    await sql`
      INSERT INTO call_events (call_id, event_type, details)
      VALUES (${callId}, 'auto_transfer_initiated', ${JSON.stringify({ transferNumber, conferenceRoom })})
    `;

    console.log(`[AI] Auto-transfer complete — conference=${conferenceRoom}`);
  } catch (err: any) {
    console.error(`[AI] Auto-transfer failed:`, err?.message ?? err);
  }
}

function cleanup(state: SessionState) {
  if (state.isTerminated) return;
  state.isTerminated = true;
  callSessions.delete(state.callId);
  state.ivrExecutor?.destroy();

  if (state.maxDurationTimer) {
    clearTimeout(state.maxDurationTimer);
    state.maxDurationTimer = null;
  }
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  try {
    if (state.dgSocket) state.dgSocket.close();
  } catch {}

  // Save live transcript to calls.transcript as fallback
  // (post-call Deepgram transcription may overwrite this with better quality later)
  saveLiveTranscript(state.callId).catch((err) =>
    console.error(`[MediaWS] saveLiveTranscript error:`, err?.message ?? err)
  );
}

/**
 * Aggregate all live transcript events into calls.transcript so the UI
 * always has something to display — even if post-call transcription fails.
 * Only writes if calls.transcript is currently NULL (won't overwrite
 * a higher-quality post-call Deepgram transcript).
 */
async function saveLiveTranscript(callId: string) {
  const events = await sql`
    SELECT event_type, details, created_at
    FROM call_events
    WHERE call_id = ${callId}
      AND event_type IN ('transcript', 'ai_action')
    ORDER BY created_at ASC
  `;

  if (events.length === 0) return;

  const utterances: Array<{ speaker: number; text: string; start: number; end: number }> = [];
  const startTime = new Date(events[0].created_at as string).getTime() / 1000;

  for (const ev of events) {
    const details = typeof ev.details === 'string' ? JSON.parse(ev.details as string) : ev.details;
    const ts = new Date(ev.created_at as string).getTime() / 1000 - startTime;

    if (ev.event_type === 'transcript') {
      utterances.push({ speaker: 0, text: details.text ?? '', start: ts, end: ts + 1 });
    } else if (ev.event_type === 'ai_action' && details.action === 'SAY') {
      utterances.push({ speaker: 1, text: details.phrase ?? '', start: ts, end: ts + 1 });
    }
  }

  if (utterances.length === 0) return;

  const text = utterances.map((u) => `${u.speaker === 0 ? 'IVR' : 'System'}: ${u.text}`).join('\n');
  const transcript = JSON.stringify({ utterances, text });

  // Only set if transcript is currently NULL — don't overwrite post-call Deepgram result
  await sql`
    UPDATE calls
    SET transcript = ${transcript}, updated_at = NOW()
    WHERE id = ${callId} AND transcript IS NULL
  `;

  console.log(`[MediaWS] Saved live transcript (${utterances.length} utterances) for callId=${callId}`);
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
