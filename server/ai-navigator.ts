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
  history: ConversationTurn[]
): Promise<AIAction> {
  const historyText = history
    .map((t) => `${t.speaker === 'ivr' ? 'IVR' : 'US'}: ${t.text}`)
    .join('\n');

  const userMessage = history.length > 0
    ? `Conversation so far:\n${historyText}\n\nIVR just said: "${ivrTranscript}"\n\nWhat should we do?`
    : `IVR just said: "${ivrTranscript}"\n\nWhat should we do?`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      max_tokens: 50,
      temperature: 0,
    });

    const text = response.choices[0]?.message?.content?.trim() ?? 'WAIT';
    return parseAction(text);
  } catch (err) {
    console.error('[AI Navigator] OpenAI error:', err);
    return { type: 'WAIT' };
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
