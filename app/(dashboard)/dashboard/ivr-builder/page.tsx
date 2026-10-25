'use client';

import { useState, useEffect } from 'react';
import type { IVRStep, IVRStepType } from '@/lib/ivr-engine';
import { Icon, type IconName } from '@/components/icons';
import { EmptyState, PageHeader, type Tone } from '@/components/ui';

interface IVRConfig {
  id: string;
  name: string;
  lead_name: string | null;
  steps: IVRStep[];
  created_at: string;
}

interface Lead {
  id: string;
  name: string;
}

const STEP_TYPES: { type: IVRStepType; label: string; hint: string; tone: Tone; icon: IconName }[] = [
  { type: 'wait', label: 'Wait', hint: 'Pause for a few seconds', tone: 'warn', icon: 'clock' },
  { type: 'dtmf', label: 'Press key', hint: 'Send a keypad digit', tone: 'info', icon: 'dialpad' },
  { type: 'voice', label: 'Speak', hint: 'Say a phrase to the menu', tone: 'ai', icon: 'mic' },
  { type: 'hold', label: 'Hold & detect', hint: 'Wait for a live agent', tone: 'ok', icon: 'phone' },
];

const CHIP: Record<Tone, string> = {
  neutral: 'bg-sunken text-body',
  brand: 'bg-brand-soft text-brand-strong',
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  info: 'bg-info-soft text-info',
  ai: 'bg-ai-soft text-ai',
};

const DEFAULT_CRUISE_IVR_STEPS: IVRStep[] = [
  { order: 1, type: 'wait', duration_seconds: 5, description: 'Wait for IVR greeting' },
  { order: 2, type: 'dtmf', digit: '1', description: 'Press 1 for Reservations' },
  { order: 3, type: 'wait', duration_seconds: 3, description: 'Wait for submenu' },
  { order: 4, type: 'voice', phrase: 'speak to an agent', description: 'Say speak to an agent' },
  { order: 5, type: 'hold', description: 'Wait on hold for live agent' },
];

export default function IVRBuilderPage() {
  const [configs, setConfigs] = useState<IVRConfig[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [selectedConfig, setSelectedConfig] = useState<IVRConfig | null>(null);
  const [steps, setSteps] = useState<IVRStep[]>([]);
  const [name, setName] = useState('');
  const [leadId, setLeadId] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const loadConfigs = async () => {
    const r = await fetch('/api/ivr-configs');
    const d = await r.json();
    setConfigs(d.configs ?? []);
  };

  const loadLeads = async () => {
    const r = await fetch('/api/leads');
    const d = await r.json();
    setLeads(d.leads ?? []);
  };

  useEffect(() => { loadConfigs(); loadLeads(); }, []);

  function selectConfig(cfg: IVRConfig) {
    setSelectedConfig(cfg);
    setSteps(cfg.steps ?? []);
    setName(cfg.name);
    setLeadId('');
    setShowNew(false);
  }

  function startNew() {
    setSelectedConfig(null);
    setSteps([...DEFAULT_CRUISE_IVR_STEPS]);
    setName('');
    setLeadId('');
    setShowNew(true);
  }

  async function saveConfig() {
    setSaving(true);
    const normalizedSteps = steps.map((s, i) => ({ ...s, order: i + 1 }));

    if (selectedConfig) {
      await fetch('/api/ivr-configs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selectedConfig.id, name, steps: normalizedSteps }),
      });
    } else {
      const r = await fetch('/api/ivr-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, leadId: leadId || null, steps: normalizedSteps }),
      });
      const d = await r.json();
      setSelectedConfig(d.config);
      setShowNew(false);
    }

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    await loadConfigs();
  }

  async function deleteConfig(id: string) {
    if (!confirm('Delete this IVR config?')) return;
    await fetch('/api/ivr-configs', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    setSelectedConfig(null);
    setShowNew(false);
    setSteps([]);
    await loadConfigs();
  }

  function addStep(type: IVRStepType) {
    const newStep: IVRStep = {
      order: steps.length + 1,
      type,
      description: STEP_TYPES.find((t) => t.type === type)?.label ?? type,
      ...(type === 'wait' ? { duration_seconds: 3 } : {}),
      ...(type === 'dtmf' ? { digit: '1' } : {}),
      ...(type === 'voice' ? { phrase: 'speak to an agent' } : {}),
    };
    setSteps((s) => [...s, newStep]);
  }

  function removeStep(idx: number) {
    setSteps((s) => s.filter((_, i) => i !== idx));
  }

  function moveStep(idx: number, dir: -1 | 1) {
    setSteps((s) => {
      const arr = [...s];
      const target = idx + dir;
      if (target < 0 || target >= arr.length) return arr;
      [arr[idx], arr[target]] = [arr[target], arr[idx]];
      return arr;
    });
  }

  function updateStep(idx: number, patch: Partial<IVRStep>) {
    setSteps((s) => s.map((step, i) => (i === idx ? { ...step, ...patch } : step)));
  }

  const isEditing = selectedConfig || showNew;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="IVR Builder"
        subtitle="Teach the system how to get through each cruise line's phone menu"
        actions={
          <button onClick={startNew} className="btn btn-primary">
            <Icon name="plus" className="h-4 w-4" />
            New config
          </button>
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)] gap-5 px-10 pb-8 max-lg:grid-cols-1 max-lg:px-6">
        {/* Config list */}
        <aside className="card min-h-0 self-start overflow-y-auto p-3 max-h-full max-lg:max-h-60">
          <p className="eyebrow mb-2 px-2.5 pt-1.5">Saved configs</p>
          {configs.length === 0 ? (
            <p className="px-2.5 py-6 text-center text-sm text-muted">No configs yet</p>
          ) : (
            configs.map((cfg) => {
              const selected = selectedConfig?.id === cfg.id;
              return (
                <button
                  key={cfg.id}
                  onClick={() => selectConfig(cfg)}
                  className={`mb-0.5 w-full rounded-xl px-3 py-2.5 text-left transition-colors ${
                    selected ? 'bg-brand-soft ring-1 ring-brand-line' : 'hover:bg-sunken'
                  }`}
                >
                  <p className={`truncate text-sm font-semibold ${selected ? 'text-brand-strong' : 'text-ink'}`}>{cfg.name}</p>
                  {cfg.lead_name && <p className="mt-0.5 truncate text-xs text-muted">{cfg.lead_name}</p>}
                  <p className="mt-1 text-xs text-faint">{cfg.steps?.length ?? 0} steps</p>
                </button>
              );
            })
          )}
        </aside>

        {/* Editor */}
        <section className="card flex min-h-0 flex-col overflow-hidden">
          {isEditing ? (
            <>
              {/* Config meta */}
              <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
                <input
                  type="text"
                  placeholder="Config name (e.g. Royal Caribbean - Reservations)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="input min-w-64 flex-1"
                />
                {showNew && (
                  <select value={leadId} onChange={(e) => setLeadId(e.target.value)} className="input !w-56">
                    <option value="">Link to lead (optional)</option>
                    {leads.map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </select>
                )}
                <div className="flex items-center gap-2">
                  {selectedConfig && (
                    <button onClick={() => deleteConfig(selectedConfig.id)} className="btn btn-danger">
                      <Icon name="trash" className="h-4 w-4" />
                      Delete
                    </button>
                  )}
                  <button onClick={saveConfig} disabled={saving || !name} className="btn btn-primary min-w-32">
                    {saved ? (
                      <>
                        <Icon name="check" className="h-4 w-4" strokeWidth={2.5} />
                        Saved
                      </>
                    ) : saving ? 'Saving…' : 'Save config'}
                  </button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-6">
                <div className="flex gap-8 max-xl:flex-col">
                  {/* Steps */}
                  <div className="min-w-0 flex-1">
                    <p className="eyebrow mb-4">Steps, in order</p>
                    {steps.length === 0 ? (
                      <div className="rounded-2xl border-2 border-dashed border-line-strong py-14 text-center">
                        <p className="text-sm text-muted">No steps yet. Add one from the panel on the right.</p>
                      </div>
                    ) : (
                      <ol className="relative space-y-3">
                        {/* the call path */}
                        <span aria-hidden className="absolute bottom-6 left-[13px] top-6 w-px bg-line-strong" />
                        {steps.map((step, idx) => {
                          const typeInfo = STEP_TYPES.find((t) => t.type === step.type);
                          const tone = typeInfo?.tone ?? 'neutral';
                          return (
                            <li key={idx} className="relative flex items-start gap-3">
                              <span className={`relative z-10 mt-3.5 flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-full ring-4 ring-surface ${CHIP[tone]}`}>
                                <Icon name={typeInfo?.icon ?? 'flow'} className="h-3.5 w-3.5" strokeWidth={2} />
                              </span>
                              <div className="min-w-0 flex-1 rounded-2xl border border-line bg-canvas/60 p-4">
                                <div className="flex items-start gap-3">
                                  <div className="min-w-0 flex-1">
                                    <div className="mb-2.5 flex items-center gap-2">
                                      <span className="text-sm font-semibold text-ink">{typeInfo?.label}</span>
                                      <span className="text-xs text-faint">Step {idx + 1}</span>
                                    </div>

                                    {/* Step-specific inputs */}
                                    {step.type === 'wait' && (
                                      <div className="flex items-center gap-2 text-sm text-body">
                                        Wait
                                        <input
                                          type="number"
                                          min={1}
                                          value={step.duration_seconds ?? 3}
                                          onChange={(e) => updateStep(idx, { duration_seconds: parseInt(e.target.value) })}
                                          className="input input-sm !w-20 text-center"
                                        />
                                        seconds
                                      </div>
                                    )}
                                    {step.type === 'dtmf' && (
                                      <div className="flex items-center gap-2 text-sm text-body">
                                        Press digit
                                        <input
                                          type="text"
                                          maxLength={1}
                                          value={step.digit ?? ''}
                                          onChange={(e) => updateStep(idx, { digit: e.target.value })}
                                          className="input input-sm !w-14 text-center font-mono"
                                        />
                                      </div>
                                    )}
                                    {step.type === 'voice' && (
                                      <input
                                        type="text"
                                        placeholder="Phrase to speak…"
                                        value={step.phrase ?? ''}
                                        onChange={(e) => updateStep(idx, { phrase: e.target.value })}
                                        className="input input-sm"
                                      />
                                    )}
                                    {step.type === 'hold' && (
                                      <p className="text-sm text-muted">The system streams the audio and listens for a live agent&apos;s voice.</p>
                                    )}

                                    <input
                                      type="text"
                                      placeholder="Description…"
                                      value={step.description}
                                      onChange={(e) => updateStep(idx, { description: e.target.value })}
                                      className="mt-3 w-full border-0 border-b border-dashed border-line-strong bg-transparent px-0 py-1 text-xs text-muted placeholder:text-faint focus:border-brand focus:text-ink focus:outline-none"
                                    />
                                  </div>

                                  <div className="flex flex-shrink-0 items-center gap-0.5">
                                    <button onClick={() => moveStep(idx, -1)} disabled={idx === 0} className="btn-icon disabled:opacity-25" title="Move up">
                                      <Icon name="chevronUp" className="h-4 w-4" />
                                    </button>
                                    <button onClick={() => moveStep(idx, 1)} disabled={idx === steps.length - 1} className="btn-icon disabled:opacity-25" title="Move down">
                                      <Icon name="chevronDown" className="h-4 w-4" />
                                    </button>
                                    <button onClick={() => removeStep(idx)} className="btn-icon hover:!bg-bad-soft hover:!text-bad" title="Remove step">
                                      <Icon name="x" className="h-4 w-4" />
                                    </button>
                                  </div>
                                </div>
                              </div>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>

                  {/* Add step panel */}
                  <div className="w-60 flex-shrink-0 max-xl:w-full">
                    <p className="eyebrow mb-4">Add a step</p>
                    <div className="space-y-2 max-xl:grid max-xl:grid-cols-2 max-xl:gap-2 max-xl:space-y-0">
                      {STEP_TYPES.map((t) => (
                        <button
                          key={t.type}
                          onClick={() => addStep(t.type)}
                          className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left transition hover:border-brand-line hover:bg-brand-soft/40"
                        >
                          <span className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg ${CHIP[t.tone]}`}>
                            <Icon name={t.icon} className="h-[18px] w-[18px]" />
                          </span>
                          <span>
                            <span className="block text-sm font-semibold text-ink">{t.label}</span>
                            <span className="block text-xs text-muted">{t.hint}</span>
                          </span>
                        </button>
                      ))}
                    </div>

                    <div className="mt-5 rounded-xl bg-canvas p-4">
                      <p className="mb-2 text-xs font-semibold text-body">A typical menu</p>
                      <ol className="list-inside list-decimal space-y-1 text-xs text-muted">
                        <li>Wait for the greeting</li>
                        <li>Press a key</li>
                        <li>Wait for the submenu</li>
                        <li>Press a key or speak</li>
                        <li>Hold & detect</li>
                      </ol>
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <EmptyState icon="flow" title="No config selected" hint="Select an existing config, or create a new one to get started." />
          )}
        </section>
      </div>
    </div>
  );
}
