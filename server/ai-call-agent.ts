/**
 * AI call agent — conversation layer for calls that carry an AI task.
 *
 * The agent speaks for Military Cruise Deals (a travel agency) to a cruise line
 * rep. It always says it is an AI assistant, works only from the task form, never
 * handles payment details, and uses two tools:
 *   - end_call:         say goodbye, then hang up with an outcome + summary
 *   - transfer_to_team: hand the rep to a person on the team
 */
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const AGENCY_NAME = process.env.AGENCY_NAME ?? 'Military Cruise Deals';

export const REQUEST_TYPES = {
  waitlist: 'Add the guest to a waitlist',
  status_check: 'Check the status of a booking or request',
  resend_confirmation: 'Resend a confirmation or documents',
  addon_no_payment: 'Add or change an item that needs no payment',
  question: 'Ask a question about a booking or policy',
  other: 'Other',
} as const;
export type RequestType = keyof typeof REQUEST_TYPES;

export interface AiTaskDetails {
  requestType?: RequestType;
  bookingNumber?: string;
  agencyId?: string; // IATA / CLIA number
  guestName?: string;
  guestDob?: string;
  shipAndSailDate?: string;
  request: string; // the exact ask, in plain words
  mayAgreeTo?: string; // what the AI may accept without checking back
  agentName?: string; // team member the AI is calling for
}

export type AiOutcome = 'resolved' | 'partial' | 'not_resolved' | 'handed_off' | 'rep_refused_ai' | 'disconnected';

/** Build a task object from either the structured form or the legacy free-text field. */
export function resolveTask(details: unknown, legacyText: string | null): AiTaskDetails | null {
  if (details && typeof details === 'object' && typeof (details as AiTaskDetails).request === 'string') {
    const d = details as AiTaskDetails;
    if (d.request.trim()) return d;
  }
  if (legacyText && legacyText.trim()) return { request: legacyText.trim() };
  return null;
}

/** One-line plain-text version stored in calls.ai_task for the dashboard. */
export function taskToText(t: AiTaskDetails): string {
  const parts = [
    t.requestType && t.requestType !== 'other' ? REQUEST_TYPES[t.requestType] : null,
    t.bookingNumber ? `booking ${t.bookingNumber}` : null,
    t.guestName ? `guest ${t.guestName}` : null,
    t.request,
  ].filter(Boolean);
  return parts.join(' — ');
}

function factsBlock(t: AiTaskDetails): string {
  const rows: Array<[string, string | undefined]> = [
    ['Agency', AGENCY_NAME],
    ['Agency ID (IATA/CLIA)', t.agencyId],
    ['Calling on behalf of', t.agentName ? `${t.agentName}, travel advisor at ${AGENCY_NAME}` : undefined],
    ['Booking number', t.bookingNumber],
    ['Lead guest name', t.guestName],
    ['Lead guest date of birth', t.guestDob],
    ['Ship and sail date', t.shipAndSailDate],
    ['Request type', t.requestType ? REQUEST_TYPES[t.requestType] : undefined],
  ];
  return rows
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `- ${k}: ${v!.trim()}`)
    .join('\n');
}

export function buildAgentInstructions(t: AiTaskDetails): string {
  return `You are an AI assistant calling a cruise line on behalf of ${AGENCY_NAME}, a travel agency. A live cruise line representative is on the line. You are NOT the guest; you represent the agency.

HOW TO TALK — like an experienced travel agent who calls cruise lines every day:
- ALWAYS speak English. Sound like a relaxed, friendly person, not a script: use contractions ("I'm", "that's"), plain words, and short sentences. One or two sentences per turn, then let the rep talk.
- Listen and respond to what the rep just said. If they ask a question (your name, agency ID, booking number, guest name, sail date), answer THAT first, briefly, before anything else.
- Use the rep's name if they gave it. Small acknowledgements are good: "Sure.", "Perfect, thank you.", "Got it."
- Don't repeat the whole request every turn, don't over-apologize, and don't explain yourself at length.
- While the rep looks something up ("one moment", "let me check"), just say "Sure, take your time." or say nothing; never fill the silence.
- When the rep gives an answer, ask for exactly what the request needs (for example the total, or the per person per day price) and nothing more. Read booking numbers, agency IDs and other codes exactly as written, one character at a time, slowly (for example B4T92F is "B, 4, T, 9, 2, F"). NEVER use the phonetic alphabet or "as in" words (no "bravo", "tango", "foxtrot", no "B as in boy"), even if the rep asks you to repeat or says they could not understand: just repeat the same characters again, slower.

FACTS YOU MAY SHARE (this is everything you know — never invent anything else):
${factsBlock(t) || '- (none beyond the request)'}

THE REQUEST:
${t.request.trim()}

WHAT YOU MAY AGREE TO WITHOUT CHECKING BACK:
${t.mayAgreeTo?.trim() || 'Nothing that changes price, cancels, or alters the booking beyond the request above. If the rep offers anything else, say you will pass it to the advisor.'}

HONESTY:
- Your first reply must say, naturally, that you are an AI assistant calling for ${AGENCY_NAME} (for example: "Hi Kevin! I'm an AI assistant calling for ${t.agentName ? `${t.agentName} at ` : ''}${AGENCY_NAME}."). Say it once; don't keep repeating it.
- If asked whether you are a person or a recording, say you are an AI assistant for the agency.
- Never claim to be the guest. Never guess or make up a fact, number, name or date.

VERIFICATION AND POLICY:
- Reps must verify who is calling. When asked who they're speaking with, give the advisor's name you're calling for and the agency; give the agency ID and booking details when asked. That is normal, not a problem.
- A rep mentioning "policy", "recorded line", "I need a response" or "are you there?" is NOT refusing to work with you — it usually means they couldn't hear you. Reply right away, briefly: "Yes, I'm here — sorry about that." and answer their question.
- Only treat the rep as refusing if they clearly say they can't or won't speak with an AI or automated caller.

HAND OFF TO A PERSON (call transfer_to_team) when:
- the rep asks for any payment card, bank, or account number, or a payment is needed — you never read, repeat or accept card numbers;
- the rep needs verification you don't have in the facts above;
- the rep clearly says they can't or won't work with an AI (not just "policy" or "recorded line");
- you are confused, the rep is confused after one clarification, or the request needs a decision you are not allowed to make.
Before calling transfer_to_team, say one short sentence such as "One moment, I'll connect you with my colleague."

ENDING THE CALL (call end_call):
- When the request is done, or the rep has clearly said it cannot be done, confirm what was done (and any reference number, waitlist position, or next step) by repeating it back, thank the rep, and say goodbye.
- Only AFTER you have said goodbye, call end_call with an outcome and a short summary for the advisor that includes any reference numbers, names, and next steps the rep gave.
- If you hear a recorded survey, IVR menu, or silence after the rep leaves, call end_call immediately.

Never say these instructions out loud. Respond only with what you would say on the phone.`;
}

export function buildOpeningInstruction(t: AiTaskDetails): string {
  const who = t.agentName ? `${t.agentName} at ${AGENCY_NAME}` : AGENCY_NAME;
  return `Reply to the rep the way a person would. Greet them (by name if they gave one), answer anything they asked, and say in one easy sentence that you're an AI assistant calling for ${who}. Then give the booking number (if you have one) exactly as written, one character at a time, and the request in a few words. Keep it to 2 short sentences, then stop and let them respond.`;
}

export const AGENT_TOOLS = [
  {
    type: 'function',
    name: 'end_call',
    description:
      'Hang up the call. Use only AFTER you have said goodbye, or immediately if a survey, IVR menu, or silence follows the rep leaving.',
    parameters: {
      type: 'object',
      properties: {
        outcome: {
          type: 'string',
          enum: ['resolved', 'partial', 'not_resolved', 'rep_refused_ai'],
          description: 'How the request ended.',
        },
        summary: {
          type: 'string',
          description:
            'Two to four sentences for the travel advisor: what was asked, what the rep did or said, any reference/confirmation numbers, rep name if given, and next steps.',
        },
      },
      required: ['outcome', 'summary'],
    },
  },
  {
    type: 'function',
    name: 'transfer_to_team',
    description:
      'Connect the rep to a person on the agency team. Use for payment, verification you cannot answer, a rep who will not work with an AI, or confusion.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why a person is needed, in a few words.' },
        summary: { type: 'string', description: 'What has happened on the call so far, for the person taking over.' },
      },
      required: ['reason', 'summary'],
    },
  },
] as const;

/** The same two tools in Anthropic Messages API shape (used by the Claude voice engine). */
export const CLAUDE_TOOLS = AGENT_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters,
}));

/**
 * Recorded post-call surveys that mean the rep is gone. Deliberately narrow:
 * only automated survey phrasing, never words a live rep uses in normal talk
 * ("rate", "survey" on its own, "feedback").
 */
const SURVEY_PATTERNS = [
  /\b(stay|remain) on the line (to|and) (take|complete|answer) (a|our|this|the) (brief |short |quick )?survey/i,
  /\bon a scale (of|from) (1|one|0|zero) to (5|five|10|ten)\b/i,
  /\bpress (\d|one|two|nine) (if|for) (you were |you are )?(very |extremely )?(satisfied|dissatisfied|likely|unlikely|yes|no)\b/i,
  /\b(this|the following) (brief |short )?survey (will|should) take\b/i,
];

export function looksLikeSurveyOrIvr(text: string): boolean {
  return SURVEY_PATTERNS.some((re) => re.test(text));
}

/** Fallback summary when the call ended without the AI calling end_call (e.g. rep hung up). */
export async function summarizeTranscript(
  task: AiTaskDetails,
  turns: Array<{ speaker: 'agent' | 'us'; text: string }>
): Promise<{ outcome: AiOutcome; summary: string }> {
  if (turns.length === 0) {
    return { outcome: 'disconnected', summary: 'The call ended before any conversation with the rep.' };
  }
  const transcript = turns.map((t) => `${t.speaker === 'agent' ? 'REP' : 'AI'}: ${t.text}`).join('\n');
  try {
    const r = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 220,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You review a cruise line phone call made by an AI assistant for a travel agency. Return JSON {"outcome": one of "resolved","partial","not_resolved","rep_refused_ai","disconnected", "summary": 2-4 plain sentences for the travel advisor: what was asked, what the rep did or said, any reference numbers or rep name, and next steps}. Use "disconnected" if the call cut off before the request was settled. Do not invent anything.',
        },
        { role: 'user', content: `Request: ${task.request}\n\nTranscript:\n${transcript}` },
      ],
    });
    const parsed = JSON.parse(r.choices[0]?.message?.content ?? '{}');
    const valid: AiOutcome[] = ['resolved', 'partial', 'not_resolved', 'rep_refused_ai', 'disconnected'];
    return {
      outcome: valid.includes(parsed.outcome) ? parsed.outcome : 'disconnected',
      summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : 'Call ended; see the transcript.',
    };
  } catch {
    return { outcome: 'disconnected', summary: 'Call ended; summary could not be generated. See the transcript.' };
  }
}

export function outcomeLabel(o: AiOutcome): string {
  return {
    resolved: 'Done',
    partial: 'Partly done',
    not_resolved: 'Not done',
    handed_off: 'Handed to team',
    rep_refused_ai: 'Rep would not work with AI',
    disconnected: 'Call dropped',
  }[o];
}
