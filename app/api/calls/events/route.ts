import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import sql from '@/lib/db';

export const dynamic = 'force-dynamic';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return new Response('Unauthorized', { status: 401 });

  const callId = req.nextUrl.searchParams.get('callId');
  if (!callId) return new Response('callId required', { status: 400 });

  const encoder = new TextEncoder();
  let closed = false;
  // Track last event timestamp (not UUID — UUIDs aren't chronologically sortable)
  let lastEventTime: string | null = null;
  // Deduplicate events: JS Date has ms precision but Postgres timestamps have µs
  // precision, so events within the same ms get refetched on subsequent polls.
  const sentEventIds = new Set<string>();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch { /* controller closed */ }
      };

      // --- Initial snapshot ---
      const [events, callRows] = await Promise.all([
        sql`
          SELECT ce.*
          FROM call_events ce
          JOIN calls c ON c.id = ce.call_id
          WHERE ce.call_id = ${callId} AND c.user_id = ${session!.user!.id}
          ORDER BY ce.created_at ASC
        `,
        sql`
          SELECT status, hold_duration_seconds, twilio_call_sid
          FROM calls WHERE id = ${callId} AND user_id = ${session!.user!.id}
          LIMIT 1
        `,
      ]);

      const call = callRows[0] ?? null;
      if (events.length > 0) {
        lastEventTime = events[events.length - 1].created_at as string;
        for (const ev of events) sentEventIds.add(ev.id as string);
      }

      send({ type: 'snapshot', events, call });

      if (call && TERMINAL_STATUSES.has(call.status as string)) {
        controller.close();
        return;
      }

      // --- Poll loop ---
      let previousStatus = call?.status as string | undefined;

      const poll = setInterval(async () => {
        if (closed || controller.desiredSize === null) {
          clearInterval(poll);
          return;
        }

        try {
          const newEvents = lastEventTime
            ? await sql`
                SELECT ce.*
                FROM call_events ce
                JOIN calls c ON c.id = ce.call_id
                WHERE ce.call_id = ${callId}
                  AND c.user_id = ${session!.user!.id}
                  AND ce.created_at > ${lastEventTime}::timestamptz
                ORDER BY ce.created_at ASC
              `
            : [];

          const updatedCallRows = await sql`
            SELECT status, hold_duration_seconds, twilio_call_sid
            FROM calls WHERE id = ${callId} AND user_id = ${session!.user!.id}
            LIMIT 1
          `;
          const updatedCall = updatedCallRows[0] ?? null;

          // Filter out already-sent events (JS Date ms precision vs Postgres µs)
          const unsent = newEvents.filter((ev) => !sentEventIds.has(ev.id as string));

          if (unsent.length > 0) {
            lastEventTime = unsent[unsent.length - 1].created_at as string;
            for (const ev of unsent) {
              sentEventIds.add(ev.id as string);
              send({ type: 'event', event: ev, call: updatedCall });
            }
          } else if (updatedCall?.status !== previousStatus) {
            send({ type: 'status', call: updatedCall });
          }

          previousStatus = updatedCall?.status as string | undefined;

          if (updatedCall && TERMINAL_STATUSES.has(updatedCall.status as string)) {
            clearInterval(poll);
            controller.close();
          }
        } catch { /* DB error — retry next tick */ }
      }, 1000);
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
