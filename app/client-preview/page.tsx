'use client';

/**
 * The client's rebuild, as designed in rebuild.txt: his dark UI, his task form, his Call Logs summary.
 * The two pages are the unmodified files the patch produces (see ./_old). A scripted demo back end
 * replaces fetch / EventSource while this page is open, so nothing real is called, texted or saved.
 */
import { useLayoutEffect, useState, type CSSProperties } from 'react';
import { installDemo } from './_old/demo';
import ClientAgentPage from './_old/ClientAgentPage';
import ClientCallLogsPage from './_old/ClientCallLogsPage';
import OldSidebar, { type OldView } from './_old/OldSidebar';

const SYSTEM_SANS = 'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';

// The old look: dark scrollbars and the original pulse animation (the redesign changed the global ones).
const OLD_CSS = `
.cp-old * { scrollbar-width: auto; scrollbar-color: #374151 #111827; }
.cp-old ::-webkit-scrollbar { width: 6px; }
.cp-old ::-webkit-scrollbar-track { background: #111827; }
.cp-old ::-webkit-scrollbar-thumb { background: #374151; border-radius: 3px; border: 0; background-clip: border-box; }
.cp-old ::-webkit-scrollbar-thumb:hover { background: #4b5563; }
@keyframes cp-old-pulse { 0% { transform: scale(0.8); opacity: 1; } 100% { transform: scale(1.6); opacity: 0; } }
.cp-old .pulse-ring { animation: cp-old-pulse 1.5s ease-out infinite; }
`;

export default function ClientPreviewPage() {
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<OldView>('agent');

  // Install the demo back end before the pages mount (and put the real fetch back when leaving).
  useLayoutEffect(() => {
    const restore = installDemo();
    setReady(true);
    return () => {
      restore();
      setReady(false);
    };
  }, []);

  return (
    <div
      className="cp-old flex h-screen overflow-hidden bg-gray-950 text-gray-100 antialiased"
      style={{ fontFamily: SYSTEM_SANS, '--font-sans': SYSTEM_SANS } as CSSProperties}
    >
      <style>{OLD_CSS}</style>
      <OldSidebar view={view} onChange={setView} />

      <main className="flex-1 overflow-y-auto bg-gray-950 flex flex-col">
        <div className="flex items-center justify-between gap-6 px-8 py-2.5 bg-amber-950/60 border-b border-amber-700/50 text-amber-200">
          <p className="text-sm">
            <span className="font-semibold">Client build preview</span>
            <span className="text-amber-400/70">
              {' '}
              · the AI call agent exactly as the rebuild.txt patch built it. Simulated: no calls, texts or saves.
            </span>
          </p>
          <p className="text-xs text-amber-400/70 flex-shrink-0">
            {view === 'agent'
              ? 'Try: pick a cruise line → type a request → Place Call'
              : 'Open a row to see the AI task, outcome and summary'}
          </p>
        </div>
        <div className="flex-1 overflow-y-auto">
          {ready && (view === 'agent' ? <ClientAgentPage /> : <ClientCallLogsPage />)}
        </div>
      </main>
    </div>
  );
}
