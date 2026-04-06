import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type AIAction =
  | { type: 'PRESS'; digit: string }
  | { type: 'SAY'; phrase: string }
  | { type: 'WAIT' }
  | { type: 'AGENT_DETECTED' };

export interface ConversationTurn {
  speaker: 'ivr' | 'us';
  text: string;
}

const SYSTEM_PROMPT = `You are an AI navigating a cruise line phone IVR system. Your ONLY goal is to reach a live human agent as fast as possible.

Rules:
- When the IVR asks you to press a digit, respond with PRESS:<digit>
- When the IVR asks you to say something, respond with SAY:<phrase>
- When the IVR is still talking or playing hold music, respond with WAIT
- When a LIVE HUMAN AGENT has answered (not a bot), respond with AGENT_DETECTED
- Never press digits for time-sensitive options (like "traveling within 72 hours") unless you need to reach a live agent
- Always prefer options that lead to a live agent: "reservations", "speak to an agent", "new booking", "customer service"
- If asked for an account number or booking number, say "I don't have that information" and try to get to an agent anyway
- Signs of a live human agent: they greet you personally, say their name, say "how can I help you today", etc.
- Signs of hold music / automated: repetitive music, "your call is important", "please hold", "estimated wait time"

Respond with EXACTLY ONE of these formats (nothing else):
PRESS:1
SAY:speak to an agent
WAIT
AGENT_DETECTED`;

export async function decideAction(
  ivrTranscript: string,
  history: ConversationTurn[],
  forceGpt4o = false
): Promise<AIAction> {
  const historyText = history
    .map((t) => `${t.speaker === 'ivr' ? 'IVR' : 'US'}: ${t.text}`)
    .join('\n');

  const userMessage = history.length > 0
    ? `Conversation so far:\n${historyText}\n\nIVR just said: "${ivrTranscript}"\n\nWhat should we do?`
    : `IVR just said: "${ivrTranscript}"\n\nWhat should we do?`;

  // Use gpt-4o for complex/long conversations, mini for everything else (faster + cheaper)
  const model = forceGpt4o || history.length > 8 ? 'gpt-4o' : 'gpt-4o-mini';

  try {
    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 20,
      temperature: 0,
    });

    const text = response.choices[0]?.message?.content?.trim() ?? 'WAIT';
    return parseAction(text);
  } catch (err) {
    console.error('[AI Navigator] OpenAI error:', err);
    return { type: 'WAIT' };
  }
}

/**
 * Two-stage agent classifier:
 * Stage 1: fast phrase match (called separately via detectAgentFromTranscript)
 * Stage 2: GPT-4o-mini semantic classifier for ambiguous transcripts
 */
export async function detectAgentWithAI(
  transcript: string,
  recentHistory: string[]
): Promise<boolean> {
  const context = recentHistory.slice(-3).join('\n');
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You detect if a LIVE HUMAN agent has answered a cruise line phone call. Respond ONLY with "YES" or "NO".

YES = real human: said their personal name ("This is Sarah", "My name is Chen"), greeted you personally and is waiting for YOUR response.
NO = any of these: IVR menu, hold music, recorded message, virtual assistant, AI bot, automated system, or anything that says "virtual assistant", "automated", "AI", "designed to help", "press 1", "please hold".

Be conservative — when in doubt say NO. A virtual assistant saying "How can I help you?" is still NO.`,
        },
        {
          role: 'user',
          content: `Recent conversation:\n${context}\n\nLatest: "${transcript}"\n\nLive human agent?`,
        },
      ],
      max_tokens: 5,
      temperature: 0,
    });
    const text = response.choices[0]?.message?.content?.trim().toUpperCase() ?? 'NO';
    return text === 'YES';
  } catch {
    return false;
  }
}

function parseAction(text: string): AIAction {
  if (text.startsWith('PRESS:')) {
    const digit = text.replace('PRESS:', '').trim().charAt(0);
    return { type: 'PRESS', digit };
  }
  if (text.startsWith('SAY:')) {
    const phrase = text.replace('SAY:', '').trim();
    return { type: 'SAY', phrase };
  }
  if (text === 'AGENT_DETECTED') {
    return { type: 'AGENT_DETECTED' };
  }
  return { type: 'WAIT' };
}
