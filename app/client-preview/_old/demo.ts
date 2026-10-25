/**
 * Simulated back end for the client-build preview. While the preview is mounted, fetch() and EventSource are
 * replaced so the client's original pages run end to end on scripted data: no real calls, texts or database writes.
 */

type Msg = Record<string, unknown>;
type Ev = { id: string; event_type: string; details: Record<string, unknown>; created_at: string };

const LEADS = [
  { id: 'l1', name: 'Royal Caribbean', phone_number: '+18664627444', category: 'Reservations', directory_name: 'Major lines', ivr_config_id: 'c1', notes: '', directory_id: 'd1' },
  { id: 'l2', name: 'Carnival Cruise Line', phone_number: '+18007642519', category: 'Existing booking', directory_name: 'Major lines', ivr_config_id: 'c2', notes: '', directory_id: 'd1' },
  { id: 'l3', name: 'Norwegian Cruise Line', phone_number: '+18663379300', category: 'Reservations', directory_name: 'Major lines', ivr_config_id: null, notes: '', directory_id: 'd1' },
  { id: 'l4', name: 'Holland America', phone_number: '+18778324332', category: 'Agents desk', directory_name: 'Premium', ivr_config_id: null, notes: '', directory_id: 'd1' },
  { id: 'l5', name: 'Princess Cruises', phone_number: '+18007748000', category: 'Reservations', directory_name: 'Premium', ivr_config_id: 'c1', notes: '', directory_id: 'd1' },
];

const IVR_CONFIGS = [
  { id: 'c1', name: 'Royal Caribbean - Reservations', lead_name: 'Royal Caribbean' },
  { id: 'c2', name: 'Carnival - Existing booking', lead_name: 'Carnival' },
];

const SETTINGS = {
  user: {
    name: 'Demo User',
    email: 'demo@example.com',
    transfer_phone: '+15551234567',
    notification_preference: 'sms',
    notification_phone: '+15551234567',
    transfer_numbers: [
      { id: 't1', name: 'Mitch', phone: '+15551234567', isDefault: true },
      { id: 't2', name: 'Ali', phone: '+15559876543', isDefault: false },
    ],
    connect_message: null,
  },
  settings: { auto_callback_enabled: 'false' },
};

const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString();

const CALLS = [
  {
    id: 'a', lead_name: 'Royal Caribbean', lead_phone: '+18664627444', cruise_line_number: '+18664627444', status: 'completed',
    hold_duration_seconds: 842, total_duration_seconds: 1010, created_at: ago(30), agent_detected_time: ago(16), error_message: null,
    ai_task: 'Add the guest to a waitlist — booking CCL-4821907 — guest James Carter — Add the guests to the waitlist for the Alaska glacier tour',
    ai_outcome: 'resolved',
    ai_summary: 'Asked Dana at Royal Caribbean to add James Carter (booking CCL-4821907) to the Alaska glacier tour waitlist. She confirmed waitlist position 3 and said a confirmation email is on its way.',
    recording_url: null,
    transcript: { utterances: [
      { speaker: 0, text: 'Thank you for calling, this is Dana. How can I help you?', start: 3, end: 6 },
      { speaker: 1, text: 'Hi Dana, this is an AI assistant calling for Mitch at Military Cruise Deals. I am calling about booking CCL-4821907 to add the guests to the waitlist for the Alaska glacier tour.', start: 7, end: 15 },
      { speaker: 0, text: 'Sure. Can you give me the lead guest name?', start: 17, end: 20 },
      { speaker: 1, text: 'The lead guest is James Carter.', start: 21, end: 23 },
      { speaker: 0, text: 'Done. They are number 3 on the waitlist and a confirmation email is on its way.', start: 30, end: 35 },
      { speaker: 1, text: 'Wonderful, thank you so much Dana. Have a great day!', start: 36, end: 40 },
    ] },
  },
  {
    id: 'b', lead_name: 'Carnival Cruise Line', lead_phone: '+18007642519', cruise_line_number: '+18007642519', status: 'completed',
    hold_duration_seconds: 410, total_duration_seconds: 560, created_at: ago(120), agent_detected_time: ago(110), error_message: null,
    ai_task: 'Check the status of a booking or request — booking C7731204 — Is the upgrade request approved?',
    ai_outcome: 'handed_off',
    ai_summary: 'The rep asked for the guest’s card number to confirm the upgrade price. The AI does not handle payment details, so it handed the call to the team.',
    recording_url: null, transcript: null,
  },
  {
    id: 'c', lead_name: 'Norwegian Cruise Line', lead_phone: '+18663379300', cruise_line_number: '+18663379300', status: 'completed',
    hold_duration_seconds: 95, total_duration_seconds: 140, created_at: ago(400), agent_detected_time: ago(398), error_message: null,
    ai_task: 'Resend a confirmation or documents — booking N5520987',
    ai_outcome: 'rep_refused_ai',
    ai_summary: 'The rep said they could not work with an AI assistant and asked to speak to the travel advisor. Nothing was changed on the booking.',
    recording_url: null, transcript: null,
  },
  {
    id: 'd', lead_name: 'Holland America', lead_phone: '+18778324332', cruise_line_number: '+18778324332', status: 'failed',
    hold_duration_seconds: null, total_duration_seconds: 12, created_at: ago(900), agent_detected_time: null, error_message: 'No answer',
    ai_task: null, ai_outcome: null, ai_summary: null, recording_url: null, transcript: null,
  },
  {
    id: 'e', lead_name: 'Princess Cruises', lead_phone: '+18007748000', cruise_line_number: '+18007748000', status: 'cancelled',
    hold_duration_seconds: 45, total_duration_seconds: 60, created_at: ago(1500), agent_detected_time: null, error_message: null,
    ai_task: null, ai_outcome: null, ai_summary: null, recording_url: null, transcript: null,
  },
];

export function installDemo(): () => void {
  const realFetch = window.fetch;
  const RealEventSource = window.EventSource;

  let listener: ((m: Msg) => void) | null = null;
  let timers: ReturnType<typeof setTimeout>[] = [];
  let form: Record<string, string> | null = null;
  let status = 'initiating';
  let holdStart = 0;
  let seq = 0;

  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
  const at = (seconds: number, fn: () => void) => timers.push(setTimeout(fn, seconds * 1000));
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
  const holdSeconds = () => (holdStart ? Math.round((Date.now() - holdStart) / 1000) : 0);

  const push = (event_type: string, details: Record<string, unknown>, nextStatus?: string) => {
    if (nextStatus) status = nextStatus;
    if (status === 'on_hold' && !holdStart) holdStart = Date.now();
    const event: Ev = { id: `demo-${++seq}`, event_type, details, created_at: new Date().toISOString() };
    listener?.({ type: 'event', event, call: { status, hold_duration_seconds: holdSeconds() } });
  };

  const setStatus = (next: string) => {
    status = next;
    listener?.({ type: 'status', call: { status, hold_duration_seconds: holdSeconds() } });
  };

  /** The scripted call: dial, walk the menu, hold, agent picks up, then the AI task (or manual transfer). */
  function runCall() {
    clearTimers();
    status = 'initiating';
    holdStart = 0;
    const f = form ?? {};
    const hasTask = !!f.request?.trim();
    const advisor = f.agentName?.trim() || 'your advisor';
    const booking = f.bookingNumber?.trim();
    const guest = f.guestName?.trim();

    at(1, () => push('call_initiated', {}));
    at(3, () => push('ivr_step_0', { step: { type: 'wait', description: 'Wait for IVR greeting' } }, 'navigating_ivr'));
    at(4.5, () => push('transcript', { text: 'Thank you for calling. For reservations, press one. For existing bookings, press two.' }));
    at(6, () => push('ivr_step_1', { step: { type: 'dtmf', description: 'Press 1 for Reservations' } }));
    at(6.5, () => push('ai_action', { action: 'PRESS', digit: '1' }));
    at(9, () => push('transcript', { text: 'Your call is important to us. Please continue to hold, the next available agent will be with you shortly.' }));
    at(10, () => push('entered_hold', {}, 'on_hold'));
    at(17, () => push('agent_detected', { transcript: 'Thank you for holding, this is Dana. How can I help you?' }, 'agent_detected'));

    if (!hasTask) return; // no AI task: the page offers "Transfer to Me" and the user takes over

    const ai = (text: string) => push('conversation_ai_say', { text });
    const rep = (text: string) => push('conversation_transcript', { text, speaker: 'agent' });
    at(19, () => setStatus('ai_conversation'));
    at(20, () => ai(`Hi Dana, this is an AI assistant calling for ${advisor} at Military Cruise Deals.${booking ? ` I'm calling about booking ${booking}.` : ''} ${f.request.trim()}`));
    at(26, () => rep(guest ? 'Sure. Can I get the lead guest name on the booking?' : 'Sure. Let me pull that up. One moment.'));
    at(29, () => guest && ai(`The lead guest is ${guest}.`));
    at(35, () => rep('Okay, I have it done. Is there anything else I can help with?'));
    at(38, () => ai('That is everything. Thank you so much, Dana. Have a great day!'));
    at(42, () => push('ai_outcome', { outcome: 'resolved', summary: `The rep completed the request: ${f.request.trim()}` }));
    at(44, () => setStatus('completed'));
  }

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = (() => { try { return JSON.parse(String(init?.body ?? '{}')); } catch { return {}; } })();

    if (url.includes('/api/calls/initiate')) {
      form = body.aiTaskDetails ?? null;
      return json({ callId: 'demo-call', twilioSid: 'CAdemo', status: 'initiating' });
    }
    if (url.includes('/api/calls/end')) { clearTimers(); return json({ ok: true }); }
    if (url.includes('/api/calls/transfer')) {
      push('transfer_initiated', {}, 'transferring');
      at(2, () => setStatus('connected'));
      return json({ ok: true });
    }
    if (url.includes('/api/calls/press')) { push('ai_action', { action: 'PRESS', digit: body.digit }); return json({ ok: true }); }
    if (url.includes('/api/calls/speak')) {
      push('conversation_ai_say', { text: String(body.text ?? '') });
      at(3, () => push('conversation_transcript', { text: 'Okay, understood. Give me one second.', speaker: 'agent' }));
      return json({ ok: true });
    }
    if (url.includes('/api/calls/ai-respond')) {
      at(1.5, () => push('conversation_ai_say', { text: 'Thanks. Could you confirm that for me once more, please?' }));
      return json({ ok: true });
    }
    if (url.includes('/api/calls')) return json({ calls: CALLS, total: CALLS.length, isAdmin: false, impersonating: false });
    if (url.includes('/api/leads')) return json({ leads: LEADS, isAdmin: false });
    if (url.includes('/api/ivr-configs')) return json({ configs: IVR_CONFIGS });
    if (url.includes('/api/settings')) return json(SETTINGS);
    if (url.startsWith('/api/')) return json({});
    return realFetch(input, init);
  }) as typeof window.fetch;

  class DemoEventSource {
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      listener = (m) => this.onmessage?.({ data: JSON.stringify(m) });
      setTimeout(() => listener?.({ type: 'snapshot', events: [], call: { status: 'initiating', hold_duration_seconds: 0 } }), 100);
      runCall();
    }
    close() {
      listener = null;
    }
  }
  (window as unknown as { EventSource: unknown }).EventSource = DemoEventSource;

  return () => {
    clearTimers();
    listener = null;
    window.fetch = realFetch;
    (window as unknown as { EventSource: unknown }).EventSource = RealEventSource;
  };
}
