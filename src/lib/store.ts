// Process-memory only, on purpose: onboarding access tokens are held just
// long enough for this demo's test buttons (send message / create template)
// to work, and vanish on restart. Nothing here is written to disk or a DB.

interface OnboardedWaba {
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
}

const wabasByPhoneNumberId = new Map<string, OnboardedWaba>();

export function saveOnboardedWaba(waba: OnboardedWaba): void {
  wabasByPhoneNumberId.set(waba.phoneNumberId, waba);
}

export function getOnboardedWaba(phoneNumberId: string): OnboardedWaba | undefined {
  return wabasByPhoneNumberId.get(phoneNumberId);
}

export function listOnboardedWabas(): OnboardedWaba[] {
  return Array.from(wabasByPhoneNumberId.values());
}

const webhookLog: unknown[] = [];
const MAX_LOG_ENTRIES = 50;

export function recordWebhookEvent(event: unknown): void {
  webhookLog.unshift({ receivedAt: new Date().toISOString(), event });
  webhookLog.length = Math.min(webhookLog.length, MAX_LOG_ENTRIES);
}

export function getWebhookLog(): unknown[] {
  return webhookLog;
}
