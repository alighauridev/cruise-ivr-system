/**
 * Claude voice engine — runs an AI call as a pipeline instead of OpenAI Realtime:
 *
 *   Twilio audio → Deepgram (speech-to-text) → Claude (reply + tools)
 *                → sentence chunker → TTS → Twilio audio
 *
 * Claude has no speech-to-speech API, so latency is kept down by streaming: each
 * sentence goes to TTS the moment Claude finishes it, not after the whole reply.
 * The tools, prompt and call-ending behavior are the same as the Realtime engine
 * (see ai-call-agent.ts); media-ws.ts supplies the call-side actions via ClaudeVoiceHost.
 */
import Anthropic from '@anthropic-ai/sdk';
import WebSocket from 'ws';
import { streamTTSMulaw } from '@/lib/openai-tts';
import {
  AiOutcome,
  AiTaskDetails,
  CLAUDE_TOOLS,
  buildAgentInstructions,
  buildOpeningInstruction,
  looksLikeSurveyOrIvr,
} from './ai-call-agent';

export type AiEngine = 'claude' | 'openai';

/** Sonnet 5.5 for quality on live calls; set CLAUDE_VOICE_MODEL=claude-haiku-5-5 for faster, cheaper replies. */
const MODEL = process.env.CLAUDE_VOICE_MODEL ?? 'claude-sonnet-5-5';
/** How long Deepgram waits after the rep stops talking before calling the turn finished. */
const ENDPOINTING_MS = Number(process.env.CLAUDE_ENDPOINTING_MS ?? 700);
const DG_MAX_RETRIES = 5;
const BACKLOG_FRAMES = 400; // ~8s of 20ms frames kept while Deepgram connects

const OUTCOMES: AiOutcome[] = ['resolved', 'partial', 'not_resolved', 'rep_refused_ai'];

const PHONE_STYLE = `

PHONE STYLE:
- Your words are spoken aloud by a text-to-speech voice over a phone line. Plain spoken English only: no markdown, lists, emojis, stage directions or XML/tags.
- Keep every reply to 1-2 short sentences unless the rep asks for more.
- When you use a tool, you may say a brief sentence first. Do not include internal or system tags in your response.`;

let anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  // Fail fast on a phone call rather than retrying for minutes.
  return (anthropic ??= new Anthropic({ maxRetries: 1, timeout: 20_000 }));
}

/** Per-user setting wins, then AI_ENGINE, then Claude if a key is present. */
export function resolveAiEngine(userSetting?: unknown): AiEngine {
  const pick = (v: unknown): AiEngine | null => (v === 'claude' || v === 'openai' ? v : null);
  const want = pick(userSetting) ?? pick(process.env.AI_ENGINE) ?? (process.env.ANTHROPIC_API_KEY ? 'claude' : 'openai');
  if (want === 'claude' && !process.env.ANTHROPIC_API_KEY) {
    console.warn('[ClaudeVoice] Claude engine selected but ANTHROPIC_API_KEY is not set — using OpenAI Realtime');
    return 'openai';
  }
  return want;
}

/** Thinking is off: every reasoning token is dead air on a phone line. */
function latencyParams(model: string) {
  if (model.startsWith('claude-haiku-5-5')) {
    return { thinking: { type: 'disabled' as const }, output_config: { effort: 'low' as const } };
  }
  if (model.startsWith('claude-sonnet-5-5')) {
    // Sonnet 5.5 rejects thinking:{type:'disabled'}; between_tools is its "off" switch.
    return { thinking: { type: 'between_tools' as const }, output_config: { effort: 'low' as const } };
  }
  return { output_config: { effort: 'low' as const } };
}

/** What the engine needs from the call. Implemented in media-ws.ts. */
export interface ClaudeVoiceHost {
  readonly callId: string;
  readonly task: AiTaskDetails;
  /** Call is over, or end_call / handoff already started — say and do nothing more. */
  isDone(): boolean;
  sendAudio(mulaw: Buffer): void;
  /** Drop audio Twilio has queued (barge-in). */
  clearAudio(): void;
  recordAiSay(text: string): void;
  recordRepSay(text: string): void;
  endCall(outcome: AiOutcome, summary: string): Promise<void>;
  transfer(reason: string, summary: string): Promise<void>;
  /** A recorded survey / menu started after the rep left. */
  surveyHeard(): Promise<void>;
  /** The AI can't continue (STT/LLM/TTS down) — get a person on the line. */
  fail(reason: string): void;
}

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'no', 'vs', 'jr', 'sr', 'inc', 'co', 'etc']);

/** Index just past the first complete sentence in buf (including trailing space), or -1. */
function findSentenceEnd(buf: string): number {
  const re = /([.!?])(["')\]]*)(\s+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf))) {
    const end = m.index + m[0].length;
    const before = buf.slice(0, m.index);
    if (before.trim().length < 8) continue;
    if (m[1] === '.') {
      const word = /([A-Za-z]+)$/.exec(before)?.[1]?.toLowerCase();
      // "Mr. Smith", and single letters when spelling out a booking number: "C. C. L."
      if (word && (word.length === 1 || ABBREVIATIONS.has(word))) continue;
    }
    return end;
  }
  // Very long run with no sentence end: cut at a comma/space so speech can start.
  if (buf.length > 220) {
    const comma = buf.lastIndexOf(', ', 220);
    if (comma > 60) return comma + 2;
    const space = buf.lastIndexOf(' ', 220);
    if (space > 60) return space + 1;
  }
  return -1;
}

/** Strip anything that should never be read aloud. Empty string = skip. */
function cleanForSpeech(raw: string): string {
  const s = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*_#`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[A-Za-z0-9]/.test(s)) return '';
  if (/\b(end_call|transfer_to_team)\b/i.test(s)) return '';
  return s;
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export class ClaudeVoiceSession {
  private readonly system: string;
  private messages: Anthropic.MessageParam[] = [];

  private dg: WebSocket | null = null;
  private dgAttempts = 0;
  private dgTimer: ReturnType<typeof setTimeout> | null = null;
  private backlog: Buffer[] = [];
  private pending = ''; // final transcript segments of the rep's current turn

  private started = false;
  private stopped = false;
  private turnToken = 0; // bumped on every new turn / barge-in so stale work stops itself
  private active = false; // a Claude turn is generating or its speech is still being sent
  private stream: { abort(): void } | null = null;
  private sentenceBuf = '';
  private spoken: string[] = []; // sentences whose audio was actually started this turn
  private ttsChain: Promise<void> = Promise.resolve();
  private ttsFailures = 0;
  private playEndsAt = 0; // when audio already sent to Twilio finishes playing (8000 mulaw bytes = 1s)

  constructor(private readonly host: ClaudeVoiceHost) {
    this.system = buildAgentInstructions(host.task) + PHONE_STYLE;
  }

  /** Open the speech-to-text link and speak the opening line. */
  start(): void {
    if (this.started) return;
    this.started = true;
    console.log(`[ClaudeVoice] Start callId=${this.host.callId} model=${MODEL}`);
    this.connectDeepgram();
    this.messages.push({
      role: 'user',
      content: `[The rep just answered the call.] ${buildOpeningInstruction(this.host.task)}`,
    });
    void this.runTurn();
  }

  /** Twilio audio (base64 mulaw) from the rep. */
  pushAudio(base64: string): void {
    if (this.stopped) return;
    const frame = Buffer.from(base64, 'base64');
    if (this.dg?.readyState === WebSocket.OPEN) {
      this.dg.send(frame);
    } else {
      this.backlog.push(frame);
      if (this.backlog.length > BACKLOG_FRAMES) this.backlog.shift();
    }
  }

  /** Advisor typed a mid-call instruction (dashboard "speak" box). */
  injectInstruction(text: string): boolean {
    if (this.stopped || this.host.isDone()) return false;
    this.bargeIn();
    this.appendUser(`[Instruction from the advisor listening in — follow it now] ${text}`);
    void this.runTurn();
    return true;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.turnToken++;
    this.active = false;
    try { this.stream?.abort(); } catch {}
    this.stream = null;
    if (this.dgTimer) clearTimeout(this.dgTimer);
    try { this.dg?.close(); } catch {}
    this.dg = null;
    this.backlog = [];
  }

  // ── Speech-to-text ─────────────────────────────────────────────────────────

  private connectDeepgram(): void {
    if (this.stopped) return;
    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) {
      console.error('[ClaudeVoice] DEEPGRAM_API_KEY not set');
      this.host.fail('Speech recognition is not configured');
      return;
    }
    const params = new URLSearchParams({
      model: 'nova-2-phonecall',
      language: 'en-US',
      encoding: 'mulaw',
      sample_rate: '8000',
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      endpointing: String(ENDPOINTING_MS),
      utterance_end_ms: '1500',
    });
    const dg = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${key}` },
      handshakeTimeout: 10_000,
    });
    this.dg = dg;

    dg.on('open', () => {
      this.dgAttempts = 0;
      console.log(`[ClaudeVoice] Deepgram connected callId=${this.host.callId}`);
      for (const frame of this.backlog) dg.send(frame);
      this.backlog = [];
    });
    dg.on('message', (raw: WebSocket.RawData) => this.onDeepgram(raw));
    dg.on('error', (err: Error) => console.error(`[ClaudeVoice] Deepgram error callId=${this.host.callId}:`, err.message));
    dg.on('close', () => {
      if (this.dg === dg) this.dg = null;
      if (this.stopped || this.host.isDone()) return;
      if (this.dgAttempts >= DG_MAX_RETRIES) {
        this.host.fail('Speech recognition dropped');
        return;
      }
      const delay = 400 * 2 ** this.dgAttempts++;
      console.log(`[ClaudeVoice] Deepgram closed — retry in ${delay}ms callId=${this.host.callId}`);
      this.dgTimer = setTimeout(() => this.connectDeepgram(), delay);
    });
  }

  private onDeepgram(raw: WebSocket.RawData): void {
    if (this.stopped || this.host.isDone()) return;
    let data: any;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    if (data.type === 'UtteranceEnd') { this.flushTurn(); return; }

    const text: string = (data.channel?.alternatives?.[0]?.transcript ?? '').trim();
    if (!text) return;

    // The rep is talking over us: stop immediately, before their sentence even ends.
    if (this.isSpeaking() && wordCount(`${this.pending} ${text}`) >= 2) this.bargeIn();

    if (data.is_final) this.pending = this.pending ? `${this.pending} ${text}` : text;
    if (data.speech_final) this.flushTurn();
  }

  /** The rep finished a turn — hand it to Claude. */
  private flushTurn(): void {
    const text = this.pending.trim();
    this.pending = '';
    if (!text || this.stopped || this.host.isDone()) return;

    if (looksLikeSurveyOrIvr(text)) {
      console.log(`[ClaudeVoice] Survey/IVR heard callId=${this.host.callId}`);
      this.host.recordRepSay(text);
      this.stop();
      void this.host.surveyHeard();
      return;
    }
    if (this.isSpeaking()) {
      if (wordCount(text) < 2) return; // "okay" / "mm-hmm" while we talk — keep talking
      this.bargeIn();
    }
    console.log(`[ClaudeVoice] Rep: "${text.substring(0, 80)}" callId=${this.host.callId}`);
    this.host.recordRepSay(text);
    this.appendUser(text);
    void this.runTurn();
  }

  private isSpeaking(): boolean {
    return this.active || Date.now() < this.playEndsAt;
  }

  private appendUser(text: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === 'user' && typeof last.content === 'string') {
      last.content = `${last.content} ${text}`;
    } else {
      this.messages.push({ role: 'user', content: text });
    }
  }

  // ── Claude turn ────────────────────────────────────────────────────────────

  /** Rep interrupted: cancel Claude and the voice, keep only what was actually said. */
  private bargeIn(): void {
    const wasActive = this.active;
    this.turnToken++; // orphan the in-flight stream and queued speech
    try { this.stream?.abort(); } catch {}
    this.stream = null;
    this.active = false;
    this.sentenceBuf = '';
    if (wasActive || Date.now() < this.playEndsAt) this.host.clearAudio();
    this.playEndsAt = 0;
    if (wasActive) this.commitSpoken(true);
    console.log(`[ClaudeVoice] Barge-in callId=${this.host.callId}`);
  }

  /** Record what was voiced this turn; optionally add it to Claude's history. */
  private commitSpoken(addToHistory: boolean): boolean {
    const text = this.spoken.join(' ').trim();
    this.spoken = [];
    if (!text) return false;
    if (addToHistory) this.messages.push({ role: 'assistant', content: text });
    this.host.recordAiSay(text);
    return true;
  }

  private async runTurn(): Promise<void> {
    if (this.stopped || this.host.isDone()) return;
    const token = ++this.turnToken;
    this.active = true;
    this.spoken = [];
    this.sentenceBuf = '';
    this.ttsChain = Promise.resolve(); // a fresh chain, so an interrupted turn can't delay this one
    const t0 = Date.now();

    let final: Anthropic.Message;
    try {
      const stream = getClient().messages.stream({
        model: MODEL,
        max_tokens: 600,
        system: [{ type: 'text', text: this.system, cache_control: { type: 'ephemeral' } }],
        tools: CLAUDE_TOOLS as unknown as Anthropic.Tool[],
        messages: this.messages.map((m) => ({ ...m })),
        ...latencyParams(MODEL),
      });
      this.stream = stream;
      stream.on('error', () => {}); // surfaced through finalMessage() below
      stream.on('text', (delta) => this.onDelta(token, delta, t0));
      final = await stream.finalMessage();
    } catch (err) {
      if (token !== this.turnToken) return; // aborted by barge-in / stop
      this.active = false;
      console.error(`[ClaudeVoice] Claude error callId=${this.host.callId}:`, err instanceof Error ? err.message : err);
      this.host.fail('Claude could not respond');
      return;
    }
    if (token !== this.turnToken) return;

    if (final.stop_reason === 'refusal') {
      this.active = false;
      console.error(`[ClaudeVoice] Claude declined to respond callId=${this.host.callId}`);
      this.host.fail('Claude declined to respond');
      return;
    }

    this.flushSentences(token, true);
    await this.ttsChain; // all speech for this turn has been sent to Twilio
    if (token !== this.turnToken) return;
    this.active = false;
    this.stream = null;
    console.log(`[ClaudeVoice] Turn done in ${Date.now() - t0}ms stop=${final.stop_reason} callId=${this.host.callId}`);

    const tool = final.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (tool && (tool.name === 'end_call' || tool.name === 'transfer_to_team')) {
      this.commitSpoken(false);
      await this.runTool(tool);
      return;
    }
    if (tool) console.warn(`[ClaudeVoice] Ignoring unknown tool "${tool.name}" callId=${this.host.callId}`);

    this.commitSpoken(true);
  }

  private async runTool(tool: Anthropic.ToolUseBlock): Promise<void> {
    const input = (tool.input && typeof tool.input === 'object' ? tool.input : {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const summary = str(input.summary);
    console.log(`[ClaudeVoice] Tool ${tool.name} callId=${this.host.callId}`);
    this.stopListening(); // goodbye / handoff: nothing the rep says matters now

    if (tool.name === 'end_call') {
      const outcome = OUTCOMES.includes(input.outcome as AiOutcome) ? (input.outcome as AiOutcome) : 'partial';
      await this.host.endCall(outcome, summary || 'No summary given.');
    } else {
      await this.host.transfer(str(input.reason) || 'AI asked for help', summary);
    }
  }

  private stopListening(): void {
    if (this.dgTimer) clearTimeout(this.dgTimer);
    try { this.dg?.close(); } catch {}
    this.dg = null;
    this.stopped = true; // also stops audio intake and Deepgram retries
  }

  // ── Claude text → speech ───────────────────────────────────────────────────

  private onDelta(token: number, delta: string, t0: number): void {
    if (token !== this.turnToken) return;
    if (!this.sentenceBuf && this.spoken.length === 0) {
      console.log(`[ClaudeVoice] First token after ${Date.now() - t0}ms callId=${this.host.callId}`);
    }
    this.sentenceBuf += delta;
    this.flushSentences(token, false);
  }

  private flushSentences(token: number, final: boolean): void {
    for (;;) {
      const end = findSentenceEnd(this.sentenceBuf);
      if (end < 0) break;
      const sentence = this.sentenceBuf.slice(0, end);
      this.sentenceBuf = this.sentenceBuf.slice(end);
      this.enqueueSpeech(token, sentence);
    }
    if (final) {
      const rest = this.sentenceBuf;
      this.sentenceBuf = '';
      this.enqueueSpeech(token, rest);
    }
  }

  private enqueueSpeech(token: number, raw: string): void {
    const sentence = cleanForSpeech(raw);
    if (!sentence) return;
    this.ttsChain = this.ttsChain.then(async () => {
      if (token !== this.turnToken || this.host.isDone()) return;
      this.spoken.push(sentence);
      try {
        await streamTTSMulaw(sentence, (chunk) => {
          if (token !== this.turnToken || this.host.isDone()) return;
          this.playEndsAt = Math.max(this.playEndsAt, Date.now()) + chunk.length / 8;
          this.host.sendAudio(chunk);
        });
        this.ttsFailures = 0;
      } catch (err) {
        console.error(`[ClaudeVoice] TTS error callId=${this.host.callId}:`, err instanceof Error ? err.message : err);
        if (++this.ttsFailures >= 2) this.host.fail('Text-to-speech failed');
      }
    });
  }
}
