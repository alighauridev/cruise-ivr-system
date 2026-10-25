import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface ConversationTurn {
  speaker: 'agent' | 'us';
  text: string;
  timestamp: number;
}

function buildSystemPrompt(aiTask: string | null): string {
  const taskLine = aiTask
    ? `Your task for this call: ${aiTask}`
    : 'Your task: gather information about cruise options and pricing.';

  return `You are an AI assistant calling a cruise line on behalf of Military Cruise Deals, a travel agency. A live cruise line representative is on the line.

${taskLine}

Rules:
- Speak in 1-2 short, natural sentences per response, in English
- You represent the agency, not the guest. If asked, say you are an AI assistant for Military Cruise Deals
- Never invent names, numbers, dates or details you were not given
- Never read, repeat or accept payment card or bank numbers; if payment or verification you don't have is needed, say "One moment, I'll connect you with my colleague."
- Stay focused on the task

Respond ONLY with what you would say aloud. No stage directions, no quotes, no explanations.`;
}

/**
 * Generate the next AI response in an ongoing conversation with a cruise agent.
 * Returns null if there's nothing to say (e.g. history ends with 'us' speaking).
 */
export async function generateConversationResponse(
  history: ConversationTurn[],
  callId: string,
  aiTask: string | null
): Promise<string | null> {
  // Don't respond if we just spoke
  if (history.length > 0 && history[history.length - 1].speaker === 'us') {
    return null;
  }

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(aiTask) },
  ];

  for (const turn of history) {
    messages.push({
      role: turn.speaker === 'agent' ? 'user' : 'assistant',
      content: turn.text,
    });
  }

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      max_tokens: 80,
      temperature: 0.7,
    });

    const text = response.choices[0]?.message?.content?.trim();
    if (!text) return null;

    console.log(`[ConvEngine] Response for callId=${callId}: "${text}"`);
    return text;
  } catch (err) {
    console.error('[ConvEngine] OpenAI error:', err);
    return null;
  }
}
