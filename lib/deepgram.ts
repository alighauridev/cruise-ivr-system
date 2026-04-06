// Deepgram client — used server-side only for future streaming integrations
export const deepgramApiKey = process.env.DEEPGRAM_API_KEY ?? '';

export const AGENT_DETECTION_PHRASES = [
  'how can i help you',
  'how may i help you',
  'how can i assist you',
  'thank you for holding',
  'my name is',
  'this is',
  'what can i do for you',
  'good morning, my name',
  'good afternoon, my name',
  'good evening, my name',
  'i can help you with that',
  'i would be happy to help',
  "i'll be happy to help",
  'let me pull up your',
  'can i get your name',
  'can i get your booking',
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
  'our menu options have changed',
  'listen carefully as our',
];

export const VOICEMAIL_PHRASES = [
  'please leave a message',
  'leave a message after the tone',
  'leave a message after the beep',
  'mailbox is full',
  'you have reached the voicemail',
  'please record your message',
  'at the tone please record',
  'your call has been forwarded to an automated voice',
  'the person you are trying to reach',
  'is not available to take your call',
  'leave your name and number',
];

export function detectAgentFromTranscript(transcript: string): boolean {
  const lower = transcript.toLowerCase();
  return AGENT_DETECTION_PHRASES.some((phrase) => lower.includes(phrase));
}

export function detectHoldMusicFromTranscript(transcript: string): boolean {
  const lower = transcript.toLowerCase();
  return HOLD_MUSIC_PHRASES.some((phrase) => lower.includes(phrase));
}

export function detectVoicemail(transcript: string): boolean {
  const lower = transcript.toLowerCase();
  return VOICEMAIL_PHRASES.some((phrase) => lower.includes(phrase));
}
