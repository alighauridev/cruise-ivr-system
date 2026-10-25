'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import AuthShell from '@/components/AuthShell';

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });

    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? 'Registration failed');
      setLoading(false);
    } else {
      router.push('/login');
    }
  }

  return (
    <AuthShell title="Create your account" subtitle="Set up your workspace in under a minute.">
      <form onSubmit={handleSubmit} className="space-y-5">
        {error && (
          <div role="alert" className="rounded-xl bg-bad-soft px-4 py-3 text-sm text-bad">
            {error}
          </div>
        )}

        {(['name', 'email', 'password'] as const).map((field) => (
          <div key={field}>
            <label className="field-label capitalize">{field}</label>
            <input
              type={field === 'email' ? 'email' : field === 'password' ? 'password' : 'text'}
              value={form[field]}
              onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
              required
              className="input py-3"
              placeholder={field === 'name' ? 'John Smith' : field === 'email' ? 'you@example.com' : '••••••••'}
            />
          </div>
        ))}

        <button type="submit" disabled={loading} className="btn btn-primary btn-lg w-full">
          {loading ? 'Creating account…' : 'Create account'}
        </button>

        <p className="text-center text-sm text-muted">
          Already have an account?{' '}
          <Link href="/login" className="font-semibold text-brand hover:text-brand-strong">
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
