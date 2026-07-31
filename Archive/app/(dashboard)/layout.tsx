import { redirect } from 'next/navigation';
import sql from '@/lib/db';
import { getAuthContext } from '@/lib/admin';
import Sidebar from '@/components/Sidebar';
import ImpersonationBanner from '@/components/ImpersonationBanner';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  // The real logged-in user (shown in the sidebar footer).
  const meRows = await sql`SELECT id, name, email FROM users WHERE id = ${ctx.realUserId} LIMIT 1`;
  const me = meRows[0] as { id: string; name: string; email: string } | undefined;
  if (!me) redirect('/login');

  // When impersonating, fetch the target user for the banner.
  type BasicUser = { id: string; name: string; email: string };
  let actingUser: BasicUser | null = null;
  if (ctx.impersonating) {
    const rows = await sql`SELECT id, name, email FROM users WHERE id = ${ctx.effectiveUserId} LIMIT 1`;
    actingUser = (rows[0] as BasicUser | undefined) ?? null;
  }

  return (
    <div className="flex h-screen bg-gray-950 overflow-hidden">
      <Sidebar
        user={{ name: me.name, email: me.email }}
        isAdmin={ctx.isAdmin}
        realUserId={ctx.realUserId}
        actingAsId={ctx.impersonating ? ctx.effectiveUserId : null}
      />
      <main className="flex-1 overflow-y-auto bg-gray-950 flex flex-col">
        {actingUser && <ImpersonationBanner name={actingUser.name} email={actingUser.email} />}
        <div className="flex-1 overflow-y-auto">{children}</div>
      </main>
    </div>
  );
}
