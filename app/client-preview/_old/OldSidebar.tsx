'use client';

// The sidebar exactly as it looked before the redesign (dark, blue accent). The two pages the client's rebuild
// touched switch in place; the others link to the live dashboard.
import Link from 'next/link';

export type OldView = 'agent' | 'logs';

const svg = (d: string | string[]) => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    {(Array.isArray(d) ? d : [d]).map((p) => (
      <path key={p} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={p} />
    ))}
  </svg>
);

const PHONE = 'M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z';

type Item = { label: string; icon: React.ReactNode } & ({ view: OldView; href?: undefined } | { href: string; view?: undefined });

const items: Item[] = [
  { view: 'agent' as const, label: 'Call Agent', icon: svg(PHONE) },
  { href: '/dashboard/leads', label: 'Leads', icon: svg('M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z') },
  { view: 'logs' as const, label: 'Call Logs', icon: svg('M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2') },
  { href: '/dashboard/ivr-builder', label: 'IVR Builder', icon: svg('M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z') },
  { href: '/dashboard/settings', label: 'Settings', icon: svg(['M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z', 'M15 12a3 3 0 11-6 0 3 3 0 016 0z']) },
];

export default function OldSidebar({ view, onChange }: { view: OldView; onChange: (v: OldView) => void }) {
  const cls = (active: boolean) =>
    `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors w-full text-left ${
      active ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
    }`;

  return (
    <aside className="w-64 flex flex-col bg-gray-900 border-r border-gray-800 h-full">
      {/* Brand */}
      <div className="px-6 py-5 border-b border-gray-800">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center flex-shrink-0">
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={PHONE} />
            </svg>
          </div>
          <div>
            <p className="text-sm font-bold text-white">CruisePro</p>
            <p className="text-xs text-gray-500">IVR System</p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {items.map((item) =>
          item.view ? (
            <button key={item.label} onClick={() => onChange(item.view)} className={cls(view === item.view)}>
              {item.icon}
              {item.label}
            </button>
          ) : (
            <Link key={item.label} href={item.href ?? '/dashboard/agent'} className={cls(false)} title="Opens the live dashboard (new design)">
              {item.icon}
              {item.label}
            </Link>
          )
        )}
      </nav>

      {/* User footer */}
      <div className="px-4 py-4 border-t border-gray-800">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-full bg-blue-700 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">D</div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-white truncate">Demo User</p>
            <p className="text-xs text-gray-500 truncate">demo@example.com</p>
          </div>
        </div>
        <Link href="/dashboard/agent" className="w-full text-sm text-gray-500 hover:text-gray-300 text-left transition-colors block">
          ← Back to dashboard
        </Link>
      </div>
    </aside>
  );
}
