import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import sql from '@/lib/db';

/**
 * Returns the Twilio recording URL with Basic Auth credentials embedded
 * so the browser can fetch the audio directly — no server-side proxying needed.
 * We redirect to a credentialed URL to avoid streaming large audio files through
 * our server (which causes 502s on Render due to response timeouts).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  const rows = await sql`
    SELECT recording_url FROM calls
    WHERE id = ${id} AND user_id = ${session.user.id}
    LIMIT 1
  `;

  const url = rows[0]?.recording_url as string | undefined;
  if (!url) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Embed Twilio credentials directly in the URL so the browser fetches it.
  // e.g. https://api.twilio.com/... → https://ACXXX:token@api.twilio.com/...
  const sid = process.env.TWILIO_ACCOUNT_SID ?? '';
  const token = process.env.TWILIO_AUTH_TOKEN ?? '';

  try {
    const parsed = new URL(url);
    parsed.username = sid;
    parsed.password = token;
    // Redirect to the credentialed URL — browser fetches audio directly from Twilio
    return NextResponse.redirect(parsed.toString(), { status: 302 });
  } catch {
    // Fallback: proxy if URL parsing fails
    const twilioAuth = Buffer.from(`${sid}:${token}`).toString('base64');
    const resp = await fetch(url, { headers: { Authorization: `Basic ${twilioAuth}` } });
    if (!resp.ok) {
      return NextResponse.json({ error: 'Recording not available' }, { status: resp.status });
    }
    return new NextResponse(resp.body, {
      headers: {
        'Content-Type': resp.headers.get('Content-Type') ?? 'audio/mpeg',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  }
}
