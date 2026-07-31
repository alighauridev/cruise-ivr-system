import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID!;
const authToken = process.env.TWILIO_AUTH_TOKEN!;

export const twilioClient = twilio(accountSid, authToken);
export const twilioPhone = process.env.TWILIO_PHONE_NUMBER!;

export async function placeOutboundCall(toNumber: string, twimlUrl: string, statusCallbackUrl: string) {
  const call = await twilioClient.calls.create({
    to: toNumber,
    from: twilioPhone,
    url: twimlUrl,
    statusCallback: statusCallbackUrl,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    statusCallbackMethod: 'POST',
    record: process.env.CALL_RECORDING_ENABLED === 'true',
  });
  return call;
}

export async function sendSMS(to: string, body: string) {
  return twilioClient.messages.create({
    to,
    from: twilioPhone,
    body,
  });
}

export async function sendDTMF(callSid: string, digits: string) {
  return twilioClient.calls(callSid).update({
    twiml: `<Response><Play digits="${digits}"/><Pause length="2"/></Response>`,
  });
}

export async function endCall(callSid: string) {
  return twilioClient.calls(callSid).update({ status: 'completed' });
}

export function validateTwilioRequest(signature: string, url: string, params: Record<string, string>) {
  return twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN!, signature, url, params);
}
