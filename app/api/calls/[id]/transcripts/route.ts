import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';
import { getAuthContext } from '@/lib/admin';

/**
 * Returns all transcript events for a given call.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await getAuthContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  // Verify the call belongs to the (effective) user
  const callRows = await sql`
    SELECT id FROM calls WHERE id = ${id} AND user_id = ${ctx.effectiveUserId} LIMIT 1
  `;
  if (callRows.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Get all transcript + IVR step events
  const events = await sql`
    SELECT id, event_type, details, created_at
    FROM call_events
    WHERE call_id = ${id}
      AND event_type IN ('transcript', 'ai_action', 'ivr_step_0', 'ivr_step_1', 'ivr_step_2', 'ivr_step_3', 'ivr_step_4', 'ivr_step_5', 'ivr_step_6', 'ivr_step_7', 'ivr_step_8', 'ivr_step_9', 'agent_detected', 'entered_hold', 'voicemail_detected')
    ORDER BY created_at ASC
  `;

  return NextResponse.json({ events });
}
