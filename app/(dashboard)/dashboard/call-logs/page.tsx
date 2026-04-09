'use client';

import React, { useState, useEffect } from 'react';
import { useUserView } from '@/lib/user-view-context';

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
  recording_url: string | null;
  transcript: { text?: string; utterances?: Array<{ speaker: number; text: string; start: number; end: number }> } | null;
}

const STATUS_BADGE: Record<string, string> = {
  completed: 'bg-green-900/50 text-green-400 border-green-700/50',
  connected: 'bg-blue-900/50 text-blue-400 border-blue-700/50',
  agent_detected: 'bg-purple-900/50 text-purple-400 border-purple-700/50',
  on_hold: 'bg-orange-900/50 text-orange-400 border-orange-700/50',
  navigating_ivr: 'bg-yellow-900/50 text-yellow-400 border-yellow-700/50',
  failed: 'bg-red-900/50 text-red-400 border-red-700/50',
  cancelled: 'bg-gray-800 text-gray-500 border-gray-700',
  initiating: 'bg-gray-800 text-gray-400 border-gray-700',
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
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [expandedCallId, setExpandedCallId] = useState<string | null>(null);
  const { viewAsId, viewAsUser } = useUserView();

  const load = async () => {
    setLoading(true);
    const params = new URLSearchParams({ limit: '100' });
    if (statusFilter) params.set('status', statusFilter);
    if (viewAsId) params.set('viewAs', viewAsId);
    const r = await fetch(`/api/calls?${params}`);
    const d = await r.json();
    setCalls(d.calls ?? []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [statusFilter, viewAsId]);

  const toggleTranscript = (callId: string) => {
    setExpandedCallId(expandedCallId === callId ? null : callId);
  };

  // Stats
  const total = calls.length;
  const completed = calls.filter((c) => c.status === 'completed').length;
  const avgHold = calls.filter((c) => c.hold_duration_seconds).reduce((a, c) => a + (c.hold_duration_seconds ?? 0), 0) / (calls.filter((c) => c.hold_duration_seconds).length || 1);

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

  return (
    <div className="h-full flex flex-col">
      {viewAsUser && (
        <div className="px-8 py-2.5 bg-purple-900/20 border-b border-purple-800/40 flex items-center gap-2">
          <div className="w-5 h-5 rounded-full bg-purple-700 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
            {viewAsUser.name.charAt(0).toUpperCase()}
          </div>
          <p className="text-sm text-purple-300">Viewing as <span className="font-semibold">{viewAsUser.name}</span></p>
        </div>
      )}
      <div className="px-8 py-6 border-b border-gray-800 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Call Logs</h1>
          <p className="text-gray-400 text-sm mt-1">Full history of all outbound calls</p>
        </div>
        <button
          onClick={exportCSV}
          className="flex items-center gap-2 border border-gray-700 text-gray-400 hover:text-white text-sm px-4 py-2.5 rounded-xl transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Export CSV
        </button>
      </div>

      {/* Stats */}
      <div className="px-8 py-5 grid grid-cols-4 gap-4 border-b border-gray-800">
        {[
          { label: 'Total Calls', value: total },
          { label: 'Completed', value: completed },
          { label: 'Success Rate', value: total ? `${Math.round((completed / total) * 100)}%` : '—' },
          { label: 'Avg Hold Time', value: fmt(Math.round(avgHold)) },
        ].map((stat) => (
          <div key={stat.label} className="bg-gray-900 rounded-xl p-4 border border-gray-800">
            <p className="text-xs text-gray-500 uppercase tracking-wider">{stat.label}</p>
            <p className="text-2xl font-bold text-white mt-1">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Filter */}
      <div className="px-8 py-4 flex gap-2 border-b border-gray-800 flex-wrap">
        {['', 'completed', 'connected', 'on_hold', 'failed', 'cancelled'].map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
              statusFilter === s ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-700 text-gray-500 hover:text-gray-300'
            }`}
          >
            {s === '' ? 'All' : s.replace('_', ' ')}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : calls.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 rounded-full bg-gray-900 border border-gray-800 flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
            <p className="text-gray-500">No calls found</p>
          </div>
        ) : (
          <table className="w-full">
            <thead className="sticky top-0 bg-gray-950">
              <tr className="border-b border-gray-800">
                {['', 'Date', 'Cruise Line', 'Phone', 'Status', 'Hold Time', 'Duration', 'Recording'].map((h) => (
                  <th key={h} className="text-left text-xs text-gray-500 uppercase tracking-wider px-4 py-3">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {calls.map((call) => (
                <React.Fragment key={call.id}>
                  <tr className="border-b border-gray-800/50 hover:bg-gray-900/50 transition-colors cursor-pointer" onClick={() => toggleTranscript(call.id)}>
                    <td className="px-4 py-4 text-gray-500">
                      <svg className={`w-4 h-4 transition-transform ${expandedCallId === call.id ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </td>
                    <td className="px-4 py-4 text-sm text-gray-400">{fmtDate(call.created_at)}</td>
                    <td className="px-4 py-4 text-sm font-medium text-white">{call.lead_name ?? '—'}</td>
                    <td className="px-4 py-4 text-sm text-gray-400 font-mono">{call.cruise_line_number ?? '—'}</td>
                    <td className="px-4 py-4">
                      <span className={`text-xs px-2.5 py-1 rounded-full border ${STATUS_BADGE[call.status] ?? 'bg-gray-800 text-gray-400 border-gray-700'}`}>
                        {call.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-sm text-gray-400">{fmt(call.hold_duration_seconds)}</td>
                    <td className="px-4 py-4 text-sm text-gray-400">{fmt(call.total_duration_seconds)}</td>
                    <td className="px-4 py-4" onClick={(e) => e.stopPropagation()}>
                      {call.recording_url ? (
                        <div className="flex items-center gap-2">
                          <audio controls src={`/api/calls/${call.id}/recording`} className="h-8 w-44" style={{ accentColor: '#3b82f6' }} preload="none" />
                          <a href={`/api/calls/${call.id}/recording`} download target="_blank" rel="noreferrer" className="text-gray-500 hover:text-white transition-colors" title="Download">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                            </svg>
                          </a>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-600">—</span>
                      )}
                    </td>
                  </tr>
                  {expandedCallId === call.id && (
                    <tr key={`${call.id}-transcript`} className="border-b border-gray-800/50">
                      <td colSpan={8} className="px-4 py-0">
                        <div className="bg-gray-900/80 rounded-xl border border-gray-800 my-2 p-4 max-h-96 overflow-y-auto">
                          <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-3 font-semibold">Call Transcript</h4>
                          {call.transcript?.utterances && call.transcript.utterances.length > 0 ? (
                            <div className="space-y-2">
                              {call.transcript.utterances.map((u, i) => (
                                <div key={i} className="flex gap-3 text-sm">
                                  <span className="text-gray-600 text-xs font-mono shrink-0 mt-1 w-14 text-right">
                                    {Math.floor(u.start / 60)}:{String(Math.floor(u.start % 60)).padStart(2, '0')}
                                  </span>
                                  <div className={`rounded-lg px-3 py-2 max-w-[80%] ${
                                    u.speaker === 0
                                      ? 'bg-blue-900/30 border border-blue-800/50 text-blue-200'
                                      : 'bg-gray-800/50 border border-gray-700/50 text-gray-200'
                                  }`}>
                                    <span className="text-xs font-semibold block mb-0.5 opacity-60">
                                      {u.speaker === 0 ? 'IVR / Agent' : 'Our System'}
                                    </span>
                                    {u.text}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : call.transcript?.text ? (
                            <p className="text-gray-300 text-sm leading-relaxed whitespace-pre-wrap">{call.transcript.text}</p>
                          ) : call.transcript ? (
                            <p className="text-gray-600 text-sm">Recording too short — no speech detected.</p>
                          ) : (
                            <p className="text-gray-600 text-sm">
                              {call.recording_url ? 'Transcript processing...' : 'No recording available for this call.'}
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
    </div>
  );
}
