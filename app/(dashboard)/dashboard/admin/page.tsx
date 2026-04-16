'use client';

import { useSession } from 'next-auth/react';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface User {
  id: string;
  email: string;
  name: string;
  created_at: string;
}

export default function AdminPage() {
  const { data: session, update } = useSession();
  const router = useRouter();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState<string | null>(null);

  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin;
  const impersonating = (session?.user as { impersonating?: boolean })?.impersonating;
  const realId = (session?.user as { realId?: string })?.realId;

  useEffect(() => {
    if (!isAdmin && session) {
      router.replace('/dashboard');
      return;
    }
    fetch('/api/admin/users')
      .then((r) => r.json())
      .then((d) => { setUsers(d.users ?? []); setLoading(false); });
  }, [isAdmin, session, router]);

  async function impersonate(userId: string) {
    setSwitching(userId);
    await update({ impersonatedUserId: userId });
    router.push('/dashboard');
    router.refresh();
    setSwitching(null);
  }

  async function stopImpersonating() {
    setSwitching('stop');
    await update({ impersonatedUserId: null });
    router.refresh();
    setSwitching(null);
  }

  if (!isAdmin) return null;

  return (
    <div className="h-full flex flex-col">
      <div className="px-8 py-6 border-b border-gray-800">
        <h1 className="text-2xl font-bold text-white">Admin — User Accounts</h1>
        <p className="text-gray-400 text-sm mt-1">Click a user to log in as them</p>
      </div>

      {impersonating && (
        <div className="mx-8 mt-4 flex items-center justify-between bg-yellow-900/40 border border-yellow-700 rounded-xl px-4 py-3">
          <p className="text-yellow-300 text-sm font-medium">
            You are currently viewing as <span className="font-bold">{session?.user?.email}</span>
          </p>
          <button
            onClick={stopImpersonating}
            disabled={switching === 'stop'}
            className="text-xs bg-yellow-600 hover:bg-yellow-700 disabled:opacity-50 text-white font-semibold px-3 py-1.5 rounded-lg transition-colors"
          >
            {switching === 'stop' ? 'Switching...' : 'Back to My Account'}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-8">
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="space-y-3 max-w-2xl">
            {users.map((user) => {
              const isMe = user.id === realId;
              const isCurrent = user.id === session?.user?.id;
              return (
                <div
                  key={user.id}
                  className={`flex items-center justify-between p-4 rounded-xl border transition-colors ${
                    isCurrent
                      ? 'bg-blue-900/30 border-blue-700/50'
                      : 'bg-gray-900 border-gray-800 hover:border-gray-700'
                  }`}
                >
                  <div>
                    <p className="text-white font-medium">{user.name || '(no name)'}</p>
                    <p className="text-gray-400 text-sm">{user.email}</p>
                    <p className="text-gray-600 text-xs mt-0.5">
                      Joined {new Date(user.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {isCurrent && (
                      <span className="text-xs text-blue-400 border border-blue-700 rounded-full px-2 py-0.5">Active</span>
                    )}
                    {isMe ? (
                      <span className="text-xs text-gray-500">You</span>
                    ) : (
                      <button
                        onClick={() => isCurrent ? stopImpersonating() : impersonate(user.id)}
                        disabled={!!switching}
                        className={`text-sm font-semibold px-4 py-2 rounded-xl transition-colors disabled:opacity-50 ${
                          isCurrent
                            ? 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                            : 'bg-blue-600 hover:bg-blue-700 text-white'
                        }`}
                      >
                        {switching === user.id ? 'Switching...' : isCurrent ? 'Stop' : 'Log in as'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
