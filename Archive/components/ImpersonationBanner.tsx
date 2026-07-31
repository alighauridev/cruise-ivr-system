'use client';

import { useState } from 'react';

interface Props {
  name: string;
  email: string;
}

export default function ImpersonationBanner({ name, email }: Props) {
  const [busy, setBusy] = useState(false);

  const exit = async () => {
    setBusy(true);
    try {
      await fetch('/api/admin/impersonate', { method: 'DELETE' });
      // Full reload so every client component refetches as the admin's own account.
      window.location.reload();
    } catch {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-4 px-8 py-2.5 bg-amber-950/60 border-b border-amber-700/50 text-amber-200">
      <p className="text-sm">
        <span className="font-semibold">Acting as {name}</span>
        <span className="text-amber-400/70"> · {email}</span>
        <span className="text-amber-400/70"> — everything you do is saved to this user&apos;s account.</span>
      </p>
      <button
        onClick={exit}
        disabled={busy}
        className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-700/40 hover:bg-amber-700/60 border border-amber-600/50 text-amber-100 transition-colors disabled:opacity-50 flex-shrink-0"
      >
        Exit impersonation
      </button>
    </div>
  );
}
