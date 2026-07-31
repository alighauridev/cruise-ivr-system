import { IVRStep } from '@/lib/ivr-engine';

export type ExecutorAction =
  | { type: 'PRESS'; digit: string }
  | { type: 'SAY'; phrase: string }
  | { type: 'ENTER_HOLD_MODE' };

type ExecutorMode = 'executing' | 'hold' | 'done';

export class IVRExecutor {
  private steps: IVRStep[];
  private currentIndex = 0;
  private mode: ExecutorMode = 'executing';
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private waitStepStartedAt = 0; // timestamp when current wait step began
  private onAction: (action: ExecutorAction) => Promise<void>;
  private onStepLog: (stepIndex: number, step: IVRStep) => Promise<void>;

  constructor(
    steps: IVRStep[],
    onAction: (action: ExecutorAction) => Promise<void>,
    onStepLog: (stepIndex: number, step: IVRStep) => Promise<void>
  ) {
    // Sort steps by order field to ensure correct sequence
    this.steps = [...steps].sort((a, b) => a.order - b.order);
    this.onAction = onAction;
    this.onStepLog = onStepLog;
  }

  start(): void {
    if (this.steps.length === 0) {
      this.mode = 'done';
      return;
    }
    this.executeStep(0);
  }

  /** Called by media-ws on every speech_final transcript */
  onTranscript(transcript: string): void {
    if (this.mode !== 'executing') return;
    const step = this.steps[this.currentIndex];
    if (!step || step.type !== 'wait' || !this.waitTimer) return;

    // Extend the wait only if the IVR spoke BEFORE the configured duration elapsed.
    // This handles long IVR greetings (e.g., 46s intro before "How can I help?").
    // Once the configured time has passed, the IVR is giving timeout prompts because
    // we aren't responding — don't extend, let the timer fire so SPEAK can execute.
    const elapsed = Date.now() - this.waitStepStartedAt;
    const configuredMs = (step.duration_seconds ?? 3) * 1000;

    if (elapsed < configuredMs) {
      // IVR still giving its initial greeting — extend by 3.5s to let it finish
      clearTimeout(this.waitTimer);
      this.waitTimer = setTimeout(() => {
        this.waitTimer = null;
        this.executeStep(this.currentIndex + 1);
      }, 3500);
    }
    // If elapsed >= configuredMs: IVR is prompting because it heard silence from us.
    // Do NOT extend — the timer will fire shortly and SPEAK will execute.
  }

  isInHoldMode(): boolean {
    return this.mode === 'hold';
  }

  isDone(): boolean {
    return this.mode === 'done';
  }

  destroy(): void {
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
    this.mode = 'done';
  }

  private async executeStep(index: number): Promise<void> {
    if (this.mode === 'done') return;
    if (index >= this.steps.length) {
      // All steps done with no hold step — enter hold mode by default
      this.mode = 'hold';
      await this.onAction({ type: 'ENTER_HOLD_MODE' }).catch(() => {});
      return;
    }

    this.currentIndex = index;
    const step = this.steps[index];

    console.log(`[IVRExecutor] Step ${index} type=${step.type} desc="${step.description}"`);
    await this.onStepLog(index, step).catch(() => {});

    switch (step.type) {
      case 'wait': {
        const secs = step.duration_seconds ?? 3;
        this.waitStepStartedAt = Date.now();
        this.scheduleWaitAdvance(secs);
        break;
      }

      case 'dtmf': {
        const digit = step.digit ?? '1';
        await this.onAction({ type: 'PRESS', digit }).catch(() => {});
        // Short pause after DTMF before advancing
        this.waitTimer = setTimeout(() => {
          this.waitTimer = null;
          this.executeStep(index + 1);
        }, 1200);
        break;
      }

      case 'voice': {
        const phrase = step.phrase ?? '';
        await this.onAction({ type: 'SAY', phrase }).catch(() => {});
        // Wait approximate playback time before advancing
        const delayMs = Math.max(2000, phrase.length * 80 + 1500);
        this.waitTimer = setTimeout(() => {
          this.waitTimer = null;
          this.executeStep(index + 1);
        }, delayMs);
        break;
      }

      case 'hold': {
        this.mode = 'hold';
        await this.onAction({ type: 'ENTER_HOLD_MODE' }).catch(() => {});
        // No more auto-advancing — agent/voicemail detection takes over
        break;
      }

      default:
        // Unknown step type — skip
        this.executeStep(index + 1);
    }
  }

  private scheduleWaitAdvance(seconds: number): void {
    this.waitTimer = setTimeout(() => {
      this.waitTimer = null;
      this.executeStep(this.currentIndex + 1);
    }, seconds * 1000);
  }
}
