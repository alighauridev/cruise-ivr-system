'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import UserSwitcher from './UserSwitcher';
import { BrandMark, Icon, type IconName } from './icons';
import { AdminBadge } from './ui';

interface SidebarProps {
  user: { name?: string | null; email?: string | null };
  isAdmin?: boolean;
  realUserId?: string;
  actingAsId?: string | null;
}

const navItems: Array<{ href: string; label: string; icon: IconName }> = [
  { href: '/dashboard/agent', label: 'Call Agent', icon: 'phone' },
  { href: '/dashboard/leads', label: 'Leads', icon: 'users' },
  { href: '/dashboard/call-logs', label: 'Call Logs', icon: 'list' },
  { href: '/dashboard/ivr-builder', label: 'IVR Builder', icon: 'flow' },
  { href: '/dashboard/settings', label: 'Settings', icon: 'settings' },
];

function NavLink({ href, label, icon, active }: { href: string; label: string; icon: IconName; active: boolean }) {
  return (
    <Link
      href={href}
      title={label}
      className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors max-lg:justify-center ${
        active ? 'bg-brand font-semibold text-white shadow-sm' : 'font-medium text-[#d9ccb7] hover:bg-white/10 hover:text-white'
      }`}
    >
            <Icon name={icon} className={`h-[19px] w-[19px] ${active ? 'text-white' : 'text-[#b8a98f] group-hover:text-white'}`} />
      <span className="max-lg:hidden">{label}</span>
    </Link>
  );
}

export default function Sidebar({ user, isAdmin, realUserId, actingAsId }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-64 flex-shrink-0 flex-col bg-side max-lg:w-[76px]">
      {/* Brand */}
      <div className="flex items-center gap-3 px-6 pb-4 pt-7 max-lg:justify-center max-lg:px-0">
        <BrandMark className="h-10 w-10" />
        <div className="max-lg:hidden">
          <p className="font-display text-[19px] font-medium leading-none text-white">CruisePro</p>
          <p className="mt-1 text-xs text-[#b8a98f]">IVR Console</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-1 px-3 pt-4">
        <p className="eyebrow mb-2 px-3 !text-white/50 max-lg:hidden">Workspace</p>
        {navItems.map((item) => (
          <NavLink key={item.href} {...item} active={pathname === item.href || pathname.startsWith(item.href + '/')} />
        ))}
      </nav>

      {/* User footer */}
      <div className="m-3 rounded-2xl bg-surface p-3 shadow-card max-lg:hidden">
        {isAdmin && realUserId && <UserSwitcher realUserId={realUserId} actingAsId={actingAsId ?? null} />}
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-brand text-sm font-semibold text-white">
            {user.name?.charAt(0)?.toUpperCase() ?? 'U'}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <p className="truncate text-sm font-semibold text-ink">{user.name}</p>
              {isAdmin && <AdminBadge />}
            </div>
            <p className="truncate text-xs text-muted">{user.email}</p>
          </div>
        </div>
        <button
          onClick={() => signOut({ callbackUrl: '/login' })}
          className="btn btn-ghost mt-3 w-full !justify-start !px-2.5 !py-2 text-[13px]"
        >
          <Icon name="logout" className="h-4 w-4" />
          Sign out
        </button>
      </div>
      <button
        onClick={() => signOut({ callbackUrl: '/login' })}
        title="Sign out"
        className="btn-icon mx-auto mb-4 hidden h-10 w-10 !text-white/70 hover:!bg-white/10 hover:!text-white max-lg:inline-flex"
      >
        <Icon name="logout" className="h-[18px] w-[18px]" />
      </button>
    </aside>
  );
}
