import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import Sidebar from '@/components/Sidebar';
import { UserViewProvider } from '@/lib/user-view-context';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const isAdmin = (session.user as { isAdmin?: boolean }).isAdmin ?? false;

  return (
    <UserViewProvider currentUserId={session.user.id!}>
      <div className="flex h-screen bg-gray-950 overflow-hidden">
        <Sidebar user={session.user} isAdmin={isAdmin} />
        <main className="flex-1 overflow-y-auto bg-gray-950">
          {children}
        </main>
      </div>
    </UserViewProvider>
  );
}
