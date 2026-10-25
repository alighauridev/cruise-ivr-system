'use client';

import { useState, useEffect, useRef } from 'react';
import { Icon } from '@/components/icons';
import { AdminBadge, Badge, EmptyState, Modal, PageHeader } from '@/components/ui';

interface Directory {
  id: string;
  name: string;
  description: string;
  lead_count: number;
  owner_email?: string;
  owner_name?: string;
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
  const [isAdmin, setIsAdmin] = useState(false);
  const [impersonating, setImpersonating] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadDirectories = async () => {
    const r = await fetch('/api/directories');
    const d = await r.json();
    setDirectories(d.directories ?? []);
    setIsAdmin(d.isAdmin ?? false);
    setImpersonating(d.impersonating ?? false);
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
    <div className="flex h-full flex-col">
      <PageHeader
        title="Leads"
        badge={isAdmin && !impersonating ? <AdminBadge /> : undefined}
        subtitle="Manage cruise line directories and contacts"
        actions={
          <button onClick={() => setShowDirModal(true)} className="btn btn-primary">
            <Icon name="plus" className="h-4 w-4" />
            New directory
          </button>
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)] gap-5 px-10 pb-8 max-lg:grid-cols-1 max-lg:px-6">
        {/* Directories */}
        <aside className="card min-h-0 self-start overflow-y-auto p-3 max-h-full max-lg:max-h-60">
          <p className="eyebrow mb-2 px-2.5 pt-1.5">Directories</p>
          {directories.length === 0 && <p className="px-2.5 py-4 text-sm text-muted">No directories yet.</p>}
          {directories.map((dir) => {
            const selected = selectedDir === dir.id;
            return (
              <div key={dir.id} className="group relative mb-0.5">
                <button
                  onClick={() => setSelectedDir(dir.id)}
                  className={`w-full rounded-xl px-3 py-2.5 text-left transition-colors ${
                    selected ? 'bg-brand-soft ring-1 ring-brand-line' : 'hover:bg-sunken'
                  }`}
                >
                  <p className={`truncate pr-6 text-sm font-semibold ${selected ? 'text-brand-strong' : 'text-ink'}`}>{dir.name}</p>
                  <p className="mt-0.5 text-xs text-muted">{dir.lead_count} {dir.lead_count === 1 ? 'lead' : 'leads'}</p>
                  {isAdmin && dir.owner_name && <p className="mt-0.5 truncate text-xs text-faint">{dir.owner_name}</p>}
                </button>
                <button
                  onClick={() => deleteDirectory(dir.id)}
                  className="btn-icon absolute right-1.5 top-2 h-7 w-7 opacity-0 transition-opacity hover:!bg-bad-soft hover:!text-bad group-hover:opacity-100"
                  title="Delete directory"
                >
                  <Icon name="trash" className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </aside>

        {/* Leads table */}
        <section className="card flex min-h-0 flex-col overflow-hidden">
          {selectedDir ? (
            <>
              <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
                <div className="relative min-w-48 flex-1">
                  <Icon name="search" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
                  <input
                    type="text"
                    placeholder="Search leads…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="input pl-10"
                  />
                </div>
                <input ref={fileRef} type="file" accept=".csv,.txt" onChange={handleCSVUpload} className="hidden" />
                <button onClick={() => fileRef.current?.click()} className="btn btn-secondary">
                  <Icon name="upload" className="h-4 w-4" />
                  Import CSV
                </button>
                <button
                  onClick={() => { setEditingLead(null); setLeadForm({ name: '', phone_number: '', category: '', notes: '', ivr_config_id: '' }); setShowLeadModal(true); }}
                  className="btn btn-primary"
                >
                  <Icon name="plus" className="h-4 w-4" />
                  Add lead
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                {leads.length === 0 ? (
                  <EmptyState icon="users" title={`No leads in ${currentDir?.name ?? 'this directory'}`} hint="Add leads manually or import a CSV." />
                ) : (
                  <table className="w-full">
                    <thead className="sticky top-0 z-10 bg-surface">
                      <tr className="border-b border-line">
                        <th className="th">Name</th>
                        <th className="th">Phone</th>
                        <th className="th">Category</th>
                        <th className="th">IVR config</th>
                        <th className="th" />
                      </tr>
                    </thead>
                    <tbody>
                      {leads.map((lead) => (
                        <tr key={lead.id} className="group border-b border-line/70 transition-colors hover:bg-canvas">
                          <td className="td font-semibold text-ink">{lead.name}</td>
                          <td className="td font-mono text-[13px] text-muted">{lead.phone_number}</td>
                          <td className="td">{lead.category && <Badge tone="info">{lead.category}</Badge>}</td>
                          <td className="td">
                            {lead.ivr_config_id ? (
                              <Badge tone="brand">{ivrConfigs.find((c) => c.id === lead.ivr_config_id)?.name ?? 'IVR set'}</Badge>
                            ) : (
                              <span className="text-xs text-faint">No IVR</span>
                            )}
                          </td>
                          <td className="td">
                            <div className="flex items-center justify-end gap-1 opacity-60 transition-opacity group-hover:opacity-100">
                              <button onClick={() => openEditLead(lead)} className="btn-icon hover:!text-brand" title="Edit">
                                <Icon name="edit" className="h-4 w-4" />
                              </button>
                              <button onClick={() => deleteLead(lead.id)} className="btn-icon hover:!bg-bad-soft hover:!text-bad" title="Delete">
                                <Icon name="trash" className="h-4 w-4" />
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
            <EmptyState icon="users" title="Select a directory" hint="Pick a directory on the left to see its leads." />
          )}
        </section>
      </div>

      {/* Directory Modal */}
      {showDirModal && (
        <Modal
          title="New directory"
          onClose={() => setShowDirModal(false)}
          footer={
            <>
              <button onClick={() => setShowDirModal(false)} className="btn btn-secondary flex-1">Cancel</button>
              <button onClick={saveDirectory} disabled={loading || !dirForm.name} className="btn btn-primary flex-1">Create</button>
            </>
          }
        >
          <div>
            <label className="field-label">Name</label>
            <input
              type="text"
              placeholder="Directory name"
              value={dirForm.name}
              onChange={(e) => setDirForm((f) => ({ ...f, name: e.target.value }))}
              className="input"
              autoFocus
            />
          </div>
          <div>
            <label className="field-label">Description</label>
            <textarea
              placeholder="Description (optional)"
              value={dirForm.description}
              onChange={(e) => setDirForm((f) => ({ ...f, description: e.target.value }))}
              rows={2}
              className="input"
            />
          </div>
        </Modal>
      )}

      {/* Lead Modal */}
      {showLeadModal && (
        <Modal
          title={editingLead ? 'Edit lead' : 'Add lead'}
          onClose={() => { setShowLeadModal(false); setEditingLead(null); }}
          footer={
            <>
              <button onClick={() => { setShowLeadModal(false); setEditingLead(null); }} className="btn btn-secondary flex-1">Cancel</button>
              <button onClick={saveLead} disabled={loading || !leadForm.name || !leadForm.phone_number} className="btn btn-primary flex-1">
                {editingLead ? 'Save changes' : 'Add lead'}
              </button>
            </>
          }
        >
          {[
            { key: 'name', placeholder: 'e.g. Royal Caribbean', label: 'Name' },
            { key: 'phone_number', placeholder: 'e.g. +18664627444', label: 'Phone number' },
            { key: 'category', placeholder: 'e.g. Reservations', label: 'Category' },
          ].map(({ key, placeholder, label }) => (
            <div key={key}>
              <label className="field-label">{label}</label>
              <input
                type="text"
                placeholder={placeholder}
                value={leadForm[key as keyof typeof leadForm]}
                onChange={(e) => setLeadForm((f) => ({ ...f, [key]: e.target.value }))}
                className="input"
              />
            </div>
          ))}
          <div>
            <label className="field-label">IVR config</label>
            <select value={leadForm.ivr_config_id} onChange={(e) => setLeadForm((f) => ({ ...f, ivr_config_id: e.target.value }))} className="input">
              <option value="">None (go straight to hold)</option>
              {ivrConfigs.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label">Notes</label>
            <textarea
              placeholder="Optional notes"
              value={leadForm.notes}
              onChange={(e) => setLeadForm((f) => ({ ...f, notes: e.target.value }))}
              rows={2}
              className="input"
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
