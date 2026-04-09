'use client';

import { useState, useEffect, useRef } from 'react';

interface Lead {
  id: string;
  name: string;
  phone_number: string;
  category: string;
  directory_name: string;
  ivr_config_id: string | null;
}

interface IVRConfig {
  id: string;
  name: string;
  lead_name: string | null;
}

interface TransferNumber {
  id: string;
  name: string;
  phone: string;
  isDefault: boolean;
}

interface ActiveCall {
  callId: string;
  twilioSid: string;
  status: string;
  leadName: string;
  leadPhone: string;
  holdSeconds: number;
}

interface CallEvent {
  id: string;
  event_type: string;
  details: Record<string, unknown>;
  created_at: string;
}

const STATUS_LABELS: Record<string, string> = {
  initiating: 'Initiating call...',
  navigating_ivr: 'Navigating IVR menu...',
  on_hold: 'Waiting on hold...',
  agent_detected: 'Live agent detected!',
  transferring: 'Transferring to you...',
  connected: 'Connected',
  completed: 'Call completed',
  failed: 'Call failed',
  cancelled: 'Call cancelled',
};

const STATUS_COLORS: Record<string, string> = {
  initiating: 'text-yellow-400',
  navigating_ivr: 'text-blue-400',
  on_hold: 'text-orange-400',
  agent_detected: 'text-green-400',
  transferring: 'text-purple-400',
  connected: 'text-green-400',
  completed: 'text-gray-400',
  failed: 'text-red-400',
  cancelled: 'text-gray-400',
};

const STATUS_BG: Record<string, string> = {
  initiating: 'bg-yellow-900/30 border-yellow-700/50',
  navigating_ivr: 'bg-blue-900/30 border-blue-700/50',
  on_hold: 'bg-orange-900/30 border-orange-700/50',
  agent_detected: 'bg-green-900/30 border-green-700/50',
  transferring: 'bg-purple-900/30 border-purple-700/50',
  connected: 'bg-green-900/30 border-green-700/50',
  completed: 'bg-gray-800/50 border-gray-700',
  failed: 'bg-red-900/30 border-red-700/50',
  cancelled: 'bg-gray-800/50 border-gray-700',
};

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function AgentPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [ivrConfigs, setIvrConfigs] = useState<IVRConfig[]>([]);
  const [transferNumbers, setTransferNumbers] = useState<TransferNumber[]>([]);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [selectedIvrConfigId, setSelectedIvrConfigId] = useState<string>('');
  const [selectedTransferNumberId, setSelectedTransferNumberId] = useState<string>('');
  const [search, setSearch] = useState('');
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [callLoading, setCallLoading] = useState(false);
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [events, setEvents] = useState<CallEvent[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Load leads, IVR configs, and transfer numbers
  useEffect(() => {
    fetch('/api/leads')
      .then((r) => r.json())
      .then((d) => setLeads(d.leads ?? []));
    fetch('/api/ivr-configs')
      .then((r) => r.json())
      .then((d) => setIvrConfigs(d.configs ?? []));
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d) => {
        const nums: TransferNumber[] = d.user?.transfer_numbers ?? [];
        if (nums.length === 0 && d.user?.transfer_phone) {
          setTransferNumbers([{ id: 'default', name: 'Default', phone: d.user.transfer_phone, isDefault: true }]);
        } else {
          setTransferNumbers(nums);
        }
        const def = nums.find((n: TransferNumber) => n.isDefault) ?? nums[0];
        if (def) setSelectedTransferNumberId(def.id);
      });
  }, []);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      esRef.current?.close();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const stopStreaming = () => {
    esRef.current?.close();
    esRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const startSSE = (callId: string) => {
    if (esRef.current) esRef.current.close();
    const es = new EventSource(`/api/calls/events?callId=${callId}`);
    esRef.current = es;
    const TERMINAL = ['completed', 'failed', 'cancelled'];
    let done = false;

    const updateCall = (callData: Record<string, unknown> | null) => {
      if (!callData) return;
      setActiveCall((prev) =>
        prev ? { ...prev, status: callData.status as string, holdSeconds: (callData.hold_duration_seconds as number) ?? 0 } : prev
      );
      if (TERMINAL.includes(callData.status as string) && !done) {
        done = true;
        es.close();
        setTimeout(() => setActiveCall(null), 4000);
      }
    };

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === 'snapshot') {
        // Replace entire event list (deduplicates on reconnect)
        setEvents(msg.events ?? []);
        updateCall(msg.call);
      }

      if (msg.type === 'event') {
        // Deduplicate by event ID before appending
        setEvents((prev) => {
          if (prev.some((ev) => ev.id === msg.event.id)) return prev;
          return [...prev, msg.event];
        });
        updateCall(msg.call);
      }

      if (msg.type === 'status') {
        updateCall(msg.call);
      }

      setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    };

    es.onerror = () => {
      if (done) es.close(); // Don't reconnect after call ends
    };
  };

  function handleSelectLead(lead: Lead) {
    setSelectedLead(lead);
    // Auto-select the lead's IVR config if it has one
    setSelectedIvrConfigId(lead.ivr_config_id ?? '');
  }

  async function handlePlaceCall() {
    if (!selectedLead) return;
    setCallLoading(true);
    setError('');
    setElapsed(0);
    setEvents([]);

    const selectedTransferNumber = transferNumbers.find((n) => n.id === selectedTransferNumberId);
    const res = await fetch('/api/calls/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        leadId: selectedLead.id,
        ivrConfigId: selectedIvrConfigId || undefined,
        transferNumber: selectedTransferNumber?.phone,
      }),
    });

    let data: Record<string, string> = {};
    try { data = await res.json(); } catch { /* empty body on 500 */ }
    setCallLoading(false);

    if (!res.ok) {
      setError(data.error ?? `Server error (${res.status}) — check your internet connection`);
      return;
    }

    setActiveCall({
      callId: data.callId,
      twilioSid: data.twilioSid,
      status: data.status,
      leadName: selectedLead.name,
      leadPhone: selectedLead.phone_number,
      holdSeconds: 0,
    });

    // Start elapsed timer
    timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    startSSE(data.callId);
  }

  async function handleEndCall() {
    if (!activeCall) return;
    await fetch('/api/calls/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId: activeCall.callId }),
    });
    stopStreaming();
    setActiveCall((prev) => (prev ? { ...prev, status: 'cancelled' } : null));
    setTimeout(() => setActiveCall(null), 2000);
  }

  async function handleTransfer() {
    if (!activeCall) return;
    const res = await fetch('/api/calls/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId: activeCall.callId }),
    });
    const data = await res.json();
    if (res.ok) {
      setActiveCall((prev) => (prev ? { ...prev, status: 'connected' } : null));
    } else {
      setError(data.error);
    }
  }

  const filteredLeads = leads.filter(
    (l) =>
      l.name.toLowerCase().includes(search.toLowerCase()) ||
      l.phone_number.includes(search) ||
      l.category?.toLowerCase().includes(search.toLowerCase())
  );

  const isLiveStatus = activeCall && !['completed', 'failed', 'cancelled'].includes(activeCall.status);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-8 py-6 border-b border-gray-800">
        <h1 className="text-2xl font-bold text-white">Call Agent</h1>
        <p className="text-gray-400 text-sm mt-1">Select a cruise line and place an automated hold call</p>
      </div>

      <div className="flex-1 flex gap-6 p-8 overflow-hidden">
        {/* Left: Lead selector */}
        <div className="w-96 flex flex-col gap-4">
          <div className="bg-gray-900 rounded-2xl border border-gray-800 flex flex-col overflow-hidden">
            <div className="p-4 border-b border-gray-800">
              <input
                type="text"
                placeholder="Search cruise lines..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex-1 overflow-y-auto max-h-96">
              {filteredLeads.length === 0 ? (
                <div className="p-6 text-center text-gray-500 text-sm">
                  No cruise lines found. Add them in Leads.
                </div>
              ) : (
                filteredLeads.map((lead) => (
                  <button
                    key={lead.id}
                    onClick={() => handleSelectLead(lead)}
                    disabled={!!isLiveStatus}
                    className={`w-full text-left px-4 py-3.5 border-b border-gray-800 last:border-0 transition-colors ${
                      selectedLead?.id === lead.id
                        ? 'bg-blue-900/40 border-l-2 border-l-blue-500'
                        : 'hover:bg-gray-800/50'
                    } disabled:opacity-40 disabled:cursor-not-allowed`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-white">{lead.name}</p>
                        <p className="text-xs text-gray-500 mt-0.5">{lead.phone_number}</p>
                      </div>
                      {lead.category && (
                        <span className="text-xs px-2 py-1 rounded-full bg-gray-800 text-gray-400">
                          {lead.category}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-600 mt-1">{lead.directory_name}</p>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Selected lead info + config selectors */}
          {selectedLead && !isLiveStatus && (
            <div className="bg-gray-900 rounded-2xl border border-gray-800 p-4 space-y-3">
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Selected</p>
                <p className="text-white font-semibold">{selectedLead.name}</p>
                <p className="text-gray-400 text-sm">{selectedLead.phone_number}</p>
                {selectedLead.category && (
                  <p className="text-gray-500 text-xs mt-0.5">{selectedLead.category}</p>
                )}
              </div>

              {/* IVR Config selector */}
              {ivrConfigs.length > 0 && (
                <div>
                  <label className="text-xs text-gray-500 uppercase tracking-wider block mb-1">IVR Script</label>
                  <select
                    value={selectedIvrConfigId}
                    onChange={(e) => setSelectedIvrConfigId(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  >
                    <option value="">— No IVR (hold detection only) —</option>
                    {ivrConfigs.map((cfg) => (
                      <option key={cfg.id} value={cfg.id}>{cfg.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Transfer number selector */}
              {transferNumbers.length > 1 && (
                <div>
                  <label className="text-xs text-gray-500 uppercase tracking-wider block mb-1">Transfer To</label>
                  <select
                    value={selectedTransferNumberId}
                    onChange={(e) => setSelectedTransferNumberId(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                  >
                    {transferNumbers.map((n) => (
                      <option key={n.id} value={n.id}>{n.name} — {n.phone}</option>
                    ))}
                  </select>
                </div>
              )}

              {!selectedIvrConfigId && (
                <p className="text-yellow-500 text-xs">
                  No IVR script selected — will go straight to hold detection.
                </p>
              )}
            </div>
          )}

          {error && (
            <div className="bg-red-950 border border-red-800 rounded-xl p-4 text-red-300 text-sm">{error}</div>
          )}

          <button
            onClick={handlePlaceCall}
            disabled={!selectedLead || callLoading || !!isLiveStatus}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-4 rounded-2xl transition-colors text-lg flex items-center justify-center gap-3"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
            </svg>
            {callLoading ? 'Placing Call...' : 'Place Call'}
          </button>
        </div>

        {/* Right: Active call panel */}
        <div className="flex-1 flex gap-4 min-w-0">
          {activeCall ? (
            <div
              className={`rounded-2xl border p-8 h-full flex flex-col ${STATUS_BG[activeCall.status] ?? 'bg-gray-900 border-gray-800'}`}
            >
              {/* Status indicator */}
              <div className="flex items-start justify-between mb-8">
                <div>
                  <div className="flex items-center gap-3 mb-2">
                    {isLiveStatus && (
                      <div className="relative">
                        <div className="w-3 h-3 rounded-full bg-green-500 pulse-ring absolute" />
                        <div className="w-3 h-3 rounded-full bg-green-500" />
                      </div>
                    )}
                    <span className={`text-xl font-bold ${STATUS_COLORS[activeCall.status] ?? 'text-gray-400'}`}>
                      {STATUS_LABELS[activeCall.status] ?? activeCall.status}
                    </span>
                  </div>
                  <p className="text-gray-300 font-medium">{activeCall.leadName}</p>
                  <p className="text-gray-500 text-sm">{activeCall.leadPhone}</p>
                </div>

                <div className="text-right">
                  <p className="text-3xl font-mono font-bold text-white">{formatDuration(elapsed)}</p>
                  <p className="text-xs text-gray-500 mt-1">Total elapsed</p>
                </div>
              </div>

              {/* IVR Progress */}
              <div className="mb-8">
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-4">Call Progress</p>
                <div className="space-y-2">
                  {[
                    { key: 'initiating', label: 'Call Initiated' },
                    { key: 'navigating_ivr', label: 'IVR Navigation' },
                    { key: 'on_hold', label: 'Waiting on Hold' },
                    { key: 'agent_detected', label: 'Agent Detected' },
                    { key: 'connected', label: 'Customer Connected' },
                  ].map((step, i) => {
                    const statusOrder = ['initiating', 'navigating_ivr', 'on_hold', 'agent_detected', 'connected', 'completed'];
                    const currentIdx = statusOrder.indexOf(activeCall.status);
                    const stepIdx = statusOrder.indexOf(step.key);
                    const done = currentIdx > stepIdx;
                    const active = currentIdx === stepIdx;

                    return (
                      <div key={step.key} className="flex items-center gap-3">
                        <div
                          className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                            done
                              ? 'bg-green-600 text-white'
                              : active
                              ? 'bg-blue-600 text-white ring-4 ring-blue-600/30'
                              : 'bg-gray-800 text-gray-600'
                          }`}
                        >
                          {done ? (
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          ) : (
                            i + 1
                          )}
                        </div>
                        <span className={`text-sm ${active ? 'text-white font-semibold' : done ? 'text-gray-400' : 'text-gray-600'}`}>
                          {step.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Hold timer */}
              {['on_hold', 'agent_detected'].includes(activeCall.status) && (
                <div className="bg-black/20 rounded-xl p-4 mb-6">
                  <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Hold Duration</p>
                  <p className="text-2xl font-mono font-bold text-orange-400">{formatDuration(elapsed)}</p>
                </div>
              )}

              {/* Agent detected alert */}
              {activeCall.status === 'agent_detected' && (
                <div className="bg-green-900/50 border border-green-700 rounded-xl p-4 mb-6">
                  <p className="text-green-300 font-semibold">A live agent has answered!</p>
                  <p className="text-green-400/70 text-sm mt-1">
                    An SMS notification has been sent. Click Connect to bridge the call.
                  </p>
                </div>
              )}

              <div className="flex-1" />

              {/* Action buttons */}
              <div className="flex gap-3">
                {activeCall.status === 'agent_detected' && (
                  <button
                    onClick={handleTransfer}
                    className="flex-1 bg-green-600 hover:bg-green-700 text-white font-semibold py-3 rounded-xl transition-colors"
                  >
                    Connect Now
                  </button>
                )}
                {isLiveStatus && !['connected'].includes(activeCall.status) && (
                  <button
                    onClick={handleEndCall}
                    className="flex-1 bg-red-900/50 hover:bg-red-900 border border-red-700 text-red-300 font-semibold py-3 rounded-xl transition-colors"
                  >
                    End Call
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <div className="w-20 h-20 rounded-full bg-gray-900 border border-gray-800 flex items-center justify-center mx-auto mb-4">
                  <svg className="w-10 h-10 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                  </svg>
                </div>
                <p className="text-gray-500 font-medium">No active call</p>
                <p className="text-gray-600 text-sm mt-1">Select a cruise line and press Place Call</p>
              </div>
            </div>
          )}
        </div>

        {/* Live event log */}
        <div className="w-80 flex-shrink-0 bg-gray-900 border border-gray-800 rounded-2xl flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
            {activeCall && isLiveStatus && (
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            )}
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Live Logs</p>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-1.5 font-mono text-xs">
            {events.length === 0 ? (
              <p className="text-gray-600 text-center mt-8">No events yet</p>
            ) : (
              events.map((ev) => {
                const time = new Date(ev.created_at).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

                // Transcript — show as speech bubble
                if (ev.event_type === 'transcript') {
                  const text = (ev.details as Record<string, string>).text ?? '';
                  return (
                    <div key={ev.id} className="mb-2">
                      <div className="text-gray-600 text-xs mb-0.5">{time} · cruise line</div>
                      <div className="bg-gray-800 rounded-xl rounded-tl-none px-3 py-2 text-gray-200 text-xs leading-relaxed">
                        {text}
                      </div>
                    </div>
                  );
                }

                if (ev.event_type === 'twilio_status') return null;

                // IVR step events
                const stepMatch = ev.event_type.match(/^ivr_step_(\d+)$/);
                if (stepMatch) {
                  const d = ev.details as Record<string, Record<string, string>>;
                  const desc = d?.step?.description ?? `Step ${stepMatch[1]}`;
                  const type = d?.step?.type ?? '';
                  const typeIcon: Record<string, string> = { wait: '⏱', dtmf: '🔢', voice: '🗣', hold: '⏳' };
                  return (
                    <div key={ev.id} className="flex gap-2 items-start text-xs text-blue-400">
                      <span className="flex-shrink-0 text-gray-600">{time}</span>
                      <span>{typeIcon[type] ?? '▸'} {desc}</span>
                    </div>
                  );
                }

                // AI action events
                if (ev.event_type === 'ai_action') {
                  const d = ev.details as Record<string, string>;
                  const label = d.action === 'PRESS'
                    ? `Pressed ${d.digit}`
                    : d.action === 'SAY'
                    ? `Said: "${d.phrase}"`
                    : d.action ?? 'action';
                  return (
                    <div key={ev.id} className="flex gap-2 items-start text-xs text-purple-400">
                      <span className="flex-shrink-0 text-gray-600">{time}</span>
                      <span>▸ {label}</span>
                    </div>
                  );
                }

                const icons: Record<string, string> = {
                  call_initiated: '📞',
                  entered_hold: '⏳',
                  agent_detected: '🟢',
                  transfer_initiated: '🔀',
                  call_ended_by_user: '🔴',
                  voicemail_detected: '📬',
                  max_duration_exceeded: '⏰',
                };
                const colors: Record<string, string> = {
                  call_initiated: 'text-blue-400',
                  entered_hold: 'text-orange-400',
                  agent_detected: 'text-green-400',
                  transfer_initiated: 'text-cyan-400',
                  voicemail_detected: 'text-yellow-500',
                  max_duration_exceeded: 'text-red-400',
                };

                return (
                  <div key={ev.id} className={`flex gap-2 items-start text-xs ${colors[ev.event_type] ?? 'text-gray-500'}`}>
                    <span className="flex-shrink-0 text-gray-600">{time}</span>
                    <span>{icons[ev.event_type] ?? '▸'} {ev.event_type.replace(/_/g, ' ')}</span>
                  </div>
                );
              })
            )}
            <div ref={logsEndRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
