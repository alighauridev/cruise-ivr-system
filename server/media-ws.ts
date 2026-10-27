import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import { twilioClient, twilioPhone } from '@/lib/twilio';
import { decideAction, detectAgentWithAI, ConversationTurn } from './ai-navigator';
import { detectAgentFromTranscript, detectVirtualAssistant, detectVoicemail } from '@/lib/deepgram';
import { notifyAgentDetected } from '@/lib/notifications';
import { generateTTSMulaw, streamTTSMulaw } from '@/lib/openai-tts';
import { ConversationTurn as ConvTurn } from './conversation-engine';
import {
  AiOutcome,
  AiTaskDetails,
  AGENT_TOOLS,
  buildAgentInstructions,
  buildOpeningInstruction,
  looksLikeSurveyOrIvr,
  outcomeLabel,
  resolveTask,
  summarizeTranscript,
} from './ai-call-agent';
import { sendSMS } from '@/lib/twilio';
import { AiEngine, ClaudeVoiceSession, resolveAiEngine } from './claude-voice';

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
  /** Times a bare "Hello?" was heard recently — a person waiting for us to speak (menus don't repeat it). */
  helloTimes: number[];
  /** Last few things heard from the line (with time), so the AI knows how the rep greeted us. */
  recentHeard: Array<{ text: string; at: number }>;
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
  /**
   * Call + user config (transfer numbers, connect_message, ai_task, auto_callback,
   * notification_phone), pre-loaded at call start so handleAgentDetected never has
   * to block on a DB query at the critical moment the agent picks up.
   */
  callConfig: Record<string, unknown> | null;
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
  /** Structured task form for the AI agent (falls back to aiTask free text). */
  aiTaskDetails: AiTaskDetails | null;
  /** Set once end_call / transfer_to_team / survey-cutoff has started — the AI stops talking. */
  aiFinishing: boolean;
  /** Set once ai_outcome + ai_summary are saved, so cleanup doesn't write a fallback summary. */
  aiOutcomeSaved: boolean;
  /** Twilio mark name that, when played, triggers the pending finish action. */
  pendingFinishMark: string | null;
  pendingFinishAction: (() => Promise<void>) | null;
  finishFallbackTimer: ReturnType<typeof setTimeout> | null;
  /** Which brain runs AI calls: Claude (Deepgram → Claude → TTS) or OpenAI Realtime. */
  aiEngine: AiEngine;
  /** The Claude voice pipeline for this call (aiEngine === 'claude'). */
  claude: ClaudeVoiceSession | null;
  /** True while OpenAI is generating a response (used for barge-in). */
  rtResponseActive: boolean;
  /** Mark sent after the AI's latest response; non-null while that audio is still playing. */
  aiPlaybackMark: string | null;
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

            if (state.aiConversationMode && state.aiEngine === 'claude') {
              // Claude pipeline keeps running; it sends audio through state.twilioWs, now updated.
            } else if (state.aiConversationMode) {
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
            helloTimes: [],
            recentHeard: [],
            isTerminated: false,
            pendingRedirects: 0,
            pendingCloses: 0,
            dgSocket: null,
            ivrSteps: null,
            callConfig: null,
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
            aiTaskDetails: null,
            aiFinishing: false,
            aiOutcomeSaved: false,
            pendingFinishMark: null,
            pendingFinishAction: null,
            finishFallbackTimer: null,
            aiEngine: 'openai',
            claude: null,
            rtResponseActive: false,
            aiPlaybackMark: null,
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
          if (state.aiConversationMode && state.claude) {
            // Claude engine — the voice pipeline owns its own Deepgram connection.
            state.claude.pushAudio(msg.media.payload);
          } else if (state.aiConversationMode && state.openaiRtWs?.readyState === WebSocket.OPEN) {
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
          if (state && state.aiPlaybackMark && msg.mark?.name === state.aiPlaybackMark) {
            state.aiPlaybackMark = null;
          }
          if (state && state.pendingFinishMark && msg.mark?.name === state.pendingFinishMark) {
            // The AI's last sentence has finished playing — now hang up / hand off.
            runPendingFinish(state);
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
  // Load IVR config + connect config from DB in ONE query at call start.
  // Caching the connect config (transfer numbers, message, ai_task, auto_callback)
  // means handleAgentDetected never blocks on a DB query when the agent picks up —
  // the "please hold" message + bridge fire instantly instead of waiting on a slow
  // (sometimes 10s+ on a Neon cold connection) query at the worst possible moment.
  try {
    const rows = await sql`
      SELECT c.*, ic.steps,
             u.notification_phone, u.connect_message, u.transfer_numbers,
             (SELECT value FROM settings WHERE user_id = u.id AND key = 'auto_callback_enabled' LIMIT 1) as auto_callback_enabled,
             (SELECT value FROM settings WHERE user_id = u.id AND key = 'ai_engine' LIMIT 1) as ai_engine
      FROM calls c
      JOIN users u ON u.id = c.user_id
      LEFT JOIN ivr_configs ic ON ic.id = c.ivr_config_id
      WHERE c.id = ${state.callId}
      LIMIT 1
    `;
    if (rows[0]) {
      state.callConfig = rows[0] as Record<string, unknown>;
      const steps = rows[0].steps;
      if (steps && Array.isArray(steps) && steps.length > 0) {
        state.ivrSteps = steps as IVRStep[];
        console.log(`[MediaWS] Loaded ${state.ivrSteps.length} IVR steps for callId=${state.callId}`);
      } else {
        console.log(`[MediaWS] No IVR config for callId=${state.callId} — AI fallback mode`);
      }
    }
  } catch (err) {
    console.error(`[MediaWS] Failed to load call config:`, err);
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
      // In AI conversation mode OpenAI Realtime does the listening — don't reconnect Deepgram.
      if (!state.isTerminated && !state.aiConversationMode && attempt < DG_RETRY_DELAYS.length) {
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
    // OpenAI Realtime handles listening + replying. Deepgram transcripts that arrive
    // during the switchover must not trigger the legacy Deepgram→GPT→TTS pipeline:
    // it double-replied and its prompt posed as the guest. If Realtime fails, the
    // call is handed to the team instead (see connectOpenAIRealtime).
    return;
  }

  if (state.isAgentDetected) return;

  state.lastTranscriptAt = Date.now();
  console.log(`[IVR] Said: "${transcript}"`);
  state.recentHeard = [...state.recentHeard.slice(-5), { text: transcript, at: Date.now() }];

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

  // 2b. A bare "Hello?" said twice within 20s is a live person waiting for us to speak.
  // The AI classifier ignores a single "Hello?" (menus say it too), but menus don't repeat it.
  if (!state.isVirtualAssistant && BARE_GREETING.test(transcript.trim())) {
    const now = Date.now();
    state.helloTimes = [...state.helloTimes.filter((t) => now - t < 20_000), now];
    if (state.helloTimes.length >= 2) {
      console.log(`[IVR] Repeated "Hello?" — treating as live person callId=${state.callId}`);
      await handleAgentDetected(state, transcript);
      return;
    }
  }

  // 2c. A person introducing themselves or asking who's calling, once we're on hold: that's a
  // live rep — start right away instead of waiting ~1s on the classifier (which also said NO to
  // "This is Kevin on a recorded line. To whom do I have the pleasure of speaking?").
  if (state.ivrExecutor?.isInHoldMode() && looksLikeLiveRep(transcript)) {
    console.log(`[IVR] Live rep greeting on hold callId=${state.callId}`);
    await handleAgentDetected(state, transcript);
    return;
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
  if (state.claude) return state.claude.injectInstruction(instruction);
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

/** A rep's pick-up line: gives their name, or asks who is calling / how they can help — and is not a menu or ad. */
const REP_ASKS = /\b(?:to whom|who) (?:do i have|am i speaking|is calling|am i talking)|\bwho do i have the pleasure|\bhow (?:can|may) i (?:help|assist)|\bcan i (?:get|have) (?:your|the) (?:name|booking|reservation)|\bmy name is [a-z]+/i;
/** "This is Kevin" — a capitalized first name, not "This is Princess Cruises" / "This is a reminder". */
const REP_NAME = /\b(?:[Tt]his is|[Yy]ou(?:'re| are) speaking (?:with|to)) ([A-Z][a-z]+)\b/;
const NOT_A_NAME = /^(?:Princess|Carnival|Royal|Celebrity|Norwegian|Holland|Disney|Msc|MSC|Virgin|Cunard|Viking|Oceania|Regent|Seabourn|Silversea|Azamara|Windstar|Crystal|Explora|Atlas|Avalon|American|Business|Club|Your|Our|The|A|An|It|Not|Just|What|Why|How|Medallion|Alaska|Hawaii|Caribbean|Mexico|Europe|Bermuda|Canada|Japan|Australia|Asia|Antarctica|Panama|Greece|Italy|Spain|Iceland|Norway|Florida|Galveston|Seattle|Miami|Sail|Cruise|Vacation|Adventure|Paradise)$/;
const MENU_WORDS = /\b(?:press|para|option|menu|virtual assistant|automated|survey|estimated wait|your call is important|all (?:agents|representatives) are|please (?:continue to )?hold|visit|www|dot com)\b/i;
function looksLikeLiveRep(transcript: string): boolean {
  if (MENU_WORDS.test(transcript)) return false;
  if (REP_ASKS.test(transcript)) return true;
  const m = REP_NAME.exec(transcript);
  return !!m && !NOT_A_NAME.test(m[1]);
}

/** Only a greeting: "Hello?", "Hi.", "Hello? Hello?", "Can you hear me?". */
const BARE_GREETING = /^(?:(?:hello|hi|hey|can you hear me|is anyone there|anyone there)[\s.,?!]*)+$/i;

async function handleAgentDetected(state: SessionState, transcript: string) {
  if (state.isAgentDetected || state.isTerminated) return;
  state.isAgentDetected = true;
  state.ivrExecutor?.destroy();

  console.log(`[AI] AGENT DETECTED callId=${state.callId}`);

  // Use the config pre-loaded at call start — NO DB query in this hot path, so the
  // "please hold" message fires within ~1s of detection instead of blocking 10-20s
  // on a slow Neon connection. Only fall back to a query if the cache is missing.
  let call: Record<string, unknown> | null = state.callConfig;
  if (!call) {
    try {
      const rows = await sql`
        SELECT c.*, u.notification_phone, u.connect_message, u.transfer_numbers,
               (SELECT value FROM settings WHERE user_id = u.id AND key = 'auto_callback_enabled' LIMIT 1) as auto_callback_enabled,
               (SELECT value FROM settings WHERE user_id = u.id AND key = 'ai_engine' LIMIT 1) as ai_engine
        FROM calls c
        JOIN users u ON u.id = c.user_id
        WHERE c.id = ${state.callId}
        LIMIT 1
      `;
      call = rows[0] as Record<string, unknown> ?? null;
    } catch (err) {
      console.error(`[AI] handleAgentDetected DB fetch error callId=${state.callId}:`, err);
      // Can't determine ai_task — fall through to simple flow to be safe
    }
  }

  const taskDetails = resolveTask(call?.ai_task_details, (call?.ai_task as string | null) ?? null);
  state.aiTaskDetails = taskDetails;
  state.aiTask = taskDetails ? taskDetails.request : null;

  // ── Branch: AI task set → AI conversation mode ────────────────────────────
  if (taskDetails) {
    state.aiConversationMode = true;
    state.aiConversationHistory = [];
    state.isConvSpeaking = false;

    // No connect message and no TwiML redirect: the media stream is already
    // bidirectional, so the AI can speak on it right away. (The old redirect tore
    // the stream down just as the opening line was sent, so reps heard silence.)
    console.log(`[AI] Entered ai_conversation mode callId=${state.callId} task="${taskDetails.request.substring(0, 40)}"`);

    // Deepgram is no longer needed — OpenAI Realtime listens from here on.
    try { state.dgSocket?.close(); } catch {}

    state.aiEngine = resolveAiEngine(call?.ai_engine);
    console.log(`[AI] Engine=${state.aiEngine} callId=${state.callId}`);
    if (state.aiEngine === 'claude') {
      startClaudeVoice(state);
    } else {
      connectOpenAIRealtime(state).catch((err) => {
        console.error(`[OpenAI RT] Initial connect error callId=${state.callId}:`, err);
        handOffToTeam(state, 'AI voice could not start', 'The AI could not start, so the call was passed straight to the team.').catch(() => {});
      });
    }

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
    'Hello, thank you for taking the call. A live agent will be on the line with you in just one moment. ' +
    'Please hold during the transfer and stay on the line — do not hang up. Connecting you now.';

  const autoConnect = call?.auto_callback_enabled === 'true';

  // Resolve transfer number
  const transferNums = (call?.transfer_numbers ?? []) as Array<{ phone: string; isDefault: boolean }>;
  const transferNumber = (call?.transfer_number as string | null) ??
    transferNums.find((n) => n.isDefault)?.phone ??
    transferNums[0]?.phone ??
    null;

  console.log(`[AI] autoConnect=${autoConnect} transferNumber=${transferNumber} callId=${state.callId}`);

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
    // Auto-connect: the instant the agent is detected, keep THEM on the line with a
    // "please hold" message + conference hold music (so they never hear silence and
    // hang up), and dial the customer IN PARALLEL so their phone rings immediately.
    // Both legs join the same conference and bridge the moment the customer answers.
    console.log(`[AI] Auto-connect enabled — bridging callId=${state.callId} to ${transferNumber}`);
    const conferenceRoom = `CruisePro-${state.callId}`;
    const escapedMsg = connectMsg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // A conference with no waitUrl plays Twilio's default hold music to whoever is
    // waiting alone — that's what keeps the agent engaged until the customer joins.
    const conf = (extra = '') =>
      `<Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false"${extra}>${conferenceRoom}</Conference></Dial>`;

    // Reflect the bridge in the dashboard right away.
    sql`UPDATE calls SET status = 'connected', updated_at = NOW() WHERE id = ${state.callId}`.catch(() => {});
    sql`INSERT INTO call_events (call_id, event_type, details) VALUES (${state.callId}, 'auto_connect_initiated', ${JSON.stringify({ transferNumber })})`.catch(() => {});

    // Agent leg: hear the hold message, then wait in the conference (with hold music).
    const agentLeg = twilioClient.calls(state.callSid!).update({
      twiml: `<Response><Say voice="Polly.Joanna">${escapedMsg}</Say>${conf()}</Response>`,
    });
    // Customer leg: dialed in parallel so the phone starts ringing instantly.
    const customerLeg = twilioClient.calls.create({
      to: transferNumber,
      from: twilioPhone,
      twiml: `<Response><Say voice="alice">Please hold, connecting you to a live cruise line agent now.</Say>${conf()}</Response>`,
    });

    Promise.all([agentLeg, customerLeg]).catch(async (err) => {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[AI] Auto-connect error callId=${state.callId}:`, m);
      // Persist the failure so it's diagnosable instead of vanishing into the server log.
      await sql`UPDATE calls SET error_message = ${`Auto-connect failed: ${m}`}, updated_at = NOW() WHERE id = ${state.callId}`.catch(() => {});
      await sql`INSERT INTO call_events (call_id, event_type, details) VALUES (${state.callId}, 'auto_connect_failed', ${JSON.stringify({ error: m })})`.catch(() => {});
    });
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
  // cleanup() closes sockets/timers and, on AI calls, writes the fallback summary.
  cleanup(state);

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

// ─── Claude voice engine ─────────────────────────────────────────────────────

/** Wire the Claude pipeline (server/claude-voice.ts) into this call. */
function startClaudeVoice(state: SessionState): void {
  const task = state.aiTaskDetails;
  if (!task || state.claude) return;

  // What the rep said over the last ~15s (their name / "who am I speaking with?").
  const since = Date.now() - 15_000;
  const repGreeting = state.recentHeard.filter((h) => h.at >= since).map((h) => h.text).join(' ');

  state.claude = new ClaudeVoiceSession({
    callId: state.callId,
    task,
    repGreeting,
    isDone: () => state.isTerminated || state.aiFinishing,
    sendAudio: (mulaw) => sendToTwilio(state, { event: 'media', media: { payload: mulaw.toString('base64') } }),
    clearAudio: () => {
      sendToTwilio(state, { event: 'clear' });
      state.aiPlaybackMark = null;
    },
    recordAiSay: (text) => {
      state.aiConversationHistory.push({ speaker: 'us', text, timestamp: Date.now() });
      sql`
        INSERT INTO call_events (call_id, event_type, details)
        VALUES (${state.callId}, 'conversation_ai_say', ${JSON.stringify({ text, timestamp: Date.now() })})
      `.catch(() => {});
    },
    recordRepSay: (text) => {
      state.aiConversationHistory.push({ speaker: 'agent', text, timestamp: Date.now() });
      sql`
        INSERT INTO call_events (call_id, event_type, details)
        VALUES (${state.callId}, 'conversation_transcript', ${JSON.stringify({ text, speaker: 'agent', timestamp: Date.now() })})
      `.catch(() => {});
    },
    endCall: (outcome, summary) =>
      scheduleFinish(state, async () => {
        await saveAiOutcome(state, outcome, summary);
        await hangUp(state);
      }),
    transfer: (reason, summary) =>
      scheduleFinish(state, async () => {
        await handOffToTeam(state, reason, summary);
      }),
    surveyHeard: () => finishWithFallbackSummary(state),
    fail: (reason) => {
      if (state.isTerminated || state.aiFinishing) return;
      console.error(`[AI] Claude engine failed (${reason}) callId=${state.callId}`);

      // Claude failed before saying anything (bad key, outage): switch this call to OpenAI Realtime
      // instead of dropping the rep. Once Claude has spoken, a mid-call failure goes to the team.
      const hasSpoken = state.aiConversationHistory.some((t) => t.speaker === 'us');
      if (!hasSpoken && process.env.OPENAI_API_KEY) {
        console.warn(`[AI] Falling back to OpenAI Realtime callId=${state.callId}`);
        state.claude?.stop();
        state.claude = null;
        state.aiEngine = 'openai';
        state.aiConversationHistory = []; // so OpenAI plays its opening line instead of replaying
        sql`
          INSERT INTO call_events (call_id, event_type, details)
          VALUES (${state.callId}, 'ai_engine_fallback', ${JSON.stringify({ from: 'claude', to: 'openai', reason })})
        `.catch(() => {});
        connectOpenAIRealtime(state).catch((err) => {
          console.error(`[OpenAI RT] Fallback connect error callId=${state.callId}:`, err);
          handOffToTeam(state, 'AI voice could not start', 'The AI could not start, so the call was passed straight to the team.').catch(() => {});
        });
        return;
      }

      handOffToTeam(state, reason, 'The AI failed during the call, so it was passed to the team.').catch(() => {});
    },
  });
  state.claude.start();
}

// ─── OpenAI Realtime API ─────────────────────────────────────────────────────

const RT_MODEL = process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime';
/** If the goodbye/handoff audio never reports finished, act anyway after this long. */
const FINISH_FALLBACK_MS = 8_000;

function sendToTwilio(state: SessionState, payload: Record<string, unknown>): void {
  if (state.twilioWs?.readyState === WebSocket.OPEN) {
    state.twilioWs.send(JSON.stringify({ streamSid: state.streamSid, ...payload }));
  }
}

/**
 * Connect to the OpenAI Realtime API and relay audio between Twilio and OpenAI.
 * The agent speaks for the agency, discloses it is an AI, and can end the call or
 * hand it to the team through function calls.
 */
async function connectOpenAIRealtime(state: SessionState): Promise<void> {
  if (state.openaiRtWs) return; // already connected
  const task = state.aiTaskDetails;
  if (!task) throw new Error('No AI task for this call');

  console.log(`[OpenAI RT] Connecting callId=${state.callId}`);

  const rtWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${RT_MODEL}`, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, // GA API: no beta header
    handshakeTimeout: 10_000,
  });
  state.openaiRtWs = rtWs;
  let opened = false;

  rtWs.on('open', () => {
    opened = true;
    console.log(`[OpenAI RT] Connected callId=${state.callId}`);

    rtWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: buildAgentInstructions(task),
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcmu' }, // g711 µ-law passthrough from Twilio
            transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.65,
              prefix_padding_ms: 300,
              silence_duration_ms: 900,
            },
          },
          output: { format: { type: 'audio/pcmu' }, voice: 'coral' },
        },
        tools: AGENT_TOOLS,
        tool_choice: 'auto',
      },
    }));

    if (state.aiConversationHistory.length === 0) {
      // Opening line. The Twilio stream is already open and bidirectional.
      rtWs.send(JSON.stringify({
        type: 'response.create',
        // response.instructions REPLACES the session prompt for this reply, so include the full
        // prompt (facts + request) or the AI invents a booking number and request.
        response: { instructions: `${buildAgentInstructions(task)}\n\n${buildOpeningInstruction(task)}` },
      }));
    } else {
      // Reconnected mid-conversation — replay history so OpenAI has context.
      for (const turn of state.aiConversationHistory) {
        rtWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: turn.speaker === 'us' ? 'assistant' : 'user',
            content: [{ type: turn.speaker === 'us' ? 'output_text' : 'input_text', text: turn.text }],
          },
        }));
      }
    }
  });

  rtWs.on('message', async (raw: WebSocket.RawData) => {
    try {
      const event = JSON.parse(raw.toString());

      switch (event.type) {
        case 'response.created':
          state.rtResponseActive = true;
          state.aiResponseBuffer = '';
          break;

        case 'response.done': {
          state.rtResponseActive = false;
          // Audio arrives faster than real time; Twilio echoes this mark once it has
          // actually finished playing, which is when the AI is really done talking.
          const mark = `ai-playback-${Date.now()}`;
          state.aiPlaybackMark = mark;
          sendToTwilio(state, { event: 'mark', mark: { name: mark } });
          break;
        }

        case 'input_audio_buffer.speech_started':
          // Barge-in: the rep started talking — stop our audio so we don't talk over them.
          if (!state.aiFinishing && (state.rtResponseActive || state.aiPlaybackMark)) {
            sendToTwilio(state, { event: 'clear' });
            state.aiPlaybackMark = null;
            if (state.rtResponseActive) rtWs.send(JSON.stringify({ type: 'response.cancel' }));
          }
          break;

        case 'response.output_audio.delta':
        case 'response.audio.delta':
          sendToTwilio(state, { event: 'media', media: { payload: event.delta } }); // base64 g711_ulaw
          break;

        case 'response.output_audio_transcript.delta':
        case 'response.audio_transcript.delta':
          state.aiResponseBuffer += event.delta ?? '';
          break;

        case 'response.output_audio_transcript.done':
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

            // Rep has gone and a survey / menu is playing — hang up now.
            if (!state.aiFinishing && looksLikeSurveyOrIvr(agentText)) {
              console.log(`[AI] Survey/IVR detected after rep — hanging up callId=${state.callId}`);
              await finishWithFallbackSummary(state);
            }
          }
          break;
        }

        case 'response.output_item.done': {
          // Realtime: the tool name is only on the finished output item.
          const item = event.item;
          if (item?.type !== 'function_call') break;
          let args: Record<string, string> = {};
          try { args = JSON.parse(item.arguments ?? '{}'); } catch {}
          // Acknowledge so the conversation state stays valid.
          rtWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: item.call_id, output: '{"ok":true}' },
          }));
          if (item.name === 'end_call') {
            const outcome = (['resolved', 'partial', 'not_resolved', 'rep_refused_ai'].includes(args.outcome)
              ? args.outcome : 'partial') as AiOutcome;
            await scheduleFinish(state, async () => {
              await saveAiOutcome(state, outcome, args.summary || 'No summary given.');
              await hangUp(state);
            });
          } else if (item.name === 'transfer_to_team') {
            await scheduleFinish(state, async () => {
              await handOffToTeam(state, args.reason || 'AI asked for help', args.summary || '');
            });
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
    // Lost the AI mid-call with the rep still on the line → get a person on.
    if (!state.isTerminated && !state.aiFinishing) {
      const reason = opened ? 'AI voice connection dropped' : 'AI voice could not start';
      handOffToTeam(state, reason, 'The AI connection failed during the call.').catch(() => {});
    }
  });

  rtWs.on('error', (err) => {
    console.error(`[OpenAI RT] WS error callId=${state.callId}:`, err.message);
  });
}

/**
 * Stop the AI from saying anything new, let its last sentence finish playing,
 * then run the finish action (hang up or hand off). Twilio echoes a mark once
 * all audio queued before it has played; a timer covers a lost mark.
 */
async function scheduleFinish(state: SessionState, action: () => Promise<void>): Promise<void> {
  if (state.aiFinishing) return;
  state.aiFinishing = true;
  // Stop the AI from auto-replying if the rep talks during the goodbye.
  try {
    state.openaiRtWs?.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', audio: { input: { turn_detection: null } } } }));
  } catch {}
  state.pendingFinishAction = action;
  const mark = `ai-finish-${Date.now()}`;
  state.pendingFinishMark = mark;
  sendToTwilio(state, { event: 'mark', mark: { name: mark } });
  state.finishFallbackTimer = setTimeout(() => runPendingFinish(state), FINISH_FALLBACK_MS);
}

function runPendingFinish(state: SessionState): void {
  const action = state.pendingFinishAction;
  state.pendingFinishAction = null;
  state.pendingFinishMark = null;
  if (state.finishFallbackTimer) {
    clearTimeout(state.finishFallbackTimer);
    state.finishFallbackTimer = null;
  }
  if (action) action().catch((err) => console.error(`[AI] Finish action error callId=${state.callId}:`, err));
}

/** End right away (survey heard, etc.) and summarize from the transcript. */
async function finishWithFallbackSummary(state: SessionState): Promise<void> {
  if (state.aiFinishing) return;
  state.aiFinishing = true;
  try { state.openaiRtWs?.send(JSON.stringify({ type: 'response.cancel' })); } catch {}
  state.claude?.stop();
  sendToTwilio(state, { event: 'clear' });
  await hangUp(state);
  if (state.aiTaskDetails) {
    const { outcome, summary } = await summarizeTranscript(state.aiTaskDetails, state.aiConversationHistory);
    await saveAiOutcome(state, outcome, summary);
  }
}

async function hangUp(state: SessionState): Promise<void> {
  console.log(`[AI] Hanging up callId=${state.callId}`);
  try { state.openaiRtWs?.close(); } catch {}
  state.claude?.stop();
  if (state.callSid) {
    await twilioClient.calls(state.callSid).update({ status: 'completed' }).catch((err) =>
      console.error(`[AI] Hang-up error callId=${state.callId}:`, err?.message ?? err)
    );
  }
}

/** Save the outcome + summary on the call, log it, and text the team member. */
async function saveAiOutcome(state: SessionState, outcome: AiOutcome, summary: string): Promise<void> {
  if (state.aiOutcomeSaved) return;
  state.aiOutcomeSaved = true;
  console.log(`[AI] Outcome ${outcome} callId=${state.callId}: ${summary.substring(0, 100)}`);
  await sql`
    UPDATE calls SET ai_outcome = ${outcome}, ai_summary = ${summary}, updated_at = NOW()
    WHERE id = ${state.callId}
  `.catch((err) => console.error(`[AI] Save outcome error:`, err));
  await sql`
    INSERT INTO call_events (call_id, event_type, details)
    VALUES (${state.callId}, 'ai_outcome', ${JSON.stringify({ outcome, summary })})
  `.catch(() => {});

  const phone = state.callConfig?.notification_phone as string | undefined;
  if (phone && process.env.NOTIFICATION_SMS_ENABLED === 'true') {
    const t = state.aiTaskDetails;
    const ref = t?.bookingNumber ? ` ${t.bookingNumber}` : '';
    const body = `CruisePro AI call${ref}: ${outcomeLabel(outcome)}. ${summary}`.slice(0, 1200);
    await sendSMS(phone, body).catch((err) => console.error(`[AI] Summary SMS error:`, err?.message ?? err));
  }
}

/**
 * Hand the rep to a person: the rep hears a short hold line, the team member's
 * phone rings in parallel with a whisper of why, and both join one conference.
 */
async function handOffToTeam(state: SessionState, reason: string, summary: string): Promise<void> {
  state.aiFinishing = true;
  try { state.openaiRtWs?.close(); } catch {}
  state.claude?.stop();
  if (state.isTerminated) {
    // The rep already hung up — nobody to connect. Just record what happened.
    await saveAiOutcome(state, 'handed_off', `${reason} (rep hung up before the handoff). ${summary}`.trim());
    return;
  }

  const call = state.callConfig ?? {};
  const transferNums = (call.transfer_numbers ?? []) as Array<{ phone: string; isDefault: boolean }>;
  const transferNumber = (call.transfer_number as string | null) ??
    transferNums.find((n) => n.isDefault)?.phone ??
    transferNums[0]?.phone ??
    process.env.DEFAULT_TRANSFER_NUMBER ??
    null;

  if (!transferNumber || !state.callSid) {
    console.error(`[AI] Handoff impossible (no transfer number) callId=${state.callId} — hanging up`);
    await hangUp(state);
    await saveAiOutcome(state, 'not_resolved', `Needed a person (${reason}) but no transfer number is set, so the call was ended. ${summary}`.trim());
    return;
  }

  console.log(`[AI] Handing off to ${transferNumber} callId=${state.callId} reason="${reason}"`);
  const room = `CruisePro-${state.callId}`;
  const conf = `<Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false">${room}</Conference></Dial>`;
  const whisper = escapeXml(`Cruise line rep on the line from the AI. ${reason}. ${summary}`.slice(0, 400));

  // No pendingRedirects++ here: the new TwiML has no <Stream>, so no new WS will
  // arrive and the 'stop' that follows should run cleanup normally.
  // Twilio legs go first so the rep isn't left in silence while we write to the DB.
  const ok = await Promise.all([
    twilioClient.calls(state.callSid).update({
      twiml: `<Response><Say voice="Polly.Joanna">Thank you. Please hold one moment while I connect my colleague.</Say>${conf}</Response>`,
    }),
    twilioClient.calls.create({
      to: transferNumber,
      from: twilioPhone,
      twiml: `<Response><Say voice="Polly.Joanna">${whisper}</Say>${conf}</Response>`,
    }),
  ]).then(() => true).catch(async (err) => {
    const m = err instanceof Error ? err.message : String(err);
    console.error(`[AI] Handoff error callId=${state.callId}:`, m);
    await sql`UPDATE calls SET error_message = ${`AI handoff failed: ${m}`}, updated_at = NOW() WHERE id = ${state.callId}`.catch(() => {});
    return false;
  });

  if (ok) {
    sql`UPDATE calls SET status = 'connected', updated_at = NOW() WHERE id = ${state.callId}`.catch(() => {});
    sql`INSERT INTO call_events (call_id, event_type, details) VALUES (${state.callId}, 'ai_handoff', ${JSON.stringify({ transferNumber, reason })})`.catch(() => {});
    await saveAiOutcome(state, 'handed_off', `${reason}. ${summary}`.trim());
  } else {
    await hangUp(state);
    await saveAiOutcome(state, 'not_resolved', `Tried to hand the rep to the team (${reason}) but the transfer failed, so the call was ended. ${summary}`.trim());
  }
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
  state.claude?.stop();

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

  // AI call ended without end_call / handoff (rep hung up, line dropped):
  // still write an outcome + summary and text it, from the transcript.
  // (Finish paths already in progress save their own outcome; a pending
  // finish timer is left running on purpose so that action still completes.)
  if (state.aiConversationMode && !state.aiFinishing && state.aiTaskDetails) {
    state.aiFinishing = true;
    summarizeTranscript(state.aiTaskDetails, state.aiConversationHistory)
      .then(({ outcome, summary }) => saveAiOutcome(state, outcome, summary))
      .catch((err) => console.error(`[AI] Fallback summary error:`, err));
  }
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
