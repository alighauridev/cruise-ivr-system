'use client';

import { useState, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Icon } from '@/components/icons';
import { Badge, PageHeader, SectionCard, Segmented, Toggle } from '@/components/ui';

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
    ai_engine: 'claude',
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
          ai_engine: d.settings?.ai_engine === 'openai' ? 'openai' : 'claude',
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
        settings: { auto_callback_enabled: form.auto_callback_enabled ? 'true' : 'false', ai_engine: form.ai_engine },
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
          ai_engine: form.ai_engine,
        },
      }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Settings" subtitle="Your calling preferences, AI engine and connected services" />

      <div className="min-h-0 flex-1 overflow-y-auto px-10 pb-12 max-lg:px-6">
        <form onSubmit={handleSave} className="grid max-w-6xl items-start gap-5 xl:grid-cols-2">
          <div className="space-y-5">
          {/* Account info */}
          <SectionCard icon="user" tone="info" title="Account">
            <dl className="divide-y divide-line text-sm">
              <div className="flex items-center justify-between py-2.5 first:pt-0">
                <dt className="text-muted">Name</dt>
                <dd className="font-medium text-ink">{data?.user?.name ?? '—'}</dd>
              </div>
              <div className="flex items-center justify-between py-2.5 last:pb-0">
                <dt className="text-muted">Email</dt>
                <dd className="font-medium text-ink">{data?.user?.email ?? '—'}</dd>
              </div>
            </dl>
          </SectionCard>

            {/* Transfer Numbers */}
            <SectionCard
              icon="phone"
              tone="ok"
              title="Transfer numbers"
              description="Numbers we call when a live agent is detected. The default is used unless you pick another when placing a call."
            >
              <div className="space-y-2">
                {transferNumbers.length === 0 && (
                  <p className="rounded-xl bg-canvas py-5 text-center text-sm text-muted">No transfer numbers added yet.</p>
                )}
                {transferNumbers.map((n) => (
                  <div
                    key={n.id}
                    className={`flex items-center gap-3.5 rounded-xl border px-4 py-3 transition-colors ${
                      n.isDefault ? 'border-brand-line bg-brand-soft/60' : 'border-line bg-surface'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setDefault(n.id)}
                      title="Set as default"
                      aria-label={`Set ${n.name} as default`}
                      className={`flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                        n.isDefault ? 'border-brand bg-brand text-white' : 'border-line-strong hover:border-brand'
                      }`}
                    >
                      {n.isDefault && <Icon name="check" className="h-2.5 w-2.5" strokeWidth={4} />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink">{n.name}</p>
                      <p className="font-mono text-xs text-muted">{n.phone}</p>
                    </div>
                    {n.isDefault && <Badge tone="brand">Default</Badge>}
                    <button
                      type="button"
                      onClick={() => removeTransferNumber(n.id)}
                      className="btn-icon hover:!bg-bad-soft hover:!text-bad"
                      title="Remove"
                    >
                      <Icon name="x" className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex gap-2">
                <input
                  type="text"
                  placeholder="Label (e.g. Ali)"
                  value={newNumber.name}
                  onChange={(e) => setNewNumber((p) => ({ ...p, name: e.target.value }))}
                  className="input !w-36"
                />
                <input
                  type="tel"
                  placeholder="+15551234567"
                  value={newNumber.phone}
                  onChange={(e) => setNewNumber((p) => ({ ...p, phone: e.target.value }))}
                  className="input flex-1"
                />
                <button type="button" onClick={addTransferNumber} disabled={!newNumber.phone} className="btn btn-secondary flex-shrink-0">
                  <Icon name="plus" className="h-4 w-4" />
                  Add
                </button>
              </div>
            </SectionCard>

            {/* Connect Message */}
            <SectionCard
              icon="chat"
              tone="info"
              title="Connect message"
              description="Spoken to the cruise line agent once they're detected, while your customer is being connected."
            >
              <textarea
                rows={3}
                value={form.connect_message}
                onChange={(e) => setForm((f) => ({ ...f, connect_message: e.target.value }))}
                placeholder="e.g. Thank you for your patience. We are connecting you with our customer now. Please hold for just a moment."
                className="input"
              />
              <p className="mt-2 text-xs text-muted">Leave blank to use the default message.</p>
            </SectionCard>

          </div>
          <div className="space-y-5">
            {/* AI engine */}
            <SectionCard
              icon="spark"
              tone="ai"
              title="AI call engine"
              description="Which AI talks to the cruise line rep on AI task calls. Applies to the next call."
            >
              <Segmented
                value={form.ai_engine as 'claude' | 'openai'}
                onChange={(v) => setForm((f) => ({ ...f, ai_engine: v }))}
                options={[
                  { value: 'claude', label: 'Claude', hint: 'Deepgram → Claude → voice' },
                  { value: 'openai', label: 'OpenAI Realtime', hint: 'Previous setup, faster replies' },
                ]}
              />
            </SectionCard>

            {/* Notifications & Auto-callback */}
            <SectionCard icon="bell" tone="warn" title="Notifications" description="How we reach you when something happens on a call.">
              <div className="space-y-6">
                <div>
                  <label className="field-label">Notification preference</label>
                  <Segmented
                    value={form.notification_preference as 'sms' | 'push' | 'both'}
                    onChange={(v) => setForm((f) => ({ ...f, notification_preference: v }))}
                    options={[
                      { value: 'sms', label: 'SMS' },
                      { value: 'push', label: 'Push' },
                      { value: 'both', label: 'Both' },
                    ]}
                  />
                </div>

                <div>
                  <label className="field-label">SMS notification number</label>
                  <input
                    type="tel"
                    value={form.notification_phone}
                    onChange={(e) => setForm((f) => ({ ...f, notification_phone: e.target.value }))}
                    placeholder="+15551234567"
                    className="input"
                  />
                  <p className="mt-2 text-xs text-muted">Receives SMS alerts when an agent is detected, and AI call summaries.</p>
                </div>

                <div className="flex items-center justify-between gap-6 rounded-xl bg-canvas px-4 py-3.5">
                  <div>
                    <p className="text-sm font-semibold text-ink">Auto-connect when an agent is detected</p>
                    <p className="mt-0.5 text-xs text-muted">Automatically call your default transfer number and bridge to the live agent.</p>
                  </div>
                  <Toggle
                    checked={form.auto_callback_enabled}
                    onChange={() => setForm((f) => ({ ...f, auto_callback_enabled: !f.auto_callback_enabled }))}
                    label="Auto-connect when an agent is detected"
                  />
                </div>
              </div>
            </SectionCard>

            <div className="flex justify-end">
              <button type="submit" disabled={saving} className="btn btn-primary btn-lg min-w-44">
                {saved ? (
                  <>
                    <Icon name="check" className="h-4 w-4" strokeWidth={2.5} />
                    Saved
                  </>
                ) : saving ? 'Saving…' : 'Save settings'}
              </button>
            </div>
          {/* API keys info */}
          <SectionCard icon="key" tone="neutral" title="Connected services" description="Keys are read from the server environment.">
            <ul className="divide-y divide-line text-sm">
              {[
                { label: 'Twilio', desc: 'Telephony — outbound calls, IVR, SMS' },
                { label: 'Deepgram', desc: 'Speech-to-text — agent detection and Claude calls' },
                { label: 'Anthropic', desc: 'Claude — runs AI task calls' },
                { label: 'OpenAI', desc: 'Text-to-speech voice; Realtime engine' },
                { label: 'Neon', desc: 'Serverless PostgreSQL database' },
              ].map((item) => (
                <li key={item.label} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                  <div>
                    <p className="font-semibold text-ink">{item.label}</p>
                    <p className="mt-0.5 text-xs text-muted">{item.desc}</p>
                  </div>
                  <Badge tone="ok" dot>Via .env</Badge>
                </li>
              ))}
            </ul>
          </SectionCard>
          </div>
        </form>
      </div>
    </div>
  );
}
