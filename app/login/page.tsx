'use client';

import { useState, useEffect, Suspense } from 'react';
import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import AuthShell from '@/components/AuthShell';

function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const searchParams = useSearchParams();

  useEffect(() => {
    if (searchParams.get('error')) {
      setError('Invalid email or password');
    }
  }, [searchParams]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    await signIn('credentials', { email, password, callbackUrl: '/dashboard/agent' });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <div role="alert" className="rounded-xl bg-bad-soft px-4 py-3 text-sm text-bad">
          {error}
        </div>
      )}

      <div>
        <label className="field-label">Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="input py-3"
          placeholder="you@example.com"
        />
      </div>

      <div>
        <label className="field-label">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className="input py-3"
          placeholder="••••••••"
        />
      </div>

      <button type="submit" disabled={loading} className="btn btn-primary btn-lg w-full">
        {loading ? 'Signing in…' : 'Sign in'}
      </button>

      <p className="text-center text-sm text-muted">
        New here?{' '}
        <Link href="/register" className="font-semibold text-brand hover:text-brand-strong">
          Create an account
        </Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your CruisePro dashboard.">
      <Suspense fallback={<div className="h-64 animate-pulse rounded-2xl bg-sunken" />}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
