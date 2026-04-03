import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import sql from '@/lib/db';

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const formData = await req.formData();
  const file = formData.get('file') as File;
  const directoryId = formData.get('directoryId') as string;

  if (!file || !directoryId) {
    return NextResponse.json({ error: 'file and directoryId required' }, { status: 400 });
  }

  const text = await file.text();
  const lines = text.split('\n').filter(Boolean);
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase().replace(/"/g, ''));

  const nameIdx = headers.indexOf('name');
  const phoneIdx = headers.indexOf('phone_number') !== -1 ? headers.indexOf('phone_number') : headers.indexOf('phone');
  const categoryIdx = headers.indexOf('category');
  const notesIdx = headers.indexOf('notes');

  if (nameIdx === -1 || phoneIdx === -1) {
    return NextResponse.json({ error: 'CSV must have "name" and "phone_number" columns' }, { status: 400 });
  }

  const leads = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim().replace(/"/g, ''));
    const name = cols[nameIdx];
    const phone = cols[phoneIdx];
    if (!name || !phone) continue;

    const category = categoryIdx !== -1 ? cols[categoryIdx] : null;
    const notes = notesIdx !== -1 ? cols[notesIdx] : null;
    leads.push({ name, phone, category, notes });
  }

  let imported = 0;
  for (const lead of leads) {
    await sql`
      INSERT INTO leads (user_id, directory_id, name, phone_number, category, notes)
      VALUES (${session.user.id}, ${directoryId}, ${lead.name}, ${lead.phone}, ${lead.category}, ${lead.notes})
      ON CONFLICT DO NOTHING
    `;
    imported++;
  }

  return NextResponse.json({ imported, total: leads.length });
}
