'use client';

import { useState, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';

interface TransferNumber {
  id: string;
  name: string;
  phone: string;
  isDefault: boolean;
}

interface SettingsData {
  user: {
    name: string;
    email: string;
    transfer_phone: string;
    notification_preference: string;
    notification_phone: string;
    transfer_numbers: TransferNumber[];
    connect_message: string | null;
  };
  settings: Record<string, string>;
}

export default function SettingsPage() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [form, setForm] = useState({
    notification_preference: 'sms',
    notification_phone: '',
    auto_callback_enabled: false,
    connect_message: '',
  });
  const [transferNumbers, setTransferNumbers] = useState<TransferNumber[]>([]);
  const [newNumber, setNewNumber] = useState({ name: '', phone: '' });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d: SettingsData) => {
        setData(d);
        setForm({
          notification_preference: d.user?.notification_preference ?? 'sms',
          notification_phone: d.user?.notification_phone ?? '',
          auto_callback_enabled: d.settings?.auto_callback_enabled === 'true',
          connect_message: d.user?.connect_message ?? '',
        });
        // Load transfer_numbers; fall back to legacy transfer_phone
        const nums: TransferNumber[] = d.user?.transfer_numbers ?? [];
        if (nums.length === 0 && d.user?.transfer_phone) {
          setTransferNumbers([{ id: uuidv4(), name: 'Default', phone: d.user.transfer_phone, isDefault: true }]);
        } else {
          setTransferNumbers(nums);
        }
      });
  }, []);

  async function addTransferNumber() {
    if (!newNumber.phone) return;
    const isFirst = transferNumbers.length === 0;
    const updated = [
      ...transferNumbers,
      { id: uuidv4(), name: newNumber.name || 'Transfer ' + (transferNumbers.length + 1), phone: newNumber.phone, isDefault: isFirst },
    ];
    setTransferNumbers(updated);
    setNewNumber({ name: '', phone: '' });
    await saveTransferNumbers(updated);
  }

  async function removeTransferNumber(id: string) {
    const filtered = transferNumbers.filter((n) => n.id !== id);
    if (filtered.length > 0 && !filtered.some((n) => n.isDefault)) {
      filtered[0].isDefault = true;
    }
    setTransferNumbers(filtered);
    await saveTransferNumbers(filtered);
  }

  async function setDefault(id: string) {
    const updated = transferNumbers.map((n) => ({ ...n, isDefault: n.id === id }));
    setTransferNumbers(updated);
    await saveTransferNumbers(updated);
  }

  async function saveTransferNumbers(nums: TransferNumber[]) {
    const defaultNumber = nums.find((n) => n.isDefault);
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transfer_phone: defaultNumber?.phone ?? null,
        notification_preference: form.notification_preference,
        notification_phone: form.notification_phone,
        transfer_numbers: nums,
        connect_message: form.connect_message || null,
        settings: { auto_callback_enabled: form.auto_callback_enabled ? 'true' : 'false' },
      }),
    });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const defaultNumber = transferNumbers.find((n) => n.isDefault);
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transfer_phone: defaultNumber?.phone ?? null,
        notification_preference: form.notification_preference,
        notification_phone: form.notification_phone,
        transfer_numbers: transferNumbers,
        connect_message: form.connect_message || null,
        settings: {
          auto_callback_enabled: form.auto_callback_enabled ? 'true' : 'false',
        },
      }),
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

          <form onSubmit={handleSave} className="space-y-6">

            {/* Transfer Numbers */}
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-4">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                </svg>
                Transfer Numbers
              </h2>
              <p className="text-xs text-gray-500">Phone numbers to call when a live agent is detected. Select one as the default.</p>

              {/* Existing numbers */}
              <div className="space-y-2">
                {transferNumbers.length === 0 && (
                  <p className="text-sm text-gray-600 text-center py-3">No transfer numbers added yet.</p>
                )}
                {transferNumbers.map((n) => (
                  <div key={n.id} className={`flex items-center gap-3 px-4 py-3 rounded-xl border transition-colors ${n.isDefault ? 'border-blue-600 bg-blue-900/20' : 'border-gray-700 bg-gray-800/50'}`}>
                    <button
                      type="button"
                      onClick={() => setDefault(n.id)}
                      title="Set as default"
                      className={`w-4 h-4 rounded-full border-2 flex-shrink-0 transition-colors ${n.isDefault ? 'border-blue-500 bg-blue-500' : 'border-gray-600 hover:border-blue-400'}`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white truncate">{n.name}</p>
                      <p className="text-xs text-gray-400 font-mono">{n.phone}</p>
                    </div>
                    {n.isDefault && (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-600 text-white font-medium flex-shrink-0">Default</span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeTransferNumber(n.id)}
                      className="text-gray-600 hover:text-red-400 transition-colors flex-shrink-0"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>

              {/* Add new number */}
              <div className="flex gap-2 pt-1">
                <input
                  type="text"
                  placeholder="Label (e.g. Ali)"
                  value={newNumber.name}
                  onChange={(e) => setNewNumber((p) => ({ ...p, name: e.target.value }))}
                  className="w-28 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
                <input
                  type="tel"
                  placeholder="+15551234567"
                  value={newNumber.phone}
                  onChange={(e) => setNewNumber((p) => ({ ...p, phone: e.target.value }))}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
                <button
                  type="button"
                  onClick={addTransferNumber}
                  disabled={!newNumber.phone}
                  className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white px-4 py-2 rounded-xl text-sm font-semibold transition-colors flex-shrink-0"
                >
                  Add
                </button>
              </div>
            </div>

            {/* Connect Message */}
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-4">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                </svg>
                Connect Message
              </h2>
              <p className="text-xs text-gray-500">Message spoken to the cruise line agent when they are detected, while your customer is being connected.</p>
              <textarea
                rows={3}
                value={form.connect_message}
                onChange={(e) => setForm((f) => ({ ...f, connect_message: e.target.value }))}
                placeholder="e.g. Thank you for your patience. We are connecting you with our customer now. Please hold for just a moment."
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-none"
              />
              <p className="text-xs text-gray-600">Leave blank to use the default message.</p>
            </div>

            {/* Notifications & Auto-callback */}
            <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-5">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                Notifications
              </h2>

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
                <p className="text-xs text-gray-600 mt-1.5">Receives SMS alerts when an agent is detected.</p>
              </div>

              <div className="flex items-center justify-between py-3 border-t border-gray-800">
                <div>
                  <p className="text-sm text-gray-300 font-medium">Auto-connect when agent detected</p>
                  <p className="text-xs text-gray-600 mt-0.5">Automatically call your default transfer number and bridge to the live agent.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, auto_callback_enabled: !f.auto_callback_enabled }))}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    form.auto_callback_enabled ? 'bg-blue-600' : 'bg-gray-700'
                  }`}
                >
                  <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${form.auto_callback_enabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
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
          </div>
        </div>
      </div>
    </div>
  );
}
