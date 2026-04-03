export type IVRStepType = 'wait' | 'dtmf' | 'voice' | 'hold';

export interface IVRStep {
  order: number;
  type: IVRStepType;
  duration_seconds?: number;
  digit?: string;
  phrase?: string;
  description: string;
}

export interface IVRConfig {
  id: string;
  name: string;
  steps: IVRStep[];
}

/**
 * Builds a TwiML response that executes an IVR step.
 * Returns the TwiML XML string.
 */
export function buildStepTwiML(step: IVRStep, nextUrl: string): string {
  switch (step.type) {
    case 'wait':
      return `<Response>
  <Pause length="${step.duration_seconds ?? 3}"/>
  <Redirect>${nextUrl}</Redirect>
</Response>`;

    case 'dtmf':
      return `<Response>
  <Play digits="${step.digit}"/>
  <Pause length="1"/>
  <Redirect>${nextUrl}</Redirect>
</Response>`;

    case 'voice':
      return `<Response>
  <Say voice="alice">${step.phrase}</Say>
  <Pause length="1"/>
  <Redirect>${nextUrl}</Redirect>
</Response>`;

    case 'hold':
      // Start media stream for agent detection and play hold music loop
      return `<Response>
  <Start>
    <Stream url="${process.env.NEXTAUTH_URL}/api/calls/hold-detect" />
  </Start>
  <Pause length="3600"/>
</Response>`;

    default:
      return `<Response><Redirect>${nextUrl}</Redirect></Response>`;
  }
}

/**
 * Builds complete IVR TwiML that chains all steps via redirects.
 */
export function buildIVRStepUrl(baseUrl: string, callId: string, stepIndex: number): string {
  return `${baseUrl}/api/calls/ivr-handler?callId=${callId}&amp;step=${stepIndex}`;
}
