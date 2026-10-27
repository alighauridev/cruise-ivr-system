'use client';

import { useState, useEffect, useRef } from 'react';
import { Icon } from '@/components/icons';
import { Badge, EmptyState, LiveDot, PageHeader, STATUS_TONE, StatusBadge, type Tone } from '@/components/ui';

interface Lead {
  id: string;
  name: string;
  phone_number: string;
  category: string;
  directory_name: string;
  ivr_config_id: string | null;
  agency_id?: string;
  owner_name?: string;
  user_id?: string;
}

interface IVRConfig {
  id: string;
  name: string;
  lead_name: string | null;
  owner_name?: string;
  owner_user_id?: string;
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
  ai_conversation: 'AI handling conversation...',
  transferring: 'Transferring to you...',
  connected: 'Connected',
  completed: 'Call completed',
  failed: 'Call failed',
  cancelled: 'Call cancelled',
};

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

interface AiTaskForm {
  requestType: string;
  request: string;
  bookingNumber: string;
  guestName: string;
  guestDob: string;
  shipAndSailDate: string;
  agencyId: string;
  agentName: string;
  mayAgreeTo: string;
}

const EMPTY_AI_FORM: AiTaskForm = {
  requestType: 'other', request: '', bookingNumber: '', guestName: '', guestDob: '',
  shipAndSailDate: '', agencyId: '', agentName: '', mayAgreeTo: '',
};

// Start with low-risk requests that need no payment.
const AI_REQUEST_TYPES = [
  { value: 'other', label: 'Other' },
  { value: 'waitlist', label: 'Waitlist (tour, cabin, dining)' },
  { value: 'status_check', label: 'Check status of a booking/request' },
  { value: 'resend_confirmation', label: 'Resend confirmation/documents' },
  { value: 'addon_no_payment', label: 'Add-on that needs no payment' },
  { value: 'question', label: 'Question about a booking/policy' },
];


const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-body', brand: 'text-brand-strong', ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', info: 'text-info', ai: 'text-ai',
};
const TONE_BAND: Record<Tone, string> = {
  neutral: 'bg-sunken/70', brand: 'bg-brand-soft', ok: 'bg-ok-soft', warn: 'bg-warn-soft', bad: 'bg-bad-soft', info: 'bg-info-soft', ai: 'bg-ai-soft',
};
const DOT_BG: Record<Tone, string> = {
  neutral: 'bg-faint', brand: 'bg-brand', ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-info', ai: 'bg-ai',
};
const EVENT_LABEL: Record<string, string> = {
  call_initiated: 'Call placed',
  entered_hold: 'Entered hold',
  agent_detected: 'Live agent detected',
  transfer_initiated: 'Transfer started',
  call_ended_by_user: 'Call ended by you',
  voicemail_detected: 'Voicemail detected',
  max_duration_exceeded: 'Max call length reached',
  conversation_ai_say: 'AI spoke',
  conversation_transcript: 'Rep spoke',
  ai_outcome: 'Outcome saved',
  ai_handoff: 'Handed to team',
};
const EVENT_TONE: Record<string, Tone> = {
  conversation_ai_say: 'ai',
  conversation_transcript: 'info',
  ai_outcome: 'ok',
  ai_handoff: 'brand',
  call_initiated: 'info',
  entered_hold: 'warn',
  agent_detected: 'ok',
  transfer_initiated: 'brand',
  call_ended_by_user: 'bad',
  voicemail_detected: 'warn',
  max_duration_exceeded: 'bad',
};

export default function AgentPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [ivrConfigs, setIvrConfigs] = useState<IVRConfig[]>([]);
  const [transferNumbers, setTransferNumbers] = useState<TransferNumber[]>([]);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [selectedIvrConfigId, setSelectedIvrConfigId] = useState<string>('');
  const [selectedTransferNumberId, setSelectedTransferNumberId] = useState<string>('');
  const [aiForm, setAiForm] = useState<AiTaskForm>(EMPTY_AI_FORM);
  const aiTask = aiForm.request;
  const setAiField = (k: keyof AiTaskForm, v: string) => {
    setAiForm((f) => ({ ...f, [k]: v }));
    // Remember who's calling between calls (this browser only). The agency ID is saved per cruise line on the server.
    if (k === 'agentName') {
      try { localStorage.setItem('cruisepro.agentName', v); } catch {}
    }
  };
  useEffect(() => {
    try {
      const agentName = localStorage.getItem('cruisepro.agentName') ?? '';
      if (agentName) setAiForm((f) => ({ ...f, agentName }));
    } catch {}
  }, []);
  // Agency ID is saved per cruise line as you type (debounced).
  const [agencySave, setAgencySave] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const agencyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function changeAgencyId(leadId: string, value: string) {
    setAiForm((f) => ({ ...f, agencyId: value }));
    setLeads((ls) => ls.map((l) => (l.id === leadId ? { ...l, agency_id: value.trim() } : l)));
    setSelectedLead((l) => (l && l.id === leadId ? { ...l, agency_id: value.trim() } : l));
    setAgencySave('saving');
    if (agencyTimer.current) clearTimeout(agencyTimer.current);
    agencyTimer.current = setTimeout(async () => {
      try {
        const res = await fetch('/api/leads/agency-id', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leadId, agencyId: value }),
        });
        setAgencySave(res.ok ? 'saved' : 'error');
      } catch {
        setAgencySave('error');
      }
    }, 600);
  }
  const [search, setSearch] = useState('');
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [callLoading, setCallLoading] = useState(false);
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [events, setEvents] = useState<CallEvent[]>([]);
  // AI conversation mode
  const [convMessages, setConvMessages] = useState<Array<{ id: string; speaker: 'agent' | 'us'; text: string; timestamp: string }>>([]);
  const [convInput, setConvInput] = useState('');
  const [convSending, setConvSending] = useState(false);
  const [convAiLoading, setConvAiLoading] = useState(false);
  const [keypadPressing, setKeypadPressing] = useState(false);
  const [keypadLastDigit, setKeypadLastDigit] = useState('');
  const [latestIvrPrompt, setLatestIvrPrompt] = useState('');
  const esRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const convEndRef = useRef<HTMLDivElement>(null);

  const [isAdmin, setIsAdmin] = useState(false);

  // Load leads, IVR configs, and transfer numbers
  useEffect(() => {
    fetch('/api/leads')
      .then((r) => r.json())
      .then((d) => { setLeads(d.leads ?? []); setIsAdmin(d.isAdmin ?? false); });
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

  // Auto-scroll conversation
  useEffect(() => {
    const pane = convEndRef.current?.parentElement;
    if (pane) pane.scrollTo({ top: pane.scrollHeight, behavior: 'smooth' });
  }, [convMessages]);

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
        setEvents(msg.events ?? []);
        updateCall(msg.call);
        // Rebuild conversation messages from snapshot
        const convEvs = (msg.events ?? []).filter(
          (e: CallEvent) => e.event_type === 'conversation_transcript' || e.event_type === 'conversation_ai_say'
        );
        setConvMessages(convEvs.map((e: CallEvent) => ({
          id: e.id,
          speaker: e.event_type === 'conversation_transcript' ? 'agent' : 'us',
          text: ((e.details as Record<string, string>).text) ?? '',
          timestamp: e.created_at,
        })));
        // Restore latest IVR prompt from snapshot
        const transcripts = (msg.events ?? []).filter((e: CallEvent) => e.event_type === 'transcript');
        if (transcripts.length > 0) {
          const last = transcripts[transcripts.length - 1] as CallEvent;
          setLatestIvrPrompt(((last.details as Record<string, string>).text) ?? '');
        }
      }

      if (msg.type === 'event') {
        setEvents((prev) => {
          if (prev.some((ev) => ev.id === msg.event.id)) return prev;
          return [...prev, msg.event];
        });
        updateCall(msg.call);
        // Track latest IVR transcript for keypad display
        if (msg.event.event_type === 'transcript') {
          const txt = ((msg.event.details as Record<string, string>).text) ?? '';
          if (txt) setLatestIvrPrompt(txt);
        }
        // Handle conversation events
        if (msg.event.event_type === 'conversation_transcript' || msg.event.event_type === 'conversation_ai_say') {
          const det = msg.event.details as Record<string, string>;
          setConvMessages((prev) => {
            if (prev.some((m) => m.id === msg.event.id)) return prev;
            return [...prev, {
              id: msg.event.id,
              speaker: msg.event.event_type === 'conversation_transcript' ? 'agent' : 'us',
              text: det.text ?? '',
              timestamp: msg.event.created_at,
            }];
          });
        }
      }

      if (msg.type === 'status') {
        updateCall(msg.call);
      }

      setTimeout(() => {
        const pane = logsEndRef.current?.parentElement;
        if (pane) pane.scrollTo({ top: pane.scrollHeight, behavior: 'smooth' });
      }, 50);
    };

    es.onerror = () => {
      if (done) es.close(); // Don't reconnect after call ends
    };
  };

  function handleSelectLead(lead: Lead) {
    setSelectedLead(lead);
    // Each cruise line has its own agency ID — load the one saved for this line.
    setAiForm((f) => ({ ...f, agencyId: lead.agency_id ?? '' }));
    setAgencySave('idle');
    // Auto-select the lead's IVR config if it has one
    setSelectedIvrConfigId(lead.ivr_config_id ?? '');
  }

  async function handlePlaceCall() {
    if (!selectedLead) return;
    setCallLoading(true);
    setError('');
    setElapsed(0);
    setEvents([]);
    setConvMessages([]);
    setLatestIvrPrompt('');
    setKeypadLastDigit('');

    const selectedTransferNumber = transferNumbers.find((n) => n.id === selectedTransferNumberId);
    const res = await fetch('/api/calls/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        leadId: selectedLead.id,
        ivrConfigId: selectedIvrConfigId || undefined,
        transferNumber: selectedTransferNumber?.phone,
        aiTaskDetails: aiTask.trim() ? aiForm : undefined,
        agencyId: aiForm.agencyId.trim() || undefined,
      }),
    });

    let data: Record<string, string> = {};
    try { data = await res.json(); } catch { /* empty body on 500 */ }
    setCallLoading(false);

    if (!res.ok) {
      setError(data.error ?? `Server error (${res.status}) — please try again`);
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

  async function handleConvSpeak() {
    if (!activeCall || !convInput.trim() || convSending) return;
    const text = convInput.trim();
    setConvInput('');
    setConvSending(true);
    try {
      await fetch('/api/calls/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: activeCall.callId, text }),
      });
    } finally {
      setConvSending(false);
    }
  }

  async function handleAiRespond() {
    if (!activeCall || convAiLoading) return;
    setConvAiLoading(true);
    try {
      await fetch('/api/calls/ai-respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: activeCall.callId }),
      });
    } finally {
      setConvAiLoading(false);
    }
  }

  async function handleKeypadPress(digit: string) {
    if (!activeCall || keypadPressing) return;
    setKeypadPressing(true);
    setKeypadLastDigit(digit);
    try {
      await fetch('/api/calls/press', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callId: activeCall.callId, digit }),
      });
    } finally {
      setKeypadPressing(false);
      setTimeout(() => setKeypadLastDigit(''), 600);
    }
  }

  const filteredLeads = leads.filter(
    (l) =>
      l.name.toLowerCase().includes(search.toLowerCase()) ||
      l.phone_number.includes(search) ||
      l.category?.toLowerCase().includes(search.toLowerCase())
  );

  const isLiveStatus = activeCall && !['completed', 'failed', 'cancelled'].includes(activeCall.status);

  const tone: Tone = activeCall ? STATUS_TONE[activeCall.status] ?? 'neutral' : 'neutral';
  const progressSteps = [
    { key: 'initiating', label: 'Dialing' },
    { key: 'navigating_ivr', label: 'Menu' },
    { key: 'on_hold', label: 'On hold' },
    { key: 'agent_detected', label: 'Agent' },
    ...(aiTask.trim() ? [{ key: 'ai_conversation', label: 'AI chat' }] : []),
    { key: 'connected', label: 'Connected' },
  ];
  const statusOrder = ['initiating', 'navigating_ivr', 'on_hold', 'agent_detected', ...(aiTask.trim() ? ['ai_conversation'] : []), 'connected', 'completed'];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Call Agent"
        subtitle="Pick a cruise line, set the task, and let the system wait on hold for you."
        actions={activeCall ? <StatusBadge status={activeCall.status} /> : undefined}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 max-lg:px-3">
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(420px,560px)_minmax(0,1fr)] lg:grid-rows-[auto_1fr] wide:grid-cols-[560px_minmax(0,1fr)_300px] wide:items-stretch">
          {/* ── Left: choose + configure ── */}
          <div className="space-y-4 lg:row-span-2 wide:row-span-1">
            <section className="card overflow-hidden">
              <div className="border-b border-line p-3.5">
                <p className="eyebrow mb-2.5 px-0.5">1 · Cruise line</p>
                <div className="relative">
                  <Icon name="search" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
                  <input
                    type="text"
                    placeholder="Search cruise lines…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="input pl-10"
                  />
                </div>
              </div>
              <div className="max-h-[calc(100vh-32rem)] min-h-72 overflow-y-auto p-2">
                {filteredLeads.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-muted">No cruise lines found. Add them in Leads.</p>
                ) : (
                  filteredLeads.map((lead) => {
                    const selected = selectedLead?.id === lead.id;
                    return (
                      <button
                        key={lead.id}
                        onClick={() => handleSelectLead(lead)}
                        disabled={!!isLiveStatus}
                        className={`mb-0.5 w-full rounded-xl px-3.5 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${
                          selected ? 'bg-brand-soft ring-1 ring-brand-line' : 'hover:bg-sunken'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className={`truncate text-sm font-semibold ${selected ? 'text-brand-strong' : 'text-ink'}`}>{lead.name}</p>
                            <p className="mt-0.5 font-mono text-xs text-muted">{lead.phone_number}</p>
                            <p className={`mt-0.5 flex items-center gap-1 text-xs ${lead.agency_id ? 'text-ok' : 'text-faint'}`}>
                              <Icon name="shield" className="h-3.5 w-3.5" />
                              {lead.agency_id ? `Agency ID: ${lead.agency_id}` : 'No agency ID'}
                            </p>
                          </div>
                          <div className="flex flex-shrink-0 flex-col items-end gap-1">
                            {lead.category && <Badge tone="info">{lead.category}</Badge>}
                            {isAdmin && lead.owner_name && <Badge tone="bad">{lead.owner_name}</Badge>}
                          </div>
                        </div>
                        {lead.directory_name && <p className="mt-1 text-xs text-faint">{lead.directory_name}</p>}
                      </button>
                    );
                  })
                )}
              </div>
            </section>

            {selectedLead && !isLiveStatus && (
              <section className="card rise space-y-3 p-3">
                <div>
                  <p className="eyebrow mb-2">2 · Call setup</p>
                  <div className="flex items-center gap-3 rounded-xl bg-canvas p-3">
                    <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-brand-soft font-display text-lg text-brand-strong">
                      {selectedLead.name.charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-ink">{selectedLead.name}</p>
                      <p className="font-mono text-xs text-muted">{selectedLead.phone_number}</p>
                    </div>
                  </div>
                </div>

                {/* Agency ID — each cruise line has its own; saved per line when the call is placed */}
                <div>
                  <label className="field-label flex items-center gap-1.5">
                    <Icon name="shield" className="h-4 w-4 text-brand-strong" />
                    Agency ID (IATA / CLIA) for {selectedLead.name}
                  </label>
                  <input
                    value={aiForm.agencyId}
                    onChange={(e) => changeAgencyId(selectedLead.id, e.target.value)}
                    placeholder="Type it once — saved for this cruise line"
                    className="input"
                  />
                  <p className={`mt-1 text-xs ${agencySave === 'error' || (!aiForm.agencyId.trim() && aiTask.trim()) ? 'text-bad' : agencySave === 'saved' ? 'text-ok' : 'text-muted'}`}>
                    {agencySave === 'saving' ? 'Saving…'
                      : agencySave === 'error' ? 'Could not save — try again'
                      : aiForm.agencyId.trim() ? '✓ Saved for ' + selectedLead.name
                      : aiTask.trim() ? 'Not set for ' + selectedLead.name + ' — if the rep asks for it, the AI hands the call to your team'
                      : 'Not set for ' + selectedLead.name}
                  </p>
                </div>

                {/* IVR Config selector — configs are already scoped to the current (effective) user */}
                {ivrConfigs.length > 0 && (
                  <div>
                    <label className="field-label">IVR script</label>
                    <select value={selectedIvrConfigId} onChange={(e) => setSelectedIvrConfigId(e.target.value)} className="input">
                      <option value="">No IVR (hold detection only)</option>
                      {ivrConfigs.map((cfg) => (
                        <option key={cfg.id} value={cfg.id}>{cfg.name}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Transfer number selector */}
                {transferNumbers.length > 1 && (
                  <div>
                    <label className="field-label">Transfer to</label>
                    <select value={selectedTransferNumberId} onChange={(e) => setSelectedTransferNumberId(e.target.value)} className="input">
                      {transferNumbers.map((n) => (
                        <option key={n.id} value={n.id}>{n.name} — {n.phone}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* AI Task form */}
                <div className="space-y-2 rounded-2xl border border-ai/15 bg-ai-soft/50 p-2.5">
                  <div className="flex items-center justify-between">
                    <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                      <Icon name="spark" className="h-4 w-4 text-ai" />
                      AI assistant task
                    </p>
                    <Badge tone="ai">Optional</Badge>
                  </div>
                  <select value={aiForm.requestType} onChange={(e) => setAiField('requestType', e.target.value)} className="input">
                    {AI_REQUEST_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                  <label className="field-label !mb-0 pt-1">1 · What should the AI ask for?</label>
                  <textarea
                    rows={12}
                    placeholder='Exact request, e.g. "Add guest to the waitlist for the Denali tundra tour on Aug 12"'
                    value={aiForm.request}
                    onChange={(e) => setAiField('request', e.target.value)}
                    className="input min-h-[300px] !resize-y text-base"
                  />
                  <p className="text-xs leading-relaxed text-muted">
                    {aiTask.trim()
                      ? 'The AI makes this request, then texts you a summary. It hands the call to your team for payment or anything it can’t answer. No card numbers here.'
                      : 'Leave blank to use the standard connect message and transfer.'}
                  </p>
                </div>

                {!selectedIvrConfigId && (
                  <p className="rounded-xl bg-warn-soft px-3.5 py-2.5 text-xs text-warn">
                    No IVR script selected, so the call goes straight to hold detection.
                  </p>
                )}
              </section>
            )}

            {error && (
              <div role="alert" className="rounded-xl bg-bad-soft px-4 py-3 text-sm text-bad">{error}</div>
            )}

            <button
              onClick={handlePlaceCall}
              disabled={!selectedLead || callLoading || !!isLiveStatus}
              className="btn btn-primary btn-lg w-full"
            >
              <Icon name="phone" className="h-5 w-5" />
              {callLoading ? 'Placing call…' : 'Place call'}
            </button>
          </div>

          {/* ── Center: the call ── */}
          <div className="min-w-0 wide:[&>section]:h-full">
            {activeCall ? (
              <section className="card rise flex min-h-[560px] flex-col overflow-hidden">
                {/* Status band */}
                <div className={`flex items-start justify-between gap-4 px-7 py-6 ${TONE_BAND[tone]}`}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-3">
                      {isLiveStatus && <LiveDot />}
                      <h2 className={`font-display text-[26px] font-medium leading-tight ${TONE_TEXT[tone]}`}>
                        {STATUS_LABELS[activeCall.status] ?? activeCall.status}
                      </h2>
                    </div>
                    <p className="mt-2 text-sm font-semibold text-ink">{activeCall.leadName}</p>
                    <p className="font-mono text-xs text-muted">{activeCall.leadPhone}</p>
                  </div>
                  <div className="flex-shrink-0 text-right">
                    <p className="font-display text-[40px] font-medium leading-none tabular-nums text-ink">{formatDuration(elapsed)}</p>
                    <p className="mt-1.5 text-xs text-muted">Total elapsed</p>
                  </div>
                </div>

                {/* Progress */}
                <ol className="flex px-7 pt-6">
                  {progressSteps.map((step, i) => {
                    const currentIdx = statusOrder.indexOf(activeCall.status);
                    const stepIdx = statusOrder.indexOf(step.key);
                    const done = currentIdx > stepIdx;
                    const active = currentIdx === stepIdx;
                    return (
                      <li key={step.key} className="relative flex-1 text-center">
                        {i > 0 && <span className={`absolute right-1/2 top-3.5 h-0.5 w-full ${done || active ? 'bg-brand' : 'bg-line'}`} />}
                        <span
                          className={`relative z-10 mx-auto flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                            done
                              ? 'bg-brand text-white'
                              : active
                              ? 'bg-brand text-white ring-4 ring-brand/20'
                              : 'bg-sunken text-faint'
                          }`}
                        >
                          {done ? <Icon name="check" className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
                        </span>
                        <span className={`mt-2 block text-[11px] ${active ? 'font-semibold text-ink' : done ? 'text-body' : 'text-faint'}`}>
                          {step.label}
                        </span>
                      </li>
                    );
                  })}
                </ol>

                {/* Scrollable middle content */}
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-7 py-6">
                  {/* Hold timer */}
                  {['on_hold', 'agent_detected'].includes(activeCall.status) && (
                    <div className="flex items-center justify-between rounded-2xl bg-warn-soft px-5 py-4">
                      <div className="flex items-center gap-3 text-warn">
                        <Icon name="clock" className="h-5 w-5" />
                        <p className="text-sm font-semibold">Hold duration</p>
                      </div>
                      <p className="font-display text-3xl tabular-nums text-warn">{formatDuration(elapsed)}</p>
                    </div>
                  )}

                  {/* Agent detected alert */}
                  {activeCall.status === 'agent_detected' && (
                    <div className="rounded-2xl bg-ok-soft px-5 py-4">
                      <p className="font-semibold text-ok">A live agent has answered</p>
                      <p className="mt-1 text-sm text-ok/80">An SMS notification has been sent. Press Transfer to Me to bridge the call.</p>
                    </div>
                  )}

                  {/* Manual DTMF keypad — visible during IVR navigation and hold */}
                  {['navigating_ivr', 'on_hold'].includes(activeCall.status) && (
                    <div className="rounded-2xl bg-canvas p-5">
                      <p className="eyebrow mb-3">Manual keypad</p>

                      {/* Live IVR prompt */}
                      <div className="min-h-[60px] rounded-xl border border-line bg-surface px-4 py-3">
                        {latestIvrPrompt ? (
                          <>
                            <p className="mb-1 text-xs text-muted">The menu said</p>
                            <p className="text-sm leading-snug text-ink">{latestIvrPrompt}</p>
                          </>
                        ) : (
                          <p className="mt-2 text-center text-xs italic text-faint">Waiting for the menu prompt…</p>
                        )}
                      </div>

                      {/* Digit display */}
                      <div className="h-9 pt-1 text-center">
                        {keypadLastDigit && (
                          <span className="font-display text-2xl tracking-widest text-brand">{keypadLastDigit}</span>
                        )}
                      </div>

                      {/* Key grid */}
                      <div className="mx-auto grid max-w-[260px] grid-cols-3 gap-2.5">
                        {['1','2','3','4','5','6','7','8','9','*','0','#'].map((d) => (
                          <button
                            key={d}
                            onClick={() => handleKeypadPress(d)}
                            disabled={keypadPressing}
                            className={`h-12 rounded-2xl border text-base font-semibold transition active:scale-95 disabled:opacity-50 ${
                              d === keypadLastDigit
                                ? 'border-brand bg-brand text-white'
                                : 'border-line bg-surface text-ink hover:border-brand-line hover:bg-brand-soft'
                            }`}
                          >
                            {d}
                          </button>
                        ))}
                      </div>
                      <p className="mt-3 text-center text-xs text-muted">Each digit plays on the call immediately.</p>
                    </div>
                  )}

                  {/* AI Conversation Panel */}
                  {activeCall.status === 'ai_conversation' && (
                    <div className="space-y-3.5">
                      <div className="flex items-center gap-2">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-ai" />
                        <p className="eyebrow !text-ai">AI is handling the conversation</p>
                      </div>

                      {/* Chat messages */}
                      <div className="flex h-60 flex-col gap-3 overflow-y-auto rounded-2xl bg-canvas p-4">
                        {convMessages.length === 0 ? (
                          <p className="mt-8 text-center text-xs text-muted">Waiting for the cruise agent to speak…</p>
                        ) : (
                          convMessages.map((msg) => (
                            <div key={msg.id} className={`flex flex-col ${msg.speaker === 'us' ? 'items-end' : 'items-start'}`}>
                              <span className="mb-1 text-[11px] text-faint">
                                {msg.speaker === 'us' ? 'AI / You' : 'Cruise agent'} ·{' '}
                                {new Date(msg.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                              </span>
                              <div
                                className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed ${
                                  msg.speaker === 'us' ? 'rounded-tr-md bg-ai text-white' : 'rounded-tl-md border border-line bg-surface text-ink'
                                }`}
                              >
                                {msg.text}
                              </div>
                            </div>
                          ))
                        )}
                        <div ref={convEndRef} />
                      </div>

                      {/* Manual text input */}
                      <div className="flex gap-2">
                        <input
                          type="text"
                          placeholder="Type a message to speak…"
                          value={convInput}
                          onChange={(e) => setConvInput(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleConvSpeak()}
                          disabled={convSending}
                          className="input"
                        />
                        <button onClick={handleConvSpeak} disabled={!convInput.trim() || convSending} className="btn btn-ai flex-shrink-0">
                          Send
                        </button>
                      </div>

                      {/* Action buttons */}
                      <div className="grid grid-cols-3 gap-2">
                        <button onClick={handleAiRespond} disabled={convAiLoading} className="btn btn-ai">
                          {convAiLoading ? 'AI thinking…' : 'Let AI handle'}
                        </button>
                        <button onClick={handleTransfer} className="btn btn-ok">Transfer to me</button>
                        <button onClick={handleEndCall} className="btn btn-danger">End call</button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Action buttons — pinned at bottom, always visible */}
                {activeCall.status !== 'ai_conversation' && isLiveStatus && (
                  <div className="flex gap-3 border-t border-line bg-surface p-5">
                    {!['connected', 'transferring'].includes(activeCall.status) && (
                      <button onClick={handleTransfer} className="btn btn-ok flex-1 py-3">
                        <Icon name="user" className="h-4 w-4" />
                        Transfer to me
                      </button>
                    )}
                    {!['connected'].includes(activeCall.status) && (
                      <button onClick={handleEndCall} className="btn btn-danger flex-1 py-3">End call</button>
                    )}
                  </div>
                )}
              </section>
            ) : (
              <section className="card flex min-h-[420px] items-center justify-center">
                <EmptyState icon="phone" title="No active call" hint="Choose a cruise line on the left, then press Place call." />
              </section>
            )}
          </div>

          {/* ── Live event log ── */}
          <section className="card flex max-h-[560px] min-h-64 flex-col overflow-hidden lg:col-start-2 wide:col-start-3 wide:row-start-1">
            <div className="flex items-center gap-2.5 border-b border-line px-5 py-3.5">
              {activeCall && isLiveStatus && <LiveDot />}
              <p className="eyebrow">Live logs</p>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-4 text-xs">
              {events.length === 0 ? (
                <p className="mt-8 text-center text-faint">No events yet</p>
              ) : (
                events.map((ev) => {
                  const time = new Date(ev.created_at).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

                  // Transcript — show as speech bubble
                  if (ev.event_type === 'transcript') {
                    const text = (ev.details as Record<string, string>).text ?? '';
                    return (
                      <div key={ev.id} className="pt-1">
                        <div className="mb-1 font-mono text-[11px] text-faint">{time} · cruise line</div>
                        <div className="rounded-xl rounded-tl-md bg-canvas px-3 py-2 text-[13px] leading-relaxed text-ink">{text}</div>
                      </div>
                    );
                  }

                  if (ev.event_type === 'twilio_status') return null;

                  let label: string;
                  let dot: Tone = 'neutral';

                  // IVR step events
                  const stepMatch = ev.event_type.match(/^ivr_step_(\d+)$/);
                  if (stepMatch) {
                    const d = ev.details as Record<string, Record<string, string>>;
                    label = d?.step?.description ?? `Step ${stepMatch[1]}`;
                    dot = 'info';
                  } else if (ev.event_type === 'ai_action') {
                    // AI action events
                    const d = ev.details as Record<string, string>;
                    label = d.action === 'PRESS'
                      ? `Pressed ${d.digit}`
                      : d.action === 'SAY'
                      ? `Said: "${d.phrase}"`
                      : d.action ?? 'action';
                    dot = 'ai';
                  } else {
                    label = EVENT_LABEL[ev.event_type] ?? ev.event_type.replace(/_/g, ' ');
                    dot = EVENT_TONE[ev.event_type] ?? 'neutral';
                  }

                  return (
                    <div key={ev.id} className="flex items-start gap-2.5 py-0.5">
                      <span className="w-[52px] flex-shrink-0 pt-px font-mono text-[11px] text-faint">{time}</span>
                      <span className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${DOT_BG[dot]}`} />
                      <span className="text-[13px] first-letter:uppercase text-body">{label}</span>
                    </div>
                  );
                })
              )}
              <div ref={logsEndRef} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
