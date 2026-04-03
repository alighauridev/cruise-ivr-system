import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import sql from '@/lib/db';

export default async function Home() {
  const session = await auth();
  if (session?.user) {
    redirect('/dashboard/agent');
  }

  const rows = await sql`SELECT COUNT(*)::INTEGER as count FROM users`;
  const hasUsers = (rows[0].count as number) > 0;

  redirect(hasUsers ? '/login' : '/register');
}
