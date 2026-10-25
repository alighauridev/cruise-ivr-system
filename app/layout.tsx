import type { Metadata } from 'next';
import { Figtree, Fraunces } from 'next/font/google';
import './globals.css';
import SessionProvider from '@/components/SessionProvider';

const figtree = Figtree({ subsets: ['latin'], variable: '--font-figtree' });
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces' });

export const metadata: Metadata = {
  title: 'CruisePro IVR System',
  description: 'Automated outbound calling & hold-waiting system for cruise lines',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${figtree.variable} ${fraunces.variable} h-full`} suppressHydrationWarning>
      <body className="h-full bg-canvas font-sans text-ink antialiased">
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
