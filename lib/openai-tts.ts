import OpenAI from 'openai';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * gpt-4o-mini-tts sounds like a person on the phone; tts-1 sounds like a reader.
 * TTS_MODEL=tts-1 / TTS_VOICE=nova restores the old voice.
 */
const TTS_MODEL = process.env.TTS_MODEL ?? 'gpt-4o-mini-tts';
const TTS_VOICE = process.env.TTS_VOICE ?? 'coral';
const TTS_INSTRUCTIONS =
  process.env.TTS_INSTRUCTIONS ??
  'Friendly, relaxed travel-agency assistant on a phone call with a colleague at a cruise line. ' +
  'Natural conversational pace and warm tone, like a real person, not a narrator or announcer. ' +
  'Read letters and numbers in booking codes clearly and a little slower.';
const ttsParams = () =>
  TTS_MODEL.startsWith('tts-1')
    ? { model: TTS_MODEL, voice: TTS_VOICE }
    : { model: TTS_MODEL, voice: TTS_VOICE, instructions: TTS_INSTRUCTIONS };
/** Cache key covers the voice, so changing it doesn't replay old audio. */
const cacheKey = (text: string) =>
  crypto.createHash('sha256').update(`${TTS_MODEL}|${TTS_VOICE}|${TTS_INSTRUCTIONS}|${text}`).digest('hex');

/** 24kHz → 8kHz: average each group of 3 samples (a simple low-pass) instead of dropping 2 of 3, which aliases into a harsh, tinny voice. */
function down3(samples: Int16Array, i: number): number {
  return Math.round((samples[i * 3] + samples[i * 3 + 1] + samples[i * 3 + 2]) / 3);
}

const CACHE_DIR = path.join(process.cwd(), 'public', 'tts', 'cache');
const MULAW_CACHE_DIR = path.join(process.cwd(), 'public', 'tts', 'mulaw-cache');

/** Generate MP3 TTS audio (cached). */
export async function generateTTS(text: string): Promise<Buffer> {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  const hash = cacheKey(text);
  const cachePath = path.join(CACHE_DIR, `${hash}.mp3`);

  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath);
  }

  const response = await openai.audio.speech.create({
    ...ttsParams(),
    input: text,
    response_format: 'mp3',
  });
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  fs.writeFileSync(cachePath, buffer);
  return buffer;
}

/**
 * Deepgram Aura is the phone voice: it returns 8kHz mulaw directly and starts in ~0.4s.
 * OpenAI TTS is the fallback — it sometimes took 70s+ to send the first byte, which left
 * reps in a minute of silence. TTS_PROVIDER=openai makes OpenAI the main voice again.
 */
const AURA_VOICE = process.env.TTS_AURA_VOICE ?? 'aura-2-thalia-en';
const PRIMARY: 'aura' | 'openai' =
  process.env.TTS_PROVIDER === 'openai' || !process.env.DEEPGRAM_API_KEY ? 'openai' : 'aura';
/** No audio within this long = that provider is stalled; try the other one. */
const FIRST_AUDIO_MS = { aura: 3000, openai: 6000 };
const TOTAL_MS = 30_000;

const mulawCacheKey = (text: string, provider: 'aura' | 'openai') =>
  provider === 'aura'
    ? crypto.createHash('sha256').update(`aura|${AURA_VOICE}|${text}`).digest('hex')
    : cacheKey(text);

/** POST and stream the body, aborting if no audio arrives in firstMs. */
async function streamBody(
  url: string,
  init: RequestInit,
  firstMs: number,
  onBytes: (bytes: Buffer) => void
): Promise<void> {
  const ctrl = new AbortController();
  const firstTimer = setTimeout(() => ctrl.abort(new Error(`no audio after ${firstMs}ms`)), firstMs);
  const totalTimer = setTimeout(() => ctrl.abort(new Error(`not finished after ${TOTAL_MS}ms`)), TOTAL_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(firstTimer);
      onBytes(Buffer.from(value));
    }
  } finally {
    clearTimeout(firstTimer);
    clearTimeout(totalTimer);
  }
}

function streamAura(text: string, onMulaw: (mulaw: Buffer) => void): Promise<void> {
  const params = new URLSearchParams({ model: AURA_VOICE, encoding: 'mulaw', sample_rate: '8000', container: 'none' });
  return streamBody(
    `https://api.deepgram.com/v1/speak?${params}`,
    {
      method: 'POST',
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    },
    FIRST_AUDIO_MS.aura,
    onMulaw
  );
}

/** OpenAI streams PCM 24kHz 16-bit; downsample to 8kHz and convert to mulaw as it arrives. */
function streamOpenAI(text: string, onMulaw: (mulaw: Buffer) => void): Promise<void> {
  let remainder = Buffer.alloc(0); // bytes that don't yet form a full group of 3 samples
  return streamBody(
    'https://api.openai.com/v1/audio/speech',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ttsParams(), input: text, response_format: 'pcm' }),
    },
    FIRST_AUDIO_MS.openai,
    (incoming) => {
      const combined = Buffer.concat([remainder, incoming]);
      const usableBytes = Math.floor(combined.byteLength / 6) * 6; // 6 PCM bytes → 1 mulaw byte
      remainder = combined.subarray(usableBytes);
      if (usableBytes === 0) return;
      const samples = new Int16Array(combined.buffer.slice(combined.byteOffset, combined.byteOffset + usableBytes));
      const mulaw = Buffer.alloc(samples.length / 3);
      for (let i = 0; i < mulaw.length; i++) mulaw[i] = linearToMulaw(down3(samples, i));
      onMulaw(mulaw);
    }
  );
}

/**
 * Stream 8kHz mulaw TTS audio to onChunk in 20ms pieces as soon as it arrives, from the disk
 * cache when possible. If the main voice fails or stalls before any audio, the other one is used.
 */
export async function streamTTSMulaw(
  text: string,
  onChunk: (mulawChunk: Buffer) => void
): Promise<void> {
  if (!fs.existsSync(MULAW_CACHE_DIR)) {
    fs.mkdirSync(MULAW_CACHE_DIR, { recursive: true });
  }

  const emit = (mulaw: Buffer) => {
    for (let i = 0; i < mulaw.length; i += 160) onChunk(mulaw.subarray(i, Math.min(i + 160, mulaw.length)));
  };

  const cachePath = path.join(MULAW_CACHE_DIR, `${mulawCacheKey(text, PRIMARY)}.mulaw`);
  if (fs.existsSync(cachePath)) {
    console.log(`[TTS] Cache hit (stream) for "${text.substring(0, 40)}..."`);
    emit(fs.readFileSync(cachePath));
    return;
  }

  const providers: Array<'aura' | 'openai'> = PRIMARY === 'aura' ? ['aura', 'openai'] : ['openai'];
  for (const provider of providers) {
    const parts: Buffer[] = [];
    const t0 = Date.now();
    try {
      await (provider === 'aura' ? streamAura : streamOpenAI)(text, (mulaw) => {
        parts.push(mulaw);
        emit(mulaw);
      });
      const full = Buffer.concat(parts);
      if (provider === PRIMARY) fs.writeFileSync(cachePath, full); // never cache the fallback voice as the main one
      console.log(`[TTS] ${provider} ${(full.length / 8000).toFixed(1)}s audio in ${Date.now() - t0}ms for "${text.substring(0, 40)}..."`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Part of the sentence was already played: replaying it in another voice would be worse.
      if (parts.length > 0 || provider === providers[providers.length - 1]) throw new Error(`${provider} TTS: ${msg}`);
      console.warn(`[TTS] ${provider} failed after ${Date.now() - t0}ms (${msg}) — trying the fallback voice`);
    }
  }
}

/** Whole-sentence mulaw 8kHz audio (same voice, fallback and cache as streamTTSMulaw). */
export async function generateTTSMulaw(text: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  await streamTTSMulaw(text, (chunk) => parts.push(chunk));
  return Buffer.concat(parts);
}

/**
 * Convert a 16-bit linear PCM sample to 8-bit mu-law (ITU G.711).
 *
 * The mu-law companding algorithm compresses 16-bit samples into 8 bits
 * using a logarithmic curve, giving more resolution to quiet sounds.
 */
function linearToMulaw(sample: number): number {
  const MULAW_BIAS = 0x84; // 132
  const MULAW_MAX = 0x7FFF; // 32767
  const CLIP = 32635;

  // Get sign bit and make sample positive
  const sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += MULAW_BIAS;

  // Find the segment (exponent) — position of highest bit
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    // empty — just scanning for the highest set bit
  }

  // Extract the 4-bit mantissa from the segment
  const mantissa = (sample >> (exponent + 3)) & 0x0F;

  // Combine sign, exponent, mantissa and complement
  const mulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return mulawByte;
}

export { openai };
