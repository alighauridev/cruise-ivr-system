'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';

interface UserProfile {
  id: string;
  name: string;
  email: string;
}

export default function SelectProfilePage() {
  const { data: session, update, status } = useSession();
  const router = useRouter();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);

  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin;

  useEffect(() => {
    if (status === 'unauthenticated') { router.replace('/login'); return; }
    if (status !== 'authenticated') return;
    if (!isAdmin) { router.replace('/dashboard/agent'); return; }

    fetch('/api/users')
      .then((r) => r.json())
      .then((d) => { setUsers(d.users ?? []); setLoading(false); })
      .catch(() => { router.replace('/dashboard/agent'); });
  }, [status, isAdmin, router]);

  async function selectProfile(targetId: string | null) {
    setSwitching(targetId ?? 'self');
    await update({ impersonatedUserId: targetId });
    router.push('/dashboard/agent');
  }

  if (status === 'loading' || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="text-gray-400">Loading profiles...</div>
      </div>
    );
  }

  const currentId = (session?.user as { realId?: string })?.realId ?? session?.user?.id;
  const others = users.filter((u) => u.id !== currentId);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-600 mb-4">
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">Select Profile</h1>
          <p className="text-gray-400 mt-1">Choose which account to access</p>
        </div>

        <div className="bg-gray-900 rounded-2xl border border-gray-800 overflow-hidden">
          {/* Own account */}
          <button
            onClick={() => selectProfile(null)}
            disabled={!!switching}
            className="w-full flex items-center gap-4 px-6 py-4 border-b border-gray-800 hover:bg-gray-800 transition-colors disabled:opacity-50 text-left"
          >
            <div className="w-12 h-12 rounded-full bg-blue-700 flex items-center justify-center text-white font-bold text-lg flex-shrink-0">
              {session?.user?.name?.charAt(0)?.toUpperCase() ?? 'A'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white font-semibold">{session?.user?.name}</p>
              <p className="text-gray-400 text-sm">{session?.user?.email}</p>
              <p className="text-blue-400 text-xs mt-0.5">My Account</p>
            </div>
            {switching === 'self' && <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />}
          </button>

          {/* Other users */}
          {others.length > 0 && (
            <>
              <div className="px-6 py-2 bg-gray-800/50">
                <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Clients</p>
              </div>
              {others.map((u) => (
                <button
                  key={u.id}
                  onClick={() => selectProfile(u.id)}
                  disabled={!!switching}
                  className="w-full flex items-center gap-4 px-6 py-4 border-b border-gray-800 last:border-0 hover:bg-gray-800 transition-colors disabled:opacity-50 text-left"
                >
                  <div className="w-12 h-12 rounded-full bg-purple-700 flex items-center justify-center text-white font-bold text-lg flex-shrink-0">
                    {u.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-semibold">{u.name}</p>
                    <p className="text-gray-400 text-sm">{u.email}</p>
                  </div>
                  {switching === u.id
                    ? <div className="w-5 h-5 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
                    : <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                  }
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
