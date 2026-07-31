// Deepgram client — used server-side only for future streaming integrations
export const deepgramApiKey = process.env.DEEPGRAM_API_KEY ?? '';

export const AGENT_DETECTION_PHRASES = [
  // Greeting + help offers
  'how can i help you',
  'how may i help you',
  'how can i assist you',
  'how may i assist you',
  'what can i do for you',
  'what can i help you with',
  // Name introductions — "This is Sarah", "My name is Chen", "Hello, this is Mark"
  'my name is',
  'this is ',               // "This is Shaniqua" / "This is Sarah" — virtual-assistant filter guards false positives
  'hello, this is',
  'hi, this is',
  'hi this is',
  'hello this is',
  'you are speaking with',
  "you're speaking with",
  'speaking with',
  // Post-hold greetings
  'thank you for holding, this is',
  'thank you for waiting, this is',
  'thank you for your patience, this is',
  'thank you for holding.',
  'thank you for waiting.',
  // Good morning/afternoon/evening greetings
  'good morning, my name is',
  'good afternoon, my name is',
  'good evening, my name is',
  'good morning, this is',
  'good afternoon, this is',
  'good evening, this is',
  // Mid-conversation agent signals
  'i can help you with that',
  'i would be happy to help',
  "i'll be happy to help",
  "i'd be happy to assist",
  'let me pull up your',
  'can i get your name',
  'can i get your booking',
  'can i have your name',
  'can i have your booking number',
  'may i have your name',
  'may i get your',
];

export const HOLD_MUSIC_PHRASES = [
  'your call is important',
  'all representatives are',
  'all agents are',
  'please continue to hold',
  'your estimated wait time',
  'thank you for your patience',
  'we appreciate your patience',
  'calls are answered in the order',
  'next available',
  'our menu options have changed',
  'listen carefully as our',
  'experiencing higher than normal',
  'higher than expected call volume',
  'please hold and we will',
  'we will be with you shortly',
  'the next available',
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

// Phrases that indicate a virtual assistant / AI bot — NOT a real human agent.
// If any of these are detected, suppress agent detection even if agent phrases match.
export const VIRTUAL_ASSISTANT_PHRASES = [
  'virtual assistant',
  'automated assistant',
  'ai assistant',
  'automated system',
  'this is an automated',
  'you have reached an automated',
  'our automated',
  'speaking with a virtual',
  'designed to listen and assist',
  'designed to help you',
  'i am an ai',
  'i am a virtual',
  'i\'m a virtual',
  'i\'m an automated',
];

export function detectVirtualAssistant(transcript: string): boolean {
  const lower = transcript.toLowerCase();
  return VIRTUAL_ASSISTANT_PHRASES.some((phrase) => lower.includes(phrase));
}

export function detectAgentFromTranscript(transcript: string): boolean {
  const lower = transcript.toLowerCase();
  // If it's a virtual assistant, never count as a real agent
  if (detectVirtualAssistant(lower)) return false;
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
