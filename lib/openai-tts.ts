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
    voice: 'alloy',
    input: text,
    response_format: 'mp3',
  });
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  fs.writeFileSync(cachePath, buffer);
  return buffer;
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
    voice: 'alloy',
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
