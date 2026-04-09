'use client';

import { useState, useEffect } from 'react';
import type { IVRStep, IVRStepType } from '@/lib/ivr-engine';
import { useUserView } from '@/lib/user-view-context';

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

const STEP_TYPES: { type: IVRStepType; label: string; color: string; icon: string }[] = [
  { type: 'wait', label: 'Wait', color: 'bg-yellow-900/40 border-yellow-700/50 text-yellow-400', icon: '⏱' },
  { type: 'dtmf', label: 'Press Key', color: 'bg-blue-900/40 border-blue-700/50 text-blue-400', icon: '🔢' },
  { type: 'voice', label: 'Speak', color: 'bg-purple-900/40 border-purple-700/50 text-purple-400', icon: '🗣' },
  { type: 'hold', label: 'Hold & Detect', color: 'bg-green-900/40 border-green-700/50 text-green-400', icon: '📞' },
];

const DEFAULT_CRUISE_IVR_STEPS: IVRStep[] = [
  { order: 1, type: 'wait', duration_seconds: 5, description: 'Wait for IVR greeting' },
  { order: 2, type: 'dtmf', digit: '1', description: 'Press 1 for Reservations' },
  { order: 3, type: 'wait', duration_seconds: 3, description: 'Wait for submenu' },
  { order: 4, type: 'voice', phrase: 'speak to an agent', description: 'Say speak to an agent' },
  { order: 5, type: 'hold', description: 'Wait on hold for live agent' },
];

export default function IVRBuilderPage() {
  const { viewAsId, viewAsUser } = useUserView();
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
    const params = viewAsId ? `?viewAs=${viewAsId}` : '';
    const r = await fetch(`/api/ivr-configs${params}`);
    const d = await r.json();
    setConfigs(d.configs ?? []);
    setSelectedConfig(null);
    setShowNew(false);
    setSteps([]);
  };

  const loadLeads = async () => {
    const params = viewAsId ? `?viewAs=${viewAsId}` : '';
    const r = await fetch(`/api/leads${params}`);
    const d = await r.json();
    setLeads(d.leads ?? []);
  };

  useEffect(() => { loadConfigs(); loadLeads(); }, [viewAsId]);

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
    <div className="h-full flex flex-col">
      {viewAsUser && (
        <div className="px-8 py-2.5 bg-purple-900/20 border-b border-purple-800/40 flex items-center gap-2">
          <div className="w-5 h-5 rounded-full bg-purple-700 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
            {viewAsUser.name.charAt(0).toUpperCase()}
          </div>
          <p className="text-sm text-purple-300">Viewing as <span className="font-semibold">{viewAsUser.name}</span> — read-only</p>
        </div>
      )}
      <div className="px-8 py-6 border-b border-gray-800 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">IVR Builder</h1>
          <p className="text-gray-400 text-sm mt-1">Configure IVR navigation flows per cruise line</p>
        </div>
        {!viewAsUser && (
        <button
          onClick={startNew}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Config
        </button>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Config list */}
        <div className="w-72 border-r border-gray-800 overflow-y-auto bg-gray-900/40 p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">Saved Configs</p>
          {configs.length === 0 ? (
            <p className="text-gray-600 text-sm text-center mt-4">No configs yet</p>
          ) : (
            configs.map((cfg) => (
              <button
                key={cfg.id}
                onClick={() => selectConfig(cfg)}
                className={`w-full text-left px-4 py-3 rounded-xl mb-2 border transition-colors ${
                  selectedConfig?.id === cfg.id
                    ? 'bg-blue-600/20 border-blue-600/50 text-white'
                    : 'bg-gray-900 border-gray-800 text-gray-400 hover:text-white hover:border-gray-700'
                }`}
              >
                <p className="text-sm font-medium truncate">{cfg.name}</p>
                {cfg.lead_name && <p className="text-xs opacity-60 mt-0.5 truncate">{cfg.lead_name}</p>}
                <p className="text-xs opacity-40 mt-1">{cfg.steps?.length ?? 0} steps</p>
              </button>
            ))
          )}
        </div>

        {/* Editor */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {isEditing ? (
            <>
              {/* Config meta */}
              <div className="px-6 py-4 border-b border-gray-800 flex items-center gap-4">
                <div className="flex-1">
                  <input
                    type="text"
                    placeholder="Config name (e.g. Royal Caribbean - Reservations)"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                </div>
                {showNew && (
                  <select
                    value={leadId}
                    onChange={(e) => setLeadId(e.target.value)}
                    className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500"
                  >
                    <option value="">Link to lead (optional)</option>
                    {leads.map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </select>
                )}
                {!viewAsUser && (
                <div className="flex items-center gap-2">
                  {selectedConfig && (
                    <button
                      onClick={() => deleteConfig(selectedConfig.id)}
                      className="text-red-500 hover:text-red-400 border border-red-900/50 px-3 py-2.5 rounded-xl text-sm transition-colors"
                    >
                      Delete
                    </button>
                  )}
                  <button
                    onClick={saveConfig}
                    disabled={saving || !name}
                    className="bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors flex items-center gap-2"
                  >
                    {saved ? (
                      <>
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        Saved
                      </>
                    ) : saving ? 'Saving...' : 'Save Config'}
                  </button>
                </div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-6">
                <div className="flex gap-6">
                  {/* Steps */}
                  <div className="flex-1">
                    <p className="text-xs text-gray-500 uppercase tracking-wider mb-4">IVR Steps (in order)</p>
                    {steps.length === 0 ? (
                      <div className="text-center py-12 border-2 border-dashed border-gray-800 rounded-2xl">
                        <p className="text-gray-600">No steps yet. Add steps from the right panel.</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {steps.map((step, idx) => {
                          const typeInfo = STEP_TYPES.find((t) => t.type === step.type);
                          return (
                            <div key={idx} className={`rounded-xl border p-4 ${typeInfo?.color ?? 'bg-gray-900 border-gray-700 text-gray-400'}`}>
                              <div className="flex items-start gap-3">
                                <div className="flex flex-col gap-1 mt-1">
                                  <button onClick={() => moveStep(idx, -1)} disabled={idx === 0} className="opacity-40 hover:opacity-100 disabled:opacity-20">
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                                    </svg>
                                  </button>
                                  <button onClick={() => moveStep(idx, 1)} disabled={idx === steps.length - 1} className="opacity-40 hover:opacity-100 disabled:opacity-20">
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                                    </svg>
                                  </button>
                                </div>

                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-2">
                                    <span className="text-base">{typeInfo?.icon}</span>
                                    <span className="text-xs font-bold uppercase tracking-wider opacity-70">{typeInfo?.label}</span>
                                    <span className="text-xs opacity-40 ml-auto">Step {idx + 1}</span>
                                  </div>

                                  {/* Step-specific inputs */}
                                  {step.type === 'wait' && (
                                    <div className="flex items-center gap-2">
                                      <label className="text-xs opacity-70">Wait</label>
                                      <input
                                        type="number"
                                        min={1}
                                        value={step.duration_seconds ?? 3}
                                        onChange={(e) => updateStep(idx, { duration_seconds: parseInt(e.target.value) })}
                                        className="w-16 bg-black/20 border border-current/20 rounded-lg px-2 py-1 text-sm focus:outline-none"
                                      />
                                      <label className="text-xs opacity-70">seconds</label>
                                    </div>
                                  )}
                                  {step.type === 'dtmf' && (
                                    <div className="flex items-center gap-2">
                                      <label className="text-xs opacity-70">Press digit</label>
                                      <input
                                        type="text"
                                        maxLength={1}
                                        value={step.digit ?? ''}
                                        onChange={(e) => updateStep(idx, { digit: e.target.value })}
                                        className="w-12 bg-black/20 border border-current/20 rounded-lg px-2 py-1 text-sm text-center focus:outline-none"
                                      />
                                    </div>
                                  )}
                                  {step.type === 'voice' && (
                                    <input
                                      type="text"
                                      placeholder="Phrase to speak..."
                                      value={step.phrase ?? ''}
                                      onChange={(e) => updateStep(idx, { phrase: e.target.value })}
                                      className="w-full bg-black/20 border border-current/20 rounded-lg px-3 py-1.5 text-sm focus:outline-none placeholder-current/30"
                                    />
                                  )}
                                  {step.type === 'hold' && (
                                    <p className="text-xs opacity-60">System will stream audio and detect live agent voice</p>
                                  )}

                                  <input
                                    type="text"
                                    placeholder="Description..."
                                    value={step.description}
                                    onChange={(e) => updateStep(idx, { description: e.target.value })}
                                    className="mt-2 w-full bg-black/10 border-0 border-b border-current/20 px-0 py-1 text-xs opacity-60 focus:outline-none focus:opacity-100 placeholder-current/30"
                                  />
                                </div>

                                <button onClick={() => removeStep(idx)} className="opacity-40 hover:opacity-100 flex-shrink-0 mt-1">
                                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Add step panel */}
                  <div className="w-52 flex-shrink-0">
                    <p className="text-xs text-gray-500 uppercase tracking-wider mb-4">Add Step</p>
                    <div className="space-y-2">
                      {STEP_TYPES.map((t) => (
                        <button
                          key={t.type}
                          onClick={() => addStep(t.type)}
                          className={`w-full text-left px-4 py-3 rounded-xl border text-sm font-medium transition-opacity hover:opacity-80 ${t.color}`}
                        >
                          <span className="mr-2">{t.icon}</span> {t.label}
                        </button>
                      ))}
                    </div>

                    <div className="mt-6 bg-gray-900 border border-gray-800 rounded-xl p-3">
                      <p className="text-xs text-gray-500 mb-2">Typical IVR order:</p>
                      <ol className="text-xs text-gray-600 space-y-1 list-decimal list-inside">
                        <li>Wait (greeting)</li>
                        <li>Press Key (menu)</li>
                        <li>Wait (submenu)</li>
                        <li>Press Key / Speak</li>
                        <li>Hold & Detect</li>
                      </ol>
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <div className="w-20 h-20 rounded-full bg-gray-900 border border-gray-800 flex items-center justify-center mx-auto mb-4">
                  <svg className="w-10 h-10 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
                  </svg>
                </div>
                <p className="text-gray-500 font-medium">No config selected</p>
                <p className="text-gray-600 text-sm mt-1">Select an existing config or create a new one</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
