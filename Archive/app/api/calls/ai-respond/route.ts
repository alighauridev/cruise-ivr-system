import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';
import { getAuthContext } from '@/lib/admin';
import { injectRealtimeInstruction, injectTTSIntoCall, getConversationHistory, getAiTask } from '@/server/media-ws';
import { generateConversationResponse } from '@/server/conversation-engine';

export async function POST(req: NextRequest) {
  const ctx = await getAuthContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { callId } = await req.json();
  if (!callId) return NextResponse.json({ error: 'callId required' }, { status: 400 });

  const rows = await sql`
    SELECT id, status FROM calls
    WHERE id = ${callId} AND user_id = ${ctx.effectiveUserId}
    LIMIT 1
  `;
  if (rows.length === 0) return NextResponse.json({ error: 'Call not found' }, { status: 404 });
  if (rows[0].status !== 'ai_conversation') {
    return NextResponse.json({ error: `Call is not in ai_conversation mode (status=${rows[0].status})` }, { status: 400 });
  }

  // If OpenAI Realtime is connected, trigger a response directly from it.
  if (injectRealtimeInstruction(callId, 'Continue the conversation — respond to the agent now.')) {
    return NextResponse.json({ ok: true, mode: 'realtime' });
  }

  // Fallback: GPT-4o generates response, TTS injects audio.
  const history = getConversationHistory(callId);
  if (history === null) {
    return NextResponse.json({ error: 'No active conversation session' }, { status: 503 });
  }

  const aiTask = getAiTask(callId);
  const response = await generateConversationResponse(history, callId, aiTask);
  if (!response) {
    return NextResponse.json({ ok: false, message: 'AI chose to stay silent' });
  }

  const result = await injectTTSIntoCall(callId, response);
  if (!result.ok) {
    return NextResponse.json({ error: `Injection failed: ${result.reason}` }, { status: 503 });
  }

  return NextResponse.json({ ok: true, text: response, mode: 'tts' });
}
