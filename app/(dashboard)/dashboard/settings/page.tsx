'use client';

import { useState, useEffect } from 'react';

interface SettingsData {
  user: {
    name: string;
    email: string;
    transfer_phone: string;
    notification_preference: string;
    notification_phone: string;
  };
  settings: Record<string, string>;
}

export default function SettingsPage() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [form, setForm] = useState({
    transfer_phone: '',
    notification_preference: 'sms',
    notification_phone: '',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setForm({
          transfer_phone: d.user?.transfer_phone ?? '',
          notification_preference: d.user?.notification_preference ?? 'sms',
          notification_phone: d.user?.notification_phone ?? '',
        });
      });
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-8 py-6 border-b border-gray-800">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-gray-400 text-sm mt-1">Configure your calling preferences and API integrations</p>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="max-w-2xl space-y-8">
          {/* Account info */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
            <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              Account
            </h2>
            <div className="space-y-3">
              <div className="flex justify-between items-center py-2 border-b border-gray-800">
                <span className="text-sm text-gray-500">Name</span>
                <span className="text-sm text-white">{data?.user?.name ?? '—'}</span>
              </div>
              <div className="flex justify-between items-center py-2">
                <span className="text-sm text-gray-500">Email</span>
                <span className="text-sm text-white">{data?.user?.email ?? '—'}</span>
              </div>
            </div>
          </div>

          {/* Call settings */}
          <form onSubmit={handleSave} className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-5">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
              </svg>
              Call Preferences
            </h2>

            <div>
              <label className="block text-sm text-gray-400 mb-2">Default Transfer Number</label>
              <input
                type="tel"
                value={form.transfer_phone}
                onChange={(e) => setForm((f) => ({ ...f, transfer_phone: e.target.value }))}
                placeholder="+18669645482"
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
              />
              <p className="text-xs text-gray-600 mt-1.5">The phone number to call you at when a live agent answers.</p>
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-2">Notification Preference</label>
              <div className="grid grid-cols-3 gap-2">
                {['sms', 'push', 'both'].map((pref) => (
                  <button
                    key={pref}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, notification_preference: pref }))}
                    className={`py-2.5 rounded-xl text-sm font-medium border transition-colors capitalize ${
                      form.notification_preference === pref
                        ? 'bg-blue-600 border-blue-600 text-white'
                        : 'border-gray-700 text-gray-500 hover:text-gray-300'
                    }`}
                  >
                    {pref}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-2">SMS Notification Number</label>
              <input
                type="tel"
                value={form.notification_phone}
                onChange={(e) => setForm((f) => ({ ...f, notification_phone: e.target.value }))}
                placeholder="+15551234567"
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
              />
              <p className="text-xs text-gray-600 mt-1.5">Phone number that receives SMS alerts when an agent is detected.</p>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white font-semibold px-5 py-2.5 rounded-xl transition-colors text-sm"
            >
              {saved ? (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Saved!
                </>
              ) : saving ? 'Saving...' : 'Save Settings'}
            </button>
          </form>

          {/* API keys info */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
            <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
              <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
              API Integrations
            </h2>
            <div className="space-y-3 text-sm">
              {[
                { label: 'Twilio', key: 'TWILIO_ACCOUNT_SID', desc: 'Telephony — outbound calls, IVR, SMS' },
                { label: 'Deepgram', key: 'DEEPGRAM_API_KEY', desc: 'Speech-to-text — agent detection' },
                { label: 'OpenAI', key: 'OPENAI_API_KEY', desc: 'Text-to-speech — IVR voice prompts' },
                { label: 'Neon', key: 'DATABASE_URL', desc: 'Serverless PostgreSQL database' },
              ].map((item) => (
                <div key={item.key} className="flex items-center justify-between py-2.5 border-b border-gray-800 last:border-0">
                  <div>
                    <p className="font-medium text-white">{item.label}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{item.desc}</p>
                  </div>
                  <span className="text-xs px-2.5 py-1 rounded-full bg-green-900/40 text-green-400 border border-green-700/50">
                    Configured via .env
                  </span>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-600 mt-4">
              API keys are configured via environment variables in <code className="text-gray-500">.env.local</code> or your Vercel project settings.
            </p>
          </div>

          {/* Cost estimate */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
            <h2 className="text-sm font-semibold text-white mb-4">Cost Estimate Per Call</h2>
            <div className="space-y-2 text-sm">
              {[
                { item: 'Twilio (30 min hold)', cost: '~$0.42' },
                { item: 'Deepgram STT (30 min)', cost: '~$0.13' },
                { item: 'OpenAI TTS', cost: '~$0.001' },
                { item: 'Transfer call (5 min)', cost: '~$0.07' },
                { item: 'SMS notification', cost: '~$0.008' },
              ].map((row) => (
                <div key={row.item} className="flex justify-between text-gray-400">
                  <span>{row.item}</span>
                  <span className="font-mono text-white">{row.cost}</span>
                </div>
              ))}
              <div className="flex justify-between text-white font-semibold pt-2 border-t border-gray-800">
                <span>Total (30 min call)</span>
                <span className="text-green-400">~$0.63</span>
              </div>
              <p className="text-xs text-gray-600 mt-2">vs Bland.ai: ~$2.70 for same call (75% savings)</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
