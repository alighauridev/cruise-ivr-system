import { NextRequest, NextResponse } from 'next/server';
import sql from '@/lib/db';
import { getAuthContext } from '@/lib/admin';

export async function GET() {
  const ctx = await getAuthContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const user = await sql`SELECT * FROM users WHERE id = ${ctx.effectiveUserId} LIMIT 1`;
  const settings = await sql`SELECT key, value FROM settings WHERE user_id = ${ctx.effectiveUserId}`;

  const settingsMap: Record<string, string> = {};
  for (const s of settings) settingsMap[s.key as string] = s.value as string;

  return NextResponse.json({ user: user[0], settings: settingsMap, impersonating: ctx.impersonating });
}

export async function PUT(req: NextRequest) {
  const ctx = await getAuthContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { transfer_phone, notification_preference, notification_phone, settings, transfer_numbers, connect_message } = await req.json();

  await sql`
    UPDATE users
    SET transfer_phone          = ${transfer_phone ?? null},
        notification_preference = ${notification_preference ?? 'sms'},
        notification_phone      = ${notification_phone ?? null},
        transfer_numbers        = ${JSON.stringify(transfer_numbers ?? [])}::jsonb,
        connect_message         = ${connect_message ?? null},
        updated_at              = NOW()
    WHERE id = ${ctx.effectiveUserId}
  `;

  if (settings && typeof settings === 'object') {
    for (const [key, value] of Object.entries(settings)) {
      await sql`
        INSERT INTO settings (user_id, key, value)
        VALUES (${ctx.effectiveUserId}, ${key}, ${value as string})
        ON CONFLICT (user_id, key) DO UPDATE SET value = ${value as string}, updated_at = NOW()
      `;
    }
  }

  return NextResponse.json({ ok: true });
}
