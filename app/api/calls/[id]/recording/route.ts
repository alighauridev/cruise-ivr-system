import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import sql from '@/lib/db';

export async function GET(
  req: NextRequest,
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

  const twilioAuth = Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  // Stream with a 25s timeout — Render kills at 30s
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Basic ${twilioAuth}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      return NextResponse.json({ error: 'Recording not available' }, { status: resp.status });
    }

    // Stream the body — don't buffer the whole file in memory
    return new NextResponse(resp.body, {
      status: 200,
      headers: {
        'Content-Type': resp.headers.get('Content-Type') ?? 'audio/mpeg',
        'Content-Length': resp.headers.get('Content-Length') ?? '',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (err: any) {
    clearTimeout(timeout);
    if (err?.name === 'AbortError') {
      return NextResponse.json({ error: 'Recording fetch timed out' }, { status: 504 });
    }
    return NextResponse.json({ error: 'Failed to fetch recording' }, { status: 500 });
  }
}
