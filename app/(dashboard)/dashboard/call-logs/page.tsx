'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Icon } from '@/components/icons';
import { AdminBadge, Badge, EmptyState, PageHeader, Spinner, StatusBadge, statusName } from '@/components/ui';

interface Call {
  id: string;
  lead_name: string;
  lead_phone: string;
  cruise_line_number: string;
  status: string;
  hold_duration_seconds: number | null;
  total_duration_seconds: number | null;
  created_at: string;
  agent_detected_time: string | null;
  error_message: string | null;
  ai_task: string | null;
  ai_outcome: string | null;
  ai_summary: string | null;
  ai_engine_used: string | null;
  recording_url: string | null;
  transcript: { text?: string; utterances?: Array<{ speaker: number; text: string; start: number; end: number }> } | null;
  owner_name?: string;
  owner_email?: string;
}

const PAGE_SIZE = 25;

const AI_OUTCOME_LABEL: Record<string, string> = {
  resolved: 'Done',
  partial: 'Partly done',
  not_resolved: 'Not done',
  handed_off: 'Handed to team',
  rep_refused_ai: 'Rep would not work with AI',
  disconnected: 'Call dropped',
};

function fmt(seconds: number | null) {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function CallLogsPage() {
  const [calls, setCalls] = useState<Call[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [expandedCallId, setExpandedCallId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [impersonating, setImpersonating] = useState(false);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const load = useCallback(async (p: number, status: string) => {
    setLoading(true);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(p * PAGE_SIZE) });
    if (status) params.set('status', status);
    const r = await fetch(`/api/calls?${params}`);
    const d = await r.json();
    setCalls(d.calls ?? []);
    setTotal(d.total ?? 0);
    setIsAdmin(d.isAdmin ?? false);
    setImpersonating(d.impersonating ?? false);
    setLoading(false);
  }, []);

  useEffect(() => {
    setPage(0);
    load(0, statusFilter);
  }, [statusFilter, load]);

  useEffect(() => {
    load(page, statusFilter);
  }, [page, load, statusFilter]);

  const toggleTranscript = (callId: string) => {
    setExpandedCallId(expandedCallId === callId ? null : callId);
  };

  function exportCSV() {
    const rows = [
      ['Date', 'Lead', 'Phone', 'Status', 'Hold Time', 'Total Duration'].join(','),
      ...calls.map((c) =>
        [fmtDate(c.created_at), c.lead_name ?? '', c.cruise_line_number ?? '', c.status, fmt(c.hold_duration_seconds), fmt(c.total_duration_seconds)].join(',')
      ),
    ];
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `call-logs-${Date.now()}.csv`;
    a.click();
  }

  const goTo = (p: number) => {
    if (p < 0 || p >= totalPages) return;
    setPage(p);
    setExpandedCallId(null);
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Call Logs"
        badge={isAdmin && !impersonating ? <AdminBadge /> : undefined}
        subtitle={total > 0 ? `${total} call${total !== 1 ? 's' : ''} in your history` : 'The full history of your outbound calls'}
        actions={
          <button onClick={exportCSV} className="btn btn-secondary">
            <Icon name="download" className="h-4 w-4" />
            Export CSV
          </button>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col px-10 pb-8 max-lg:px-6">
        {/* Filter */}
        <div className="mb-4 flex flex-wrap gap-2">
          {['', 'completed', 'connected', 'ai_conversation', 'on_hold', 'failed', 'cancelled'].map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors ${
                statusFilter === s
                  ? 'border-brand bg-brand text-white'
                  : 'border-line-strong bg-surface text-body hover:bg-sunken'
              }`}
            >
              {s === '' ? 'All' : statusName(s)}
            </button>
          ))}
        </div>

        {/* Table */}
        <section className="card flex min-h-0 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex h-48 items-center justify-center">
                <Spinner />
              </div>
            ) : calls.length === 0 ? (
              <EmptyState icon="inbox" title="No calls found" hint="Calls you place from the Call Agent page will show up here." />
            ) : (
              <table className="w-full">
                <thead className="sticky top-0 z-10 bg-surface">
                  <tr className="border-b border-line">
                    {['', 'Date', 'Cruise line', 'Phone', 'Status', 'Hold time', 'Duration', 'Recording'].map((h) => (
                      <th key={h} className="th">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {calls.map((call) => (
                    <React.Fragment key={call.id}>
                      <tr
                        className={`cursor-pointer border-b border-line/70 transition-colors hover:bg-canvas ${expandedCallId === call.id ? 'bg-canvas' : ''}`}
                        onClick={() => toggleTranscript(call.id)}
                      >
                        <td className="td w-10 !pr-0 text-faint">
                          <Icon name="chevronRight" className={`h-4 w-4 transition-transform ${expandedCallId === call.id ? 'rotate-90 text-brand' : ''}`} />
                        </td>
                        <td className="td whitespace-nowrap text-muted">{fmtDate(call.created_at)}</td>
                        <td className="td font-semibold text-ink">{call.lead_name ?? '—'}</td>
                        <td className="td font-mono text-[13px] text-muted">{call.cruise_line_number ?? '—'}</td>
                        <td className="td"><StatusBadge status={call.status} /></td>
                        <td className="td tabular-nums">{fmt(call.hold_duration_seconds)}</td>
                        <td className="td tabular-nums">{fmt(call.total_duration_seconds)}</td>
                        <td className="td" onClick={(e) => e.stopPropagation()}>
                          {call.recording_url ? (
                            <div className="flex items-center gap-2">
                              <audio controls src={`/api/calls/${call.id}/recording`} className="h-8 w-44" style={{ accentColor: '#c4532a' }} preload="none" />
                              <a href={`/api/calls/${call.id}/recording`} download target="_blank" rel="noreferrer" className="btn-icon" title="Download">
                                <Icon name="download" className="h-4 w-4" />
                              </a>
                            </div>
                          ) : (
                            <span className="text-faint">—</span>
                          )}
                        </td>
                      </tr>
                      {expandedCallId === call.id && (
                        <tr key={`${call.id}-transcript`} className="border-b border-line/70 bg-canvas">
                          <td colSpan={8} className="px-5 pb-5 pt-1">
                            <div className="max-h-96 overflow-y-auto rounded-2xl border border-line bg-surface p-5">
                              {call.ai_task && (
                                <div className="mb-5 rounded-xl bg-ai-soft p-4 text-sm">
                                  <div className="mb-1.5 flex items-center gap-2">
                                    <Icon name="spark" className="h-4 w-4 text-ai" />
                                    <span className="eyebrow !text-ai">AI task</span>
                                    {call.ai_outcome && (
                                      <Badge tone="ai" className="bg-surface/70">{AI_OUTCOME_LABEL[call.ai_outcome] ?? call.ai_outcome}</Badge>
                                    )}
                                  </div>
                                  <p className="text-body">{call.ai_task}</p>
                                  {call.ai_summary && <p className="mt-2 whitespace-pre-wrap font-medium text-ink">{call.ai_summary}</p>}
                                  {call.ai_engine_used && <p className="mt-2 text-xs text-muted">AI used: {call.ai_engine_used}</p>}
                                </div>
                              )}
                              <h4 className="eyebrow mb-3">Call transcript</h4>
                              {call.transcript?.utterances && call.transcript.utterances.length > 0 ? (
                                <div className="space-y-2.5">
                                  {call.transcript.utterances.map((u, i) => (
                                    <div key={i} className="flex gap-3 text-sm">
                                      <span className="mt-2 w-12 shrink-0 text-right font-mono text-xs text-faint">
                                        {Math.floor(u.start / 60)}:{String(Math.floor(u.start % 60)).padStart(2, '0')}
                                      </span>
                                      <div
                                        className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 ${
                                          u.speaker === 0 ? 'rounded-tl-md bg-info-soft text-ink' : 'rounded-tl-md bg-brand-soft text-ink'
                                        }`}
                                      >
                                        <span className={`mb-0.5 block text-[11px] font-semibold ${u.speaker === 0 ? 'text-info' : 'text-brand-strong'}`}>
                                          {u.speaker === 0 ? 'IVR / Agent' : 'Our system'}
                                        </span>
                                        {u.text}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              ) : call.transcript?.text ? (
                                <p className="whitespace-pre-wrap text-sm leading-relaxed text-body">{call.transcript.text}</p>
                              ) : call.transcript ? (
                                <p className="text-sm text-muted">Recording too short — no speech detected.</p>
                              ) : (
                                <p className="text-sm text-muted">
                                  {call.recording_url ? 'Transcript processing…' : 'No recording available for this call.'}
                                </p>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-line px-5 py-3.5">
              <p className="text-xs text-muted">
                Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
              </p>
              <div className="flex items-center gap-1">
                <button onClick={() => goTo(0)} disabled={page === 0} className="btn-icon disabled:opacity-30" title="First page">
                  <Icon name="chevronsLeft" className="h-4 w-4" />
                </button>
                <button onClick={() => goTo(page - 1)} disabled={page === 0} className="btn-icon disabled:opacity-30" title="Previous">
                  <Icon name="chevronLeft" className="h-4 w-4" />
                </button>

                {/* Page number buttons — show at most 5 around current */}
                {Array.from({ length: totalPages }, (_, i) => i)
                  .filter((i) => Math.abs(i - page) <= 2)
                  .map((i) => (
                    <button
                      key={i}
                      onClick={() => goTo(i)}
                      className={`h-8 w-8 rounded-lg text-xs font-semibold transition-colors ${
                        i === page ? 'bg-brand text-white' : 'text-body hover:bg-sunken'
                      }`}
                    >
                      {i + 1}
                    </button>
                  ))}

                <button onClick={() => goTo(page + 1)} disabled={page >= totalPages - 1} className="btn-icon disabled:opacity-30" title="Next">
                  <Icon name="chevronRight" className="h-4 w-4" />
                </button>
                <button onClick={() => goTo(totalPages - 1)} disabled={page >= totalPages - 1} className="btn-icon disabled:opacity-30" title="Last page">
                  <Icon name="chevronsRight" className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
