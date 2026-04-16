'use client';

import { useState, useEffect, useRef } from 'react';

interface Directory {
  id: string;
  name: string;
  description: string;
  lead_count: number;
}

interface Lead {
  id: string;
  name: string;
  phone_number: string;
  category: string;
  notes: string;
  directory_name: string;
  directory_id: string;
  ivr_config_id: string | null;
}

interface IVRConfig {
  id: string;
  name: string;
}

export default function LeadsPage() {
  const [directories, setDirectories] = useState<Directory[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [ivrConfigs, setIvrConfigs] = useState<IVRConfig[]>([]);
  const [selectedDir, setSelectedDir] = useState<string>('');
  const [search, setSearch] = useState('');
  const [showDirModal, setShowDirModal] = useState(false);
  const [showLeadModal, setShowLeadModal] = useState(false);
  const [editingLead, setEditingLead] = useState<Lead | null>(null);
  const [dirForm, setDirForm] = useState({ name: '', description: '' });
  const [leadForm, setLeadForm] = useState({ name: '', phone_number: '', category: '', notes: '', ivr_config_id: '' });
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const loadDirectories = async () => {
    const r = await fetch('/api/directories');
    const d = await r.json();
    setDirectories(d.directories ?? []);
    if (d.directories?.length > 0 && !selectedDir) {
      setSelectedDir(d.directories[0].id);
    }
  };

  const loadLeads = async () => {
    const params = new URLSearchParams();
    if (selectedDir) params.set('directoryId', selectedDir);
    if (search) params.set('search', search);
    const r = await fetch(`/api/leads?${params}`);
    const d = await r.json();
    setLeads(d.leads ?? []);
  };

  useEffect(() => {
    setSelectedDir('');
    loadDirectories();
    fetch('/api/ivr-configs').then(r => r.json()).then(d => setIvrConfigs(d.configs ?? []));
  }, []);
  useEffect(() => { if (selectedDir || search) loadLeads(); }, [selectedDir, search]);

  async function saveDirectory() {
    setLoading(true);
    await fetch('/api/directories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dirForm),
    });
    setLoading(false);
    setShowDirModal(false);
    setDirForm({ name: '', description: '' });
    await loadDirectories();
  }

  async function deleteDirectory(id: string) {
    if (!confirm('Delete this directory and all its leads?')) return;
    await fetch('/api/directories', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    setSelectedDir('');
    await loadDirectories();
  }

  async function saveLead() {
    setLoading(true);
    const method = editingLead ? 'PUT' : 'POST';
    const payload = { ...leadForm, ivr_config_id: leadForm.ivr_config_id || null };
    const body = editingLead
      ? { id: editingLead.id, ...payload }
      : { directoryId: selectedDir, ...payload };
    await fetch('/api/leads', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setLoading(false);
    setShowLeadModal(false);
    setEditingLead(null);
    setLeadForm({ name: '', phone_number: '', category: '', notes: '', ivr_config_id: '' });
    await loadLeads();
  }

  async function deleteLead(id: string) {
    if (!confirm('Delete this lead?')) return;
    await fetch('/api/leads', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    await loadLeads();
  }

  async function handleCSVUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !selectedDir) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('directoryId', selectedDir);
    const r = await fetch('/api/leads/upload', { method: 'POST', body: fd });
    const d = await r.json();
    if (d.error) {
      alert(`Import failed: ${d.error}`);
    } else {
      const ivrMsg = d.ivrConfigsCreated > 0 ? ` (${d.ivrConfigsCreated} IVR configs auto-created)` : '';
      alert(`Imported ${d.imported} of ${d.total} leads${ivrMsg}`);
    }
    await loadLeads();
    await loadDirectories();
    fetch('/api/ivr-configs').then(r => r.json()).then(d => setIvrConfigs(d.configs ?? []));
    if (fileRef.current) fileRef.current.value = '';
  }

  function openEditLead(lead: Lead) {
    setEditingLead(lead);
    setLeadForm({ name: lead.name, phone_number: lead.phone_number, category: lead.category ?? '', notes: lead.notes ?? '', ivr_config_id: lead.ivr_config_id ?? '' });
    setShowLeadModal(true);
  }

  const currentDir = directories.find((d) => d.id === selectedDir);

  return (
    <div className="h-full flex flex-col">
      <div className="px-8 py-6 border-b border-gray-800 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Leads</h1>
          <p className="text-gray-400 text-sm mt-1">Manage cruise line directories and contacts</p>
        </div>
        <button
          onClick={() => setShowDirModal(true)}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Directory
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Directories sidebar */}
        <div className="w-64 border-r border-gray-800 overflow-y-auto bg-gray-900/50">
          <div className="p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-3">Directories</p>
            {directories.map((dir) => (
              <div key={dir.id} className="group relative">
                <button
                  onClick={() => setSelectedDir(dir.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-xl mb-1 transition-colors ${
                    selectedDir === dir.id ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-800'
                  }`}
                >
                  <p className="text-sm font-medium truncate">{dir.name}</p>
                  <p className="text-xs opacity-70">{dir.lead_count} leads</p>
                </button>
                <button
                  onClick={() => deleteDirectory(dir.id)}
                  className="absolute right-2 top-2.5 opacity-0 group-hover:opacity-100 text-red-500 hover:text-red-400 transition-opacity"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Leads table */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {selectedDir ? (
            <>
              <div className="px-6 py-4 border-b border-gray-800 flex items-center gap-3">
                <input
                  type="text"
                  placeholder="Search leads..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
                <input ref={fileRef} type="file" accept=".csv,.txt" onChange={handleCSVUpload} className="hidden" />
                <button
                  onClick={() => fileRef.current?.click()}
                  className="flex items-center gap-2 text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 text-sm px-3 py-2 rounded-xl transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  Import CSV
                </button>
                <button
                  onClick={() => { setEditingLead(null); setLeadForm({ name: '', phone_number: '', category: '', notes: '', ivr_config_id: '' }); setShowLeadModal(true); }}
                  className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Add Lead
                </button>
              </div>

              <div className="flex-1 overflow-y-auto">
                {leads.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-center">
                    <div className="w-16 h-16 rounded-full bg-gray-900 border border-gray-800 flex items-center justify-center mb-4">
                      <svg className="w-8 h-8 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </div>
                    <p className="text-gray-500">No leads in {currentDir?.name}</p>
                    <p className="text-gray-600 text-sm mt-1">Add leads manually or import a CSV</p>
                  </div>
                ) : (
                  <table className="w-full">
                    <thead className="sticky top-0 bg-gray-950">
                      <tr className="border-b border-gray-800">
                        <th className="text-left text-xs text-gray-500 uppercase tracking-wider px-6 py-3">Name</th>
                        <th className="text-left text-xs text-gray-500 uppercase tracking-wider px-6 py-3">Phone</th>
                        <th className="text-left text-xs text-gray-500 uppercase tracking-wider px-6 py-3">Category</th>
                        <th className="text-left text-xs text-gray-500 uppercase tracking-wider px-6 py-3">IVR Config</th>
                        <th className="px-6 py-3" />
                      </tr>
                    </thead>
                    <tbody>
                      {leads.map((lead) => (
                        <tr key={lead.id} className="border-b border-gray-800/50 hover:bg-gray-900/50 transition-colors">
                          <td className="px-6 py-4 text-sm font-medium text-white">{lead.name}</td>
                          <td className="px-6 py-4 text-sm text-gray-400 font-mono">{lead.phone_number}</td>
                          <td className="px-6 py-4">
                            {lead.category && (
                              <span className="text-xs px-2 py-1 rounded-full bg-gray-800 text-gray-400">{lead.category}</span>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            {lead.ivr_config_id ? (
                              <span className="text-xs px-2 py-1 rounded-full bg-blue-900/40 text-blue-400 border border-blue-700/50">
                                {ivrConfigs.find(c => c.id === lead.ivr_config_id)?.name ?? 'IVR set'}
                              </span>
                            ) : (
                              <span className="text-xs text-gray-600">No IVR</span>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            <div className="flex items-center gap-2 justify-end">
                              <button onClick={() => openEditLead(lead)} className="text-gray-500 hover:text-blue-400 transition-colors">
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                              </button>
                              <button onClick={() => deleteLead(lead.id)} className="text-gray-500 hover:text-red-400 transition-colors">
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-gray-600">Select a directory to view leads</p>
            </div>
          )}
        </div>
      </div>

      {/* Directory Modal */}
      {showDirModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-md">
            <h2 className="text-lg font-bold text-white mb-4">New Directory</h2>
            <div className="space-y-3">
              <input
                type="text"
                placeholder="Directory name"
                value={dirForm.name}
                onChange={(e) => setDirForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              <textarea
                placeholder="Description (optional)"
                value={dirForm.description}
                onChange={(e) => setDirForm((f) => ({ ...f, description: e.target.value }))}
                rows={2}
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
              />
            </div>
            <div className="flex gap-3 mt-4">
              <button onClick={() => setShowDirModal(false)} className="flex-1 border border-gray-700 text-gray-400 py-2.5 rounded-xl hover:text-white transition-colors text-sm">Cancel</button>
              <button onClick={saveDirectory} disabled={loading || !dirForm.name} className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors">Create</button>
            </div>
          </div>
        </div>
      )}

      {/* Lead Modal */}
      {showLeadModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-md">
            <h2 className="text-lg font-bold text-white mb-4">{editingLead ? 'Edit Lead' : 'Add Lead'}</h2>
            <div className="space-y-3">
              {[
                { key: 'name', placeholder: 'e.g. Royal Caribbean', label: 'Name' },
                { key: 'phone_number', placeholder: 'e.g. +18664627444', label: 'Phone Number' },
                { key: 'category', placeholder: 'e.g. Reservations', label: 'Category' },
              ].map(({ key, placeholder, label }) => (
                <div key={key}>
                  <label className="block text-xs text-gray-500 mb-1">{label}</label>
                  <input
                    type="text"
                    placeholder={placeholder}
                    value={leadForm[key as keyof typeof leadForm]}
                    onChange={(e) => setLeadForm((f) => ({ ...f, [key]: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                </div>
              ))}
              <div>
                <label className="block text-xs text-gray-500 mb-1">IVR Config</label>
                <select
                  value={leadForm.ivr_config_id}
                  onChange={(e) => setLeadForm((f) => ({ ...f, ivr_config_id: e.target.value }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="">None (go straight to hold)</option>
                  {ivrConfigs.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Notes</label>
                <textarea
                  placeholder="Optional notes"
                  value={leadForm.notes}
                  onChange={(e) => setLeadForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={2}
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
                />
              </div>
            </div>
            <div className="flex gap-3 mt-4">
              <button onClick={() => { setShowLeadModal(false); setEditingLead(null); }} className="flex-1 border border-gray-700 text-gray-400 py-2.5 rounded-xl hover:text-white transition-colors text-sm">Cancel</button>
              <button onClick={saveLead} disabled={loading || !leadForm.name || !leadForm.phone_number} className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white py-2.5 rounded-xl text-sm font-semibold transition-colors">
                {editingLead ? 'Save Changes' : 'Add Lead'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
