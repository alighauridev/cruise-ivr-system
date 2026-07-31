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

  return `You are a polite customer who has called a cruise line. A live agent has just answered. You are speaking to them directly on the phone.

${taskLine}

Rules:
- Be natural and conversational — you are a real customer on the phone
- Speak in 1-2 short sentences maximum per response
- When the agent asks for personal details you don't have (full name, address, payment info), say something like "Let me just confirm that with my partner, one moment" or "I'll need to check that, could you hold briefly?"
- If the agent seems confused or asks to speak to a manager, say: "Of course, let me get them for you right away."
- Never break character or mention you are an AI
- Express genuine interest and enthusiasm about the cruise
- If the agent says they can't hear you or something is wrong with the line, say "Hello? Can you hear me? Sorry about that."
- Stay focused on the task — don't go off-topic

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
