import { sendSMS } from './twilio';

export async function notifyAgentDetected(callId: string, toPhone: string, appUrl: string) {
  const connectUrl = `${appUrl}/dashboard/agent?callId=${callId}&action=connect`;
  const message = `CruisePro Alert: A live cruise line agent has answered! Click to connect now: ${connectUrl} — Reply STOP to unsubscribe.`;

  if (process.env.NOTIFICATION_SMS_ENABLED === 'true' && toPhone) {
    await sendSMS(toPhone, message);
  }

  return { sent: true, phone: toPhone };
}

export async function notifyCallFailed(toPhone: string, cruiseLine: string) {
  const message = `CruisePro: Your call to ${cruiseLine} could not be completed. Please try again from your dashboard.`;
  if (process.env.NOTIFICATION_SMS_ENABLED === 'true' && toPhone) {
    await sendSMS(toPhone, message);
  }
}
