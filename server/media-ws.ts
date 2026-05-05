import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import { twilioClient } from '@/lib/twilio';
import { decideAction, detectAgentWithAI, ConversationTurn } from './ai-navigator';
import { detectAgentFromTranscript, detectVirtualAssistant, detectVoicemail } from '@/lib/deepgram';
import { notifyAgentDetected } from '@/lib/notifications';
import { generateTTSMulaw, streamTTSMulaw } from '@/lib/openai-tts';
import { generateConversationResponse, ConversationTurn as ConvTurn } from './conversation-engine';

import { IVRExecutor, ExecutorAction } from './ivr-executor';
import { IVRStep } from '@/lib/ivr-engine';
import sql from '@/lib/db';

const MAX_CALL_DURATION_MS = 90 * 60 * 1000; // 90 minutes
const DG_RETRY_DELAYS = [500, 1500, 4000, 8000, 15000, 30000]; // 6 retries with backoff

/**
 * Module-level session map so IVR executor state survives WebSocket reconnections.
 *
 * When dispatchAction (PRESS / SAY) updates Twilio TwiML, Twilio closes the current
 * stream and opens a NEW WebSocket connection seconds later.  Without this map we'd
 * create a brand-new IVRExecutor starting at step 0 every time.  With it, the
 * existing executor keeps running and the new WS just picks up the same state.
 */
// Use Node.js global so the Map is shared across all module instances in the
// same process (Next.js API routes load this file separately from server.ts).
// Without this, injectTTSIntoCall/injectRealtimeInstruction always return false.
declare global {
  // eslint-disable-next-line no-var
  var _callSessions: Map<string, SessionState> | undefined;
}
const callSessions: Map<string, SessionState> = (global._callSessions ??= new Map());

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
  /** Set to true if a virtual assistant phrase has been heard — suppresses agent detection. */
  isVirtualAssistant: boolean;
  /** True once the AI conversation mode is active (after cruise agent picks up). */
  aiConversationMode: boolean;
  /** Running history of the AI conversation with the cruise agent. */
  aiConversationHistory: ConvTurn[];
  /** True while TTS audio is being injected — suppresses echo transcription. */
  isConvSpeaking: boolean;
  /** The user's typed task/goal — fetched once from DB on agent detection. */
  aiTask: string | null;
  /** OpenAI Realtime API WebSocket — handles STT+LLM+TTS in one low-latency pipeline. */
  openaiRtWs: WebSocket | null;
  /** Accumulate AI response text across delta events for DB storage. */
  aiResponseBuffer: string;
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

            if (state.aiConversationMode) {
              // AI conversation mode — use OpenAI Realtime, skip Deepgram
              if (!state.openaiRtWs || state.openaiRtWs.readyState === WebSocket.CLOSED || state.openaiRtWs.readyState === WebSocket.CLOSING) {
                connectOpenAIRealtime(state).catch((err) =>
                  console.error(`[OpenAI RT] Reconnect error callId=${callId}:`, err)
                );
              }
            } else {
              // IVR mode — reconnect Deepgram only if closed/closing
              const rs = state.dgSocket?.readyState ?? WebSocket.CLOSED;
              if (rs === WebSocket.CLOSING || rs === WebSocket.CLOSED) {
                connectDeepgram(state, 0).catch((err) =>
                  console.error(`[MediaWS] DG reconnect error on WS reconnect:`, err)
                );
              }
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
            isVirtualAssistant: false,
            twilioWs: ws,
            aiConversationMode: false,
            aiConversationHistory: [],
            isConvSpeaking: false,
            aiTask: null,
            openaiRtWs: null,
            aiResponseBuffer: '',
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
          if (state.aiConversationMode && state.openaiRtWs?.readyState === WebSocket.OPEN) {
            // OpenAI Realtime is connected — send audio directly (g711_ulaw passthrough, no conversion).
            state.openaiRtWs.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: msg.media.payload,
            }));
          } else if (state.dgSocket?.readyState === WebSocket.OPEN) {
            // Deepgram fallback — works for both IVR mode and AI conversation mode when RT is unavailable.
            state.dgSocket.send(Buffer.from(msg.media.payload, 'base64'));
          }
          break;
        }

        case 'mark': {
          // Twilio sends this when audio playback reaches a mark we sent
          console.log(`[MediaWS] Mark received: ${msg.mark?.name} callId=${state?.callId}`);
          if (state && msg.mark?.name?.startsWith('conv-tts-done-')) {
            // Give 300ms buffer after playback before listening for agent reply
            setTimeout(() => { if (state) state.isConvSpeaking = false; }, 300);
          }
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

    // If a newer WS has already taken over (race: new WS connected before this
    // close event fired), this close is stale — just decrement the counter and
    // bail out without scheduling cleanup or calling cleanup().
    const isCurrentWs = state.twilioWs === ws;

    if (state.pendingCloses > 0) {
      state.pendingCloses--;
      // Only start the reconnect timer if no new WS has already arrived.
      if (state.pendingCloses === 0 && !state.reconnectTimer && !state.isTerminated && isCurrentWs) {
        const scheduleCleanup = (delay: number) => {
          state!.reconnectTimer = setTimeout(() => {
            state!.reconnectTimer = null;
            if (state!.isTerminated) return;
            // If Twilio still has an upgrade in flight, give it more time.
            const pending = (globalThis as { _pendingMediaUpgrades?: number })._pendingMediaUpgrades ?? 0;
            if (pending > 0 && state!.twilioWs?.readyState !== WebSocket.OPEN) {
              console.log(`[MediaWS] Reconnect pending (${pending} upgrades in flight) — extending wait callId=${state!.callId}`);
              scheduleCleanup(10_000);
              return;
            }
            // If the WS slot has already been replaced, don't cleanup.
            if (state!.twilioWs && state!.twilioWs !== ws && state!.twilioWs.readyState === WebSocket.OPEN) {
              console.log(`[MediaWS] New WS already active — skipping cleanup callId=${state!.callId}`);
              return;
            }
            console.log(`[MediaWS] No WS reconnect within window — cleaning up callId=${state!.callId}`);
            cleanup(state!);
          }, delay);
        };
        scheduleCleanup(30_000);
      }
    } else if (!state.isTerminated && isCurrentWs) {
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
  if (state.isTerminated) return;

  // Route to conversation processor when in AI conversation mode
  if (state.aiConversationMode) {
    if (state.isConvSpeaking) {
      console.log(`[ConvMode] Suppressed transcript (AI speaking): "${transcript.substring(0, 60)}"`);
    } else {
      await processConversationSpeech(state, transcript);
    }
    return;
  }

  if (state.isAgentDetected) return;

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

  // 2. Virtual assistant detection — suppress agent detection for this session
  if (detectVirtualAssistant(transcript)) {
    console.log(`[IVR] Virtual assistant detected — suppressing agent detection callId=${state.callId}`);
    state.isVirtualAssistant = true;
  }

  // 3. Agent detection — phrase match as fast pre-filter, then AI confirmation
  if (!state.isVirtualAssistant && detectAgentFromTranscript(transcript)) {
    // Phrase matched — confirm with AI before triggering transfer
    const recentHistory = state.history.slice(-4).map((t) => `${t.speaker}: ${t.text}`);
    const isRealAgent = await detectAgentWithAI(transcript, recentHistory);
    if (isRealAgent) {
      await handleAgentDetected(state, transcript);
      return;
    } else {
      console.log(`[IVR] Phrase matched but AI says NOT a real agent — skipping callId=${state.callId}`);
    }
  }

  // 3. IVR executor mode
  if (state.ivrExecutor && !state.ivrExecutor.isDone()) {
    state.ivrExecutor.onTranscript(transcript);

    if (state.ivrExecutor.isInHoldMode()) {
      await checkHoldStatus(state);

      // Auto-press to stay on hold when prompted (e.g. "press 1 to continue holding")
      const stayOnHoldMatch =
        transcript.match(/press\s+(\d+)\s+to\s+(?:stay|continue|remain|keep)/i) ||
        transcript.match(/press\s+(\d+)\s+(?:if you|to hold)/i) ||
        transcript.match(/press\s+(\d+)\s+(?:and we|to be called|for a callback)/i);
      if (stayOnHoldMatch) {
        const digit = stayOnHoldMatch[1];
        console.log(`[IVR] Stay-on-hold prompt detected — pressing ${digit} callId=${state.callId}`);
        await dispatchAction(state, { type: 'PRESS', digit }).catch(() => {});
        return;
      }

      // Per-transcript VA check: the persistent isVirtualAssistant flag may have been set during IVR
      // but a real human can still pick up after hold. Check each transcript fresh instead.
      // Still skip if THIS transcript itself contains VA phrases (e.g. VA talks after entering hold).
      // Threshold is 1 word — real agents often just say "Hello." — the AI classifier filters false positives.
      if (!detectVirtualAssistant(transcript) && transcript.trim().split(/\s+/).length >= 1) {
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

// ─── AI Conversation Mode helpers ────────────────────────────────────────────

/**
 * Inject TTS audio into the live call and record a conversation_ai_say event.
 * Exported so API routes (/api/calls/speak, /api/calls/ai-respond) can call it.
 */
async function dispatchConversationSay(state: SessionState, text: string): Promise<void> {
  state.isConvSpeaking = true;

  // Persist so SSE delivers it to the dashboard
  await sql`
    INSERT INTO call_events (call_id, event_type, details)
    VALUES (${state.callId}, 'conversation_ai_say', ${JSON.stringify({ text, timestamp: Date.now() })})
  `.catch(() => {});

  state.aiConversationHistory.push({ speaker: 'us', text, timestamp: Date.now() });

  try {
    // Stream audio chunks to Twilio as soon as OpenAI generates them —
    // first word plays within ~0.5s instead of waiting for the full response.
    await streamTTSMulaw(text, (chunk) => {
      if (state.twilioWs && state.twilioWs.readyState === WebSocket.OPEN) {
        state.twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid: state.streamSid,
          media: { payload: chunk.toString('base64') },
        }));
      }
    });
    if (state.twilioWs && state.twilioWs.readyState === WebSocket.OPEN) {
      state.twilioWs.send(JSON.stringify({
        event: 'mark',
        streamSid: state.streamSid,
        mark: { name: `conv-tts-done-${Date.now()}` },
      }));
    }
  } catch (err: unknown) {
    console.error(`[ConvMode] TTS injection failed:`, err);
    state.isConvSpeaking = false;
  }
}

/** Called when the cruise agent speaks during AI conversation mode. */
async function processConversationSpeech(state: SessionState, transcript: string): Promise<void> {
  // Set immediately (before any await) to prevent concurrent calls from both
  // generating a response when two transcripts arrive at the same time.
  state.isConvSpeaking = true;
  state.lastTranscriptAt = Date.now();
  console.log(`[ConvMode] Agent said: "${transcript}" callId=${state.callId}`);

  await sql`
    INSERT INTO call_events (call_id, event_type, details)
    VALUES (${state.callId}, 'conversation_transcript', ${JSON.stringify({ text: transcript, speaker: 'agent', timestamp: Date.now() })})
  `.catch(() => {});

  state.aiConversationHistory.push({ speaker: 'agent', text: transcript, timestamp: Date.now() });

  try {
    const response = await generateConversationResponse(state.aiConversationHistory, state.callId, state.aiTask);
    if (response) {
      await dispatchConversationSay(state, response);
    } else {
      // AI chose to stay silent — release the speaking lock so next agent turn is heard
      state.isConvSpeaking = false;
    }
  } catch (err) {
    console.error(`[ConvMode] generateConversationResponse error:`, err);
    state.isConvSpeaking = false;
  }
}

/**
 * Exported injection bridge — called by /api/calls/speak and /api/calls/ai-respond.
 * Works because API routes and the WS server share the same Node.js process.
 */
export async function injectTTSIntoCall(callId: string, text: string): Promise<{ ok: boolean; reason?: string }> {
  const state = callSessions.get(callId);
  if (!state) return { ok: false, reason: `callId not in sessions (map size=${callSessions.size})` };
  if (state.isTerminated) return { ok: false, reason: 'call terminated' };
  if (!state.aiConversationMode) return { ok: false, reason: 'not in ai_conversation mode' };
  if (!state.twilioWs || state.twilioWs.readyState !== WebSocket.OPEN) {
    return { ok: false, reason: `Twilio WS readyState=${state.twilioWs?.readyState ?? 'null'}` };
  }
  await dispatchConversationSay(state, text);
  return { ok: true };
}

/**
 * Send a real-time instruction to OpenAI Realtime so the AI reformulates it
 * naturally and speaks it. Used by /api/calls/speak so the user can guide
 * the AI mid-conversation without directly scripting what it says.
 */
export function injectRealtimeInstruction(callId: string, instruction: string): boolean {
  const state = callSessions.get(callId);
  if (!state) { console.warn(`[Speak] callId=${callId} not in callSessions (map size=${callSessions.size})`); return false; }
  if (state.isTerminated) { console.warn(`[Speak] callId=${callId} isTerminated`); return false; }
  if (!state.aiConversationMode) { console.warn(`[Speak] callId=${callId} not in aiConversationMode`); return false; }
  if (!state.openaiRtWs || state.openaiRtWs.readyState !== WebSocket.OPEN) {
    console.warn(`[Speak] callId=${callId} OpenAI RT not ready (readyState=${state.openaiRtWs?.readyState ?? 'null'})`);
    return false;
  }

  state.openaiRtWs.send(JSON.stringify({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `[USER INSTRUCTION] ${instruction}` }],
    },
  }));
  state.openaiRtWs.send(JSON.stringify({ type: 'response.create' }));
  console.log(`[OpenAI RT] Instruction injected callId=${callId}: "${instruction.substring(0, 60)}"`);
  return true;
}

export function getConversationHistory(callId: string): ConvTurn[] | null {
  const state = callSessions.get(callId);
  if (!state || !state.aiConversationMode) return null;
  return state.aiConversationHistory;
}

export function getAiTask(callId: string): string | null {
  return callSessions.get(callId)?.aiTask ?? null;
}

/**
 * Manually inject a DTMF digit into an active call during IVR navigation.
 * Safe to call while the AI executor is also running — they share the same state.
 */
export async function pressDigitOnCall(callId: string, digit: string): Promise<{ ok: boolean; reason?: string }> {
  const state = callSessions.get(callId);
  if (!state) return { ok: false, reason: `No active session for callId=${callId}` };
  if (state.isTerminated) return { ok: false, reason: 'call terminated' };
  if (!state.callSid) return { ok: false, reason: 'callSid not yet set' };
  try {
    await dispatchAction(state, { type: 'PRESS', digit });
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function handleAgentDetected(state: SessionState, transcript: string) {
  if (state.isAgentDetected || state.isTerminated) return;
  state.isAgentDetected = true;
  state.ivrExecutor?.destroy();

  console.log(`[AI] AGENT DETECTED callId=${state.callId}`);

  // Fetch user/call data — needed to branch on ai_task and get notification_phone.
  // This is a single fast query; done before anything else so the branch is correct.
  let call: Record<string, unknown> | null = null;
  try {
    const rows = await sql`
      SELECT c.*, u.notification_phone, u.connect_message, u.transfer_numbers,
             (SELECT value FROM settings WHERE user_id = u.id AND key = 'auto_callback_enabled' LIMIT 1) as auto_callback_enabled
      FROM calls c
      JOIN users u ON u.id = c.user_id
      WHERE c.id = ${state.callId}
      LIMIT 1
    `;
    if (rows.length === 0) return;
    call = rows[0] as Record<string, unknown>;
  } catch (err) {
    console.error(`[AI] handleAgentDetected DB fetch error callId=${state.callId}:`, err);
    // Can't determine ai_task — fall through to simple flow to be safe
  }

  const aiTask = (call?.ai_task as string | null) || null;
  state.aiTask = aiTask;

  // ── Branch: AI task set → AI conversation mode ────────────────────────────
  if (aiTask) {
    state.aiConversationMode = true;
    state.aiConversationHistory = [];
    state.isConvSpeaking = false;

    // Fire Twilio stream reconnect + OpenAI RT immediately (no further DB blocking)
    if (state.callSid) {
      const streamUrl = STREAM_URL();
      state.pendingRedirects++;
      twilioClient.calls(state.callSid).update({
        twiml: `<Response><Connect><Stream url="${streamUrl}" bidirectional="true"><Parameter name="callId" value="${state.callId}"/></Stream></Connect></Response>`,
      }).then(() => {
        console.log(`[AI] Entered ai_conversation mode callId=${state.callId} task="${aiTask.substring(0, 40)}"`);
      }).catch((err) => {
        console.error(`[AI] Twilio update error callId=${state.callId}:`, err);
      });
    }

    connectOpenAIRealtime(state).catch((err) =>
      console.error(`[OpenAI RT] Initial connect error callId=${state.callId}:`, err)
    );

    // DB updates in background
    (async () => {
      try {
        await sql`
          UPDATE calls
          SET status = 'ai_conversation',
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
        `.catch(() => {});
        const baseUrl = BASE_URL();
        if (call?.notification_phone) {
          await notifyAgentDetected(state.callId, call.notification_phone as string, baseUrl).catch(() => {});
        }
      } catch (err) {
        console.error(`[AI] handleAgentDetected DB update error (non-fatal):`, err);
      }
    })();

    return;
  }

  // ── Branch: No task → simple flow (agent_detected status, SMS, manual or auto transfer) ──
  console.log(`[AI] No task set — using simple connect flow callId=${state.callId}`);

  const connectMsg = (call?.connect_message as string | null) ||
    'Thank you for your patience. We are connecting you to our customer now. Please hold for just a moment.';

  const autoConnect = call?.auto_callback_enabled === 'true';
  console.log(`[AI] autoConnect=${autoConnect} transferNumber=${transferNumber} callId=${state.callId}`);

  // Resolve transfer number
  const transferNums = (call?.transfer_numbers ?? []) as Array<{ phone: string; isDefault: boolean }>;
  const transferNumber = (call?.transfer_number as string | null) ??
    transferNums.find((n) => n.isDefault)?.phone ??
    transferNums[0]?.phone ??
    null;

  // DB updates in background
  (async () => {
    try {
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
      `.catch(() => {});
      const baseUrl = BASE_URL();
      if (call?.notification_phone) {
        await notifyAgentDetected(state.callId, call.notification_phone as string, baseUrl).catch(() => {});
      }
    } catch (err) {
      console.error(`[AI] handleAgentDetected simple-flow DB error (non-fatal):`, err);
    }
  })();

  if (autoConnect && transferNumber && state.callSid) {
    // Auto-connect: bridge the cruise agent into a conference and call the user immediately
    console.log(`[AI] Auto-connect enabled — bridging callId=${state.callId} to ${transferNumber}`);
    const conferenceRoom = `CruisePro-${state.callId}`;
    const escapedMsg = connectMsg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    twilioClient.calls(state.callSid).update({
      twiml: `<Response><Say voice="Polly.Joanna">${escapedMsg}</Say><Dial><Conference>${conferenceRoom}</Conference></Dial></Response>`,
    }).then(() =>
      twilioClient.calls.create({
        to: transferNumber,
        from: twilioPhone,
        twiml: `<Response><Say voice="alice">You are being connected to a live cruise line agent. Please hold for one moment.</Say><Dial><Conference>${conferenceRoom}</Conference></Dial></Response>`,
      })
    ).then(() =>
      sql`UPDATE calls SET status = 'connected', updated_at = NOW() WHERE id = ${state.callId}`.catch(() => {})
    ).catch((err) => console.error(`[AI] Auto-connect error callId=${state.callId}:`, err));
  } else {
    // Manual: play connect message and keep stream alive so user can click Transfer
    if (state.callSid) {
      const streamUrl = STREAM_URL();
      state.pendingRedirects++;
      twilioClient.calls(state.callSid).update({
        twiml: `<Response><Say voice="Polly.Joanna">${connectMsg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Say><Connect><Stream url="${streamUrl}" bidirectional="true"><Parameter name="callId" value="${state.callId}"/></Stream></Connect></Response>`,
      }).catch((err) => console.error(`[AI] Simple-flow Twilio update error:`, err));
    }
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

// ─── OpenAI Realtime API ─────────────────────────────────────────────────────

/**
 * Poll until the Twilio bidirectional stream is open, then trigger OpenAI to
 * speak the opening greeting. This handles the race between the TwiML redirect
 * (which briefly closes/reopens the stream) and the OpenAI RT connection.
 */
function scheduleOpeningSpeech(state: SessionState, rtWs: WebSocket, attempt: number): void {
  if (state.isTerminated || rtWs.readyState !== WebSocket.OPEN) return;
  if (state.aiConversationHistory.length > 0) return; // already spoken

  if (state.twilioWs?.readyState === WebSocket.OPEN) {
    console.log(`[OpenAI RT] Triggering opening speech callId=${state.callId}`);
    rtWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        instructions: state.aiTask
          ? `You just connected to a cruise line agent. Greet them warmly and immediately state: ${state.aiTask}. Keep it to 1-2 natural sentences. IMPORTANT: Always respond in English only, never any other language.`
          : `You just connected to a cruise line agent. Say exactly: "Hi, thank you for answering. Please hold for just a moment while I transfer you." Speak clearly and naturally. English only.`,
      },
    }));
  } else if (attempt < 20) {
    // Twilio stream not yet reconnected — retry every 200ms (up to 4s total)
    setTimeout(() => scheduleOpeningSpeech(state, rtWs, attempt + 1), 200);
  } else {
    console.warn(`[OpenAI RT] Gave up waiting for Twilio stream callId=${state.callId}`);
  }
}

/**
 * Connect to the OpenAI Realtime API and relay audio between Twilio and OpenAI.
 * Replaces the Deepgram → GPT-4o → TTS pipeline with a single low-latency connection.
 * First audio from OpenAI arrives within ~300ms of the agent speaking.
 */
async function connectOpenAIRealtime(state: SessionState): Promise<void> {
  if (state.openaiRtWs) return; // already connected

  console.log(`[OpenAI RT] Connecting callId=${state.callId}`);

  const rtWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
    {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  );
  state.openaiRtWs = rtWs;

  rtWs.on('open', () => {
    console.log(`[OpenAI RT] Connected callId=${state.callId}`);

    // Configure session: g711_ulaw matches Twilio's mulaw format directly.
    // coral is OpenAI's most natural-sounding conversational voice.
    rtWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: buildRtSystemPrompt(state.aiTask),
        voice: 'coral',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.65,
          prefix_padding_ms: 300,
          silence_duration_ms: 1500,
        },
      },
    }));

    // If this is the opening (no history yet), speak the greeting once the
    // Twilio bidirectional stream is confirmed open. We poll briefly because
    // the TwiML redirect that restarts the stream may not have completed yet.
    if (state.aiConversationMode && state.aiConversationHistory.length === 0) {
      scheduleOpeningSpeech(state, rtWs, 0);
    } else if (state.aiConversationHistory.length > 0) {
      // Reconnected mid-conversation — replay history so OpenAI has context
      for (const turn of state.aiConversationHistory) {
        rtWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: turn.speaker === 'us' ? 'assistant' : 'user',
            content: [{ type: 'input_text', text: turn.text }],
          },
        }));
      }
    }
  });

  rtWs.on('message', async (raw: WebSocket.RawData) => {
    try {
      const event = JSON.parse(raw.toString());

      switch (event.type) {
        case 'response.audio.delta':
          // Forward audio chunk to Twilio immediately (~300ms latency)
          if (state.twilioWs?.readyState === WebSocket.OPEN) {
            state.twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid: state.streamSid,
              media: { payload: event.delta }, // already base64 g711_ulaw
            }));
          }
          break;

        case 'response.audio_transcript.delta':
          state.aiResponseBuffer += event.delta ?? '';
          break;

        case 'response.audio_transcript.done': {
          const text = state.aiResponseBuffer.trim();
          state.aiResponseBuffer = '';
          if (text) {
            state.aiConversationHistory.push({ speaker: 'us', text, timestamp: Date.now() });
            await sql`
              INSERT INTO call_events (call_id, event_type, details)
              VALUES (${state.callId}, 'conversation_ai_say', ${JSON.stringify({ text, timestamp: Date.now() })})
            `.catch(() => {});
            console.log(`[OpenAI RT] AI said: "${text.substring(0, 80)}" callId=${state.callId}`);
          }
          break;
        }

        case 'conversation.item.input_audio_transcription.completed': {
          const agentText = (event.transcript as string | undefined)?.trim();
          if (agentText) {
            state.aiConversationHistory.push({ speaker: 'agent', text: agentText, timestamp: Date.now() });
            await sql`
              INSERT INTO call_events (call_id, event_type, details)
              VALUES (${state.callId}, 'conversation_transcript', ${JSON.stringify({ text: agentText, speaker: 'agent', timestamp: Date.now() })})
            `.catch(() => {});
            console.log(`[OpenAI RT] Agent said: "${agentText.substring(0, 80)}" callId=${state.callId}`);
          }
          break;
        }

        case 'error':
          console.error(`[OpenAI RT] API error callId=${state.callId}:`, event.error);
          break;
      }
    } catch (err) {
      console.error(`[OpenAI RT] Message handler error callId=${state.callId}:`, err);
    }
  });

  rtWs.on('close', (code) => {
    console.log(`[OpenAI RT] Closed code=${code} callId=${state.callId}`);
    if (state.openaiRtWs === rtWs) state.openaiRtWs = null;
  });

  rtWs.on('error', (err) => {
    console.error(`[OpenAI RT] WS error callId=${state.callId}:`, err.message);
    if (state.openaiRtWs === rtWs) state.openaiRtWs = null;
  });
}

function buildRtSystemPrompt(aiTask: string | null): string {
  return `You are a polite customer calling a cruise line. Your goal: "${aiTask ?? 'Inquire about cruise options'}".

CRITICAL: You MUST always respond in English only. Never use Spanish, French, or any other language under any circumstances, regardless of what language you hear.

Rules:
- English only — every single response, no exceptions.
- Keep every response to 1-2 sentences. Be natural and conversational.
- If asked for your name, say "My name is Alex."
- If asked for account info or credentials you don't have (IATA number, booking ID, etc.), say "Let me check that with my travel agent, one moment."
- If the agent can't help or asks to speak with a manager, say "Of course, let me transfer you now."
- Never break character. You are the customer, the person on the other end is the cruise line agent.`;
}

// ─────────────────────────────────────────────────────────────────────────────

function cleanup(state: SessionState) {
  if (state.isTerminated) return;
  state.isTerminated = true;
  callSessions.delete(state.callId);
  state.ivrExecutor?.destroy();

  // Close OpenAI Realtime connection if active
  try { state.openaiRtWs?.close(); } catch {}
  state.openaiRtWs = null;

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
      AND event_type IN ('transcript', 'ai_action', 'conversation_transcript', 'conversation_ai_say')
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
    } else if (ev.event_type === 'conversation_transcript') {
      utterances.push({ speaker: 0, text: details.text ?? '', start: ts, end: ts + 1 });
    } else if (ev.event_type === 'conversation_ai_say') {
      utterances.push({ speaker: 1, text: details.text ?? '', start: ts, end: ts + 1 });
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
