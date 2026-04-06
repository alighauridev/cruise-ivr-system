import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import sql from '@/lib/db';

/**
 * Proxy Twilio recording URLs through our server so the browser
 * doesn't need Twilio HTTP Basic Auth credentials.
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

  // Fetch from Twilio with Basic Auth
  const twilioAuth = Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  const resp = await fetch(url, {
    headers: { Authorization: `Basic ${twilioAuth}` },
  });

  if (!resp.ok) {
    return NextResponse.json({ error: 'Recording not available' }, { status: resp.status });
  }

  return new NextResponse(resp.body, {
    headers: {
      'Content-Type': resp.headers.get('Content-Type') ?? 'audio/mpeg',
      'Content-Length': resp.headers.get('Content-Length') ?? '',
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
