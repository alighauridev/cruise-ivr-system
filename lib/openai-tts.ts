import OpenAI from 'openai';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CACHE_DIR = path.join(process.cwd(), 'public', 'tts', 'cache');
const MULAW_CACHE_DIR = path.join(process.cwd(), 'public', 'tts', 'mulaw-cache');

/** Generate MP3 TTS audio (cached). */
export async function generateTTS(text: string): Promise<Buffer> {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const cachePath = path.join(CACHE_DIR, `${hash}.mp3`);

  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath);
  }

  const response = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'nova',
    input: text,
    response_format: 'mp3',
  });
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  fs.writeFileSync(cachePath, buffer);
  return buffer;
}

/**
 * Stream mulaw 8kHz TTS audio to a callback as soon as PCM chunks arrive from OpenAI.
 * Dramatically reduces time-to-first-audio vs waiting for the full response.
 *
 * Flow: OpenAI TTS stream (PCM 24kHz 16-bit) → downsample to 8kHz → mulaw → onChunk()
 * Also saves the complete mulaw to disk for future cache hits.
 */
export async function streamTTSMulaw(
  text: string,
  onChunk: (mulawChunk: Buffer) => void
): Promise<void> {
  if (!fs.existsSync(MULAW_CACHE_DIR)) {
    fs.mkdirSync(MULAW_CACHE_DIR, { recursive: true });
  }

  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const cachePath = path.join(MULAW_CACHE_DIR, `${hash}.mulaw`);

  // Serve from cache in 160-byte chunks (no network round-trip)
  if (fs.existsSync(cachePath)) {
    console.log(`[TTS] Cache hit (stream) for "${text.substring(0, 40)}..."`);
    const cached = fs.readFileSync(cachePath);
    const CHUNK = 160;
    for (let i = 0; i < cached.length; i += CHUNK) {
      onChunk(cached.subarray(i, Math.min(i + CHUNK, cached.length)));
    }
    return;
  }

  console.log(`[TTS] Streaming mulaw for "${text.substring(0, 40)}..."`);

  const response = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'nova',
    input: text,
    response_format: 'pcm',
  });

  // Accumulate PCM for cache, convert+emit mulaw chunks as they arrive
  const pcmAccum: Buffer[] = [];
  let remainder = Buffer.alloc(0); // bytes that don't yet form a full group of 3 samples
  const CHUNK_OUT = 160; // 20ms of mulaw at 8kHz

  // The OpenAI SDK response has a .body ReadableStream in Node 18+
  const reader = (response as unknown as { body: { getReader(): ReadableStreamDefaultReader<Uint8Array> } }).body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const incoming = Buffer.from(value);
    pcmAccum.push(incoming);
    const combined = Buffer.concat([remainder, incoming]);

    // Downsample 24kHz→8kHz: take every 3rd 16-bit sample (6 PCM bytes → 1 mulaw byte)
    const usableBytes = Math.floor(combined.byteLength / 6) * 6;
    remainder = combined.subarray(usableBytes);
    if (usableBytes === 0) continue;

    const samples = new Int16Array(combined.buffer, combined.byteOffset, usableBytes / 2);
    const mulawCount = Math.floor(samples.length / 3);
    const mulawChunk = Buffer.alloc(mulawCount);
    for (let i = 0; i < mulawCount; i++) {
      mulawChunk[i] = linearToMulaw(samples[i * 3]);
    }

    // Emit in 160-byte pieces so Twilio gets a steady stream
    for (let i = 0; i < mulawChunk.length; i += CHUNK_OUT) {
      onChunk(mulawChunk.subarray(i, Math.min(i + CHUNK_OUT, mulawChunk.length)));
    }
  }

  // Handle any leftover PCM bytes
  if (remainder.byteLength >= 2) {
    const samples = new Int16Array(remainder.buffer, remainder.byteOffset, Math.floor(remainder.byteLength / 2));
    const mulawCount = Math.floor(samples.length / 3);
    if (mulawCount > 0) {
      const mulawChunk = Buffer.alloc(mulawCount);
      for (let i = 0; i < mulawCount; i++) mulawChunk[i] = linearToMulaw(samples[i * 3]);
      for (let i = 0; i < mulawChunk.length; i += 160) {
        onChunk(mulawChunk.subarray(i, Math.min(i + 160, mulawChunk.length)));
      }
    }
  }

  // Cache the complete mulaw for future calls
  const fullPcm = Buffer.concat(pcmAccum);
  const allSamples = new Int16Array(fullPcm.buffer, fullPcm.byteOffset, Math.floor(fullPcm.byteLength / 2));
  const sampleCount = Math.floor(allSamples.length / 3);
  const fullMulaw = Buffer.alloc(sampleCount);
  for (let i = 0; i < sampleCount; i++) fullMulaw[i] = linearToMulaw(allSamples[i * 3]);
  fs.writeFileSync(cachePath, fullMulaw);
  console.log(`[TTS] Streamed+cached ${fullMulaw.length} mulaw bytes (${(fullMulaw.length / 8000).toFixed(1)}s) for "${text.substring(0, 40)}..."`);
}

/**
 * Generate mulaw 8kHz TTS audio suitable for Twilio bidirectional media streams.
 * Returns a Buffer of raw 8-bit mulaw samples at 8000 Hz.
 *
 * Flow: OpenAI TTS (PCM 24kHz 16-bit) → downsample to 8kHz → convert to mulaw
 */
export async function generateTTSMulaw(text: string): Promise<Buffer> {
  if (!fs.existsSync(MULAW_CACHE_DIR)) {
    fs.mkdirSync(MULAW_CACHE_DIR, { recursive: true });
  }

  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const cachePath = path.join(MULAW_CACHE_DIR, `${hash}.mulaw`);

  // Return cached mulaw if available
  if (fs.existsSync(cachePath)) {
    console.log(`[TTS] Cache hit for "${text.substring(0, 40)}..."`);
    return fs.readFileSync(cachePath);
  }

  console.log(`[TTS] Generating mulaw for "${text.substring(0, 40)}..."`);

  // Get raw PCM from OpenAI: 24kHz, 16-bit signed LE, mono
  const response = await openai.audio.speech.create({
    model: 'tts-1',
    voice: 'nova',
    input: text,
    response_format: 'pcm',
  });
  const arrayBuffer = await response.arrayBuffer();
  const pcm24k = Buffer.from(arrayBuffer);

  // Downsample 24kHz → 8kHz (take every 3rd sample)
  const samples24k = new Int16Array(pcm24k.buffer, pcm24k.byteOffset, pcm24k.byteLength / 2);
  const sampleCount8k = Math.floor(samples24k.length / 3);
  const mulawBuffer = Buffer.alloc(sampleCount8k);

  for (let i = 0; i < sampleCount8k; i++) {
    mulawBuffer[i] = linearToMulaw(samples24k[i * 3]);
  }

  // Cache for future use
  fs.writeFileSync(cachePath, mulawBuffer);
  console.log(`[TTS] Generated ${mulawBuffer.length} mulaw bytes (${(mulawBuffer.length / 8000).toFixed(1)}s)`);

  return mulawBuffer;
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
