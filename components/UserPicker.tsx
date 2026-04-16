'use client';

import { useEffect, useRef, useState } from 'react';
import { useUserView } from '@/lib/user-view-context';

interface UserOption {
  id: string;
  name: string;
  email: string;
}

export default function UserPicker({ currentUserId }: { currentUserId: string }) {
  const { viewAsUser, setViewAs } = useUserView();
  const [users, setUsers] = useState<UserOption[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/users')
      .then((r) => r.json())
      .then((d) => setUsers(d.users ?? []));
  }, []);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const others = users.filter((u) => u.id !== currentUserId);
  if (others.length === 0) return null;

  const active = viewAsUser;

  return (
    <div ref={ref} className="px-3 pb-3 relative">
      <p className="text-xs text-gray-600 font-medium uppercase tracking-wide px-1 mb-1">Viewing as</p>
      <button
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm transition-colors border ${
          active
            ? 'bg-purple-900/30 border-purple-700/50 text-purple-300'
            : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'
        }`}
      >
        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
          active ? 'bg-purple-700 text-white' : 'bg-gray-700 text-gray-400'
        }`}>
          {active ? active.name.charAt(0).toUpperCase() : 'Me'}
        </div>
        <span className="truncate flex-1 text-left">
          {active ? active.name : 'My Account'}
        </span>
        <svg className="w-4 h-4 flex-shrink-0 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-3 right-3 bottom-full mb-1 bg-gray-800 border border-gray-700 rounded-xl shadow-xl z-50 overflow-hidden">
          <button
            onClick={() => { setViewAs(null); setOpen(false); }}
            className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm transition-colors hover:bg-gray-700 ${!active ? 'text-white' : 'text-gray-400'}`}
          >
            <div className="w-6 h-6 rounded-full bg-blue-700 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">Me</div>
            <div className="text-left min-w-0">
              <p className="font-medium truncate">My Account</p>
            </div>
            {!active && <svg className="w-4 h-4 text-blue-400 ml-auto flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>}
          </button>

          <div className="border-t border-gray-700" />

          {others.map((u) => (
            <button
              key={u.id}
              onClick={() => { setViewAs(u); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm transition-colors hover:bg-gray-700 ${active?.id === u.id ? 'text-white' : 'text-gray-400'}`}
            >
              <div className="w-6 h-6 rounded-full bg-purple-700 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
                {u.name.charAt(0).toUpperCase()}
              </div>
              <div className="text-left min-w-0">
                <p className="font-medium truncate">{u.name}</p>
                <p className="text-xs text-gray-500 truncate">{u.email}</p>
              </div>
              {active?.id === u.id && <svg className="w-4 h-4 text-purple-400 ml-auto flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
