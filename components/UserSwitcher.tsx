'use client';

import { useEffect, useState } from 'react';

interface AdminUser {
  id: string;
  name: string;
  email: string;
  is_admin: boolean;
  lead_count: number;
  call_count: number;
}

interface Props {
  /** The admin's own user id. */
  realUserId: string;
  /** The user currently being impersonated, or null. */
  actingAsId: string | null;
}

export default function UserSwitcher({ realUserId, actingAsId }: Props) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/admin/users')
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((d) => setUsers(d.users ?? []))
      .catch(() => setUsers([]));
  }, []);

  const onChange = async (userId: string) => {
    setBusy(true);
    try {
      await fetch('/api/admin/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      // Full reload so every client component refetches under the new effective user
      // (router.refresh() wouldn't re-run client-side fetches like the agent page's leads).
      window.location.reload();
    } catch {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3 border-b border-line pb-3">
      <label className="eyebrow mb-1.5 block">Act as user</label>
      <select
        value={actingAsId ?? realUserId}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        className="input input-sm text-xs"
      >
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.id === realUserId ? `${u.name} (you)` : u.name}
            {u.is_admin && u.id !== realUserId ? ' · admin' : ''} — {u.lead_count} leads
          </option>
        ))}
      </select>
    </div>
  );
}
