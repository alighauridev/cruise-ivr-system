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
    if (!step) return;

    // If we're waiting and IVR is still speaking, extend the wait
    if (step.type === 'wait' && this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.scheduleWaitAdvance(step.duration_seconds ?? 3);
    }
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
