import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import sql from '@/lib/db';
import { injectRealtimeInstruction, injectTTSIntoCall } from '@/server/media-ws';

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { callId, text } = await req.json();
  if (!callId || !text?.trim()) {
    return NextResponse.json({ error: 'callId and text required' }, { status: 400 });
  }

  const TERMINAL = ['completed', 'failed', 'cancelled'];
  const rows = await sql`
    SELECT id, status FROM calls
    WHERE id = ${callId} AND user_id = ${session.user.id}
    LIMIT 1
  `;
  if (rows.length === 0) return NextResponse.json({ error: 'Call not found' }, { status: 404 });
  if (TERMINAL.includes(rows[0].status as string)) {
    return NextResponse.json({ error: 'Call has ended' }, { status: 400 });
  }

  // In AI conversation mode: try Realtime first so AI speaks naturally.
  if (rows[0].status === 'ai_conversation' && injectRealtimeInstruction(callId, text.trim())) {
    return NextResponse.json({ ok: true, mode: 'realtime' });
  }

  // All other statuses (navigating_ivr, on_hold, agent_detected, connected): direct TTS.
  const result = await injectTTSIntoCall(callId, text.trim());
  if (!result.ok) {
    return NextResponse.json({ error: `Session unavailable: ${result.reason}` }, { status: 503 });
  }

  return NextResponse.json({ ok: true, mode: 'tts' });
}
