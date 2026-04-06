import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import sql from '@/lib/db';
import type { IVRStep } from '@/lib/ivr-engine';

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

  // Support both formats:
  // Format 1 (simple): name, phone_number, category, notes
  // Format 2 (cruise sheet): cruise line, reservations / main number, tab name, notes
  const nameIdx = findCol(headers, ['name', 'cruise line', 'cruise_line']);
  const phoneIdx = findCol(headers, ['phone_number', 'phone', 'reservations / main number', 'reservations/main number', 'main number', 'number']);
  const categoryIdx = findCol(headers, ['category', 'tab name', 'tab_name']);
  const notesIdx = findCol(headers, ['notes', 'ivr steps', 'ivr_steps']);

  if (nameIdx === -1 || phoneIdx === -1) {
    return NextResponse.json({ error: 'CSV must have "name"/"cruise line" and "phone_number"/"main number" columns' }, { status: 400 });
  }

  const results = { imported: 0, ivrConfigsCreated: 0, total: 0 };

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const name = cols[nameIdx]?.trim();
    const phone = cols[phoneIdx]?.trim();
    if (!name || !phone) continue;

    results.total++;
    const category = categoryIdx !== -1 ? cols[categoryIdx]?.trim() || null : null;
    const notes = notesIdx !== -1 ? cols[notesIdx]?.trim() || null : null;

    // Parse notes into IVR steps if they look like IVR instructions
    let ivrConfigId: string | null = null;
    if (notes && looksLikeIVRSteps(notes)) {
      const steps = parseIVRNotes(notes);
      if (steps.length > 0) {
        // Create IVR config
        const configRows = await sql`
          INSERT INTO ivr_configs (user_id, name, steps)
          VALUES (${session.user.id}, ${`${name} IVR`}, ${JSON.stringify(steps)})
          RETURNING id
        `;
        ivrConfigId = configRows[0].id as string;
        results.ivrConfigsCreated++;
      }
    }

    // Create lead
    const leadRows = await sql`
      INSERT INTO leads (user_id, directory_id, name, phone_number, category, notes, ivr_config_id)
      VALUES (${session.user.id}, ${directoryId}, ${name}, ${phone}, ${category}, ${notes}, ${ivrConfigId})
      RETURNING id
    `;

    // Link IVR config back to lead
    if (ivrConfigId && leadRows[0]) {
      await sql`UPDATE ivr_configs SET lead_id = ${leadRows[0].id as string} WHERE id = ${ivrConfigId}`;
      await sql`UPDATE leads SET ivr_config_id = ${ivrConfigId} WHERE id = ${leadRows[0].id as string}`;
    }

    results.imported++;
  }

  return NextResponse.json(results);
}

function findCol(headers: string[], candidates: string[]): number {
  for (const c of candidates) {
    const idx = headers.indexOf(c);
    if (idx !== -1) return idx;
  }
  // Partial match
  for (const c of candidates) {
    const idx = headers.findIndex((h) => h.includes(c));
    if (idx !== -1) return idx;
  }
  return -1;
}

/** Parse a CSV line handling quoted fields with commas */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

/** Check if a notes string looks like IVR navigation instructions */
function looksLikeIVRSteps(notes: string): boolean {
  const lower = notes.toLowerCase();
  return lower.includes('press') || lower.includes('say ') || lower.includes('hold for agent') ||
    lower.includes('stay on the line') || lower.includes('enter ') || lower.includes('>');
}

/**
 * Parse human-readable IVR instructions into IVRStep array.
 *
 * Examples:
 *   "Press 1 for travel agent > Press 1 for existing booking > Hold for agent"
 *   "Say 'travel advisor' > Say 'representative' > Hold for agent"
 *   "Press 2 for existing booking > Press 2 for all other inquiries > Hold for agent"
 *   "Enter travel agency 2149393 # > Press 3 for existing reservation > Hold for agent"
 */
function parseIVRNotes(notes: string): IVRStep[] {
  const steps: IVRStep[] = [];
  const parts = notes.split('>').map((p) => p.trim()).filter(Boolean);
  let order = 0;

  for (const part of parts) {
    const lower = part.toLowerCase();

    // "Hold for agent" / "Hold for live agent" / "Stay on the line"
    if (lower.includes('hold for agent') || lower.includes('hold for live agent') ||
      lower.includes('stay on the line') || lower.includes('hold for representative')) {
      // Add a wait before hold
      steps.push({ order: order++, type: 'wait', duration_seconds: 3, description: 'Wait before hold' });
      steps.push({ order: order++, type: 'hold', description: part });
      continue;
    }

    // "Enter travel agency 2149393 #" — enter a sequence of digits
    const enterMatch = lower.match(/enter\s+(?:travel\s+agency\s+)?([0-9\s#*]+)/);
    if (enterMatch) {
      const digits = enterMatch[1].replace(/\s/g, '');
      // Add wait before entering digits
      steps.push({ order: order++, type: 'wait', duration_seconds: 5, description: 'Wait for IVR prompt' });
      // Enter each digit or the whole sequence
      steps.push({ order: order++, type: 'dtmf', digit: digits, description: part });
      continue;
    }

    // "Press 1 for ..." / "Press 2" / "press 5 to ..."
    const pressMatch = lower.match(/press\s+(\d+)/);
    if (pressMatch) {
      // Add a wait step before each press (for IVR to present menu)
      if (steps.length === 0) {
        steps.push({ order: order++, type: 'wait', duration_seconds: 8, description: 'Wait for IVR greeting' });
      } else {
        steps.push({ order: order++, type: 'wait', duration_seconds: 4, description: 'Wait for submenu' });
      }
      steps.push({ order: order++, type: 'dtmf', digit: pressMatch[1], description: part });
      continue;
    }

    // "Say 'travel advisor'" / 'Say "representative"' / "Say existing booking"
    const sayMatch = part.match(/[Ss]ay\s+[""']?([^""']+)[""']?/);
    if (sayMatch) {
      if (steps.length === 0) {
        steps.push({ order: order++, type: 'wait', duration_seconds: 5, description: 'Wait for IVR prompt' });
      } else {
        steps.push({ order: order++, type: 'wait', duration_seconds: 3, description: 'Wait for prompt' });
      }
      steps.push({ order: order++, type: 'voice', phrase: sayMatch[1].trim(), description: part });
      continue;
    }
  }

  return steps;
}
