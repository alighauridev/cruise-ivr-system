import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import './globals.css';
import SessionProvider from '@/components/SessionProvider';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' });

export const metadata: Metadata = {
  title: 'CruisePro IVR System',
  description: 'Automated outbound calling & hold-waiting system for cruise lines',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} h-full`} suppressHydrationWarning>
      <body className="h-full bg-gray-950 text-gray-100 font-sans antialiased">
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
