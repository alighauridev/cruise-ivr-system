import type { ReactNode } from 'react';
import { BrandMark, Icon, type IconName } from './icons';

const POINTS: Array<{ icon: IconName; title: string; text: string }> = [
  { icon: 'flow', title: 'Walks the phone menu', text: 'Presses the right keys so you never sit through the prompts.' },
  { icon: 'clock', title: 'Waits on hold for you', text: 'Listens for a real person and ignores the hold music.' },
  { icon: 'spark', title: 'Handles the routine asks', text: 'An AI assistant can take waitlist and status requests end to end.' },
];

export default function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="grid min-h-screen bg-canvas lg:grid-cols-[1.05fr_1fr]">
      {/* Calm brand panel */}
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-[#f3dfcf] to-[#e8bf9f] lg:flex lg:flex-col lg:justify-between lg:p-14">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="drift absolute -right-24 -top-24 h-[420px] w-[420px] rounded-full bg-white/50" />
          <div className="drift absolute -bottom-44 left-24 h-[360px] w-[360px] rounded-full bg-brand/10 [animation-delay:-4s]" />
          <div className="absolute right-16 top-1/2 h-48 w-48 rounded-full border border-brand/20" />
          <div className="absolute right-6 top-[calc(50%-40px)] h-72 w-72 rounded-full border border-brand/10" />
        </div>

        <div className="relative flex items-center gap-3">
          <BrandMark className="h-10 w-10" />
          <span className="font-display text-xl font-medium text-ink">CruisePro</span>
        </div>

        <div className="relative max-w-md">
          <h2 className="font-display text-[44px] font-normal leading-[1.08] tracking-tight text-ink">
            Skip the hold music.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-body">
            CruisePro waits on hold with the cruise line and brings you in only when a real person picks up.
          </p>
          <ul className="mt-10 space-y-5">
            {POINTS.map((p) => (
              <li key={p.title} className="flex gap-4">
                <span className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-white/70 text-brand">
                  <Icon name={p.icon} className="h-[18px] w-[18px]" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-ink">{p.title}</p>
                  <p className="text-sm text-body/80">{p.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-body/60">Outbound calling for travel advisors.</p>
      </aside>

      {/* Form */}
      <main className="flex items-center justify-center px-6 py-12">
        <div className="rise w-full max-w-[400px]">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <BrandMark className="h-10 w-10" />
            <span className="font-display text-xl font-medium text-ink">CruisePro</span>
          </div>
          <h1 className="font-display text-[34px] font-medium leading-tight tracking-tight text-ink">{title}</h1>
          <p className="mb-8 mt-2 text-sm text-muted">{subtitle}</p>
          {children}
        </div>
      </main>
    </div>
  );
}
