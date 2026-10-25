'use client';

import { useState } from 'react';
import { Icon } from './icons';

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
    <div className="flex items-center justify-between gap-4 border-b border-warn/20 bg-warn-soft px-10 py-2.5 text-warn max-lg:px-6">
      <p className="flex items-center gap-2.5 text-sm">
        <Icon name="shield" className="h-4 w-4 flex-shrink-0" />
        <span>
          <span className="font-semibold">Acting as {name}</span>
          <span className="opacity-75"> · {email} — everything you do is saved to this user&apos;s account.</span>
        </span>
      </p>
      <button
        onClick={exit}
        disabled={busy}
        className="btn flex-shrink-0 border border-warn/30 bg-surface/70 !px-3 !py-1.5 text-xs text-warn hover:bg-surface"
      >
        Exit impersonation
      </button>
    </div>
  );
}
