'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

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
  const router = useRouter();
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
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3">
      <label className="text-[10px] text-gray-500 uppercase tracking-wider block mb-1">Act as user</label>
      <select
        value={actingAsId ?? realUserId}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500 disabled:opacity-50"
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
