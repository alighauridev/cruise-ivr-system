// Deepgram client — used server-side only for future streaming integrations
export const deepgramApiKey = process.env.DEEPGRAM_API_KEY ?? '';

export const AGENT_DETECTION_PHRASES = [
  'how can i help',
  'how may i help',
  'how can i assist',
  'thank you for calling',
  'thank you for holding',
  'my name is',
  'this is',
  'what can i do for you',
  'good morning',
  'good afternoon',
  'good evening',
  'welcome to',
  'one moment',
  'please hold',
];

export const HOLD_MUSIC_PHRASES = [
  'your call is important',
  'all representatives are',
  'please continue to hold',
  'your estimated wait time',
  'thank you for your patience',
  'we appreciate your patience',
  'calls are answered in the order',
  'next available',
];

export function detectAgentFromTranscript(transcript: string): boolean {
  const lower = transcript.toLowerCase();
  return AGENT_DETECTION_PHRASES.some((phrase) => lower.includes(phrase));
}

export function detectHoldMusicFromTranscript(transcript: string): boolean {
  const lower = transcript.toLowerCase();
  return HOLD_MUSIC_PHRASES.some((phrase) => lower.includes(phrase));
}
