// Sends the login OTP over WhatsApp via watobot.xyz (mudbot), so login needs
// no email/Facebook — just a WhatsApp number the business already has.
// https://github.com/pocha/mudbot
const WATOBOT_BASE = process.env.WATOBOT_API_BASE || 'https://api.watobot.xyz';

export async function sendWhatsappMessage(apiKey: string, to: string, message: string): Promise<void> {
  const res = await fetch(`${WATOBOT_BASE}/api/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ to, message }),
    // watobot queues messages per-account to avoid WhatsApp spam detection
    // (see mudbot's docs), so a send can genuinely take ~60s — this needs
    // real headroom above that, not a generic request timeout.
    signal: AbortSignal.timeout(75_000),
  });

  const body = (await res.json().catch(() => ({}))) as { success?: boolean; reason?: string };
  if (!res.ok || !body.success) {
    throw new Error(`watobot send failed: ${res.status} ${body.reason ?? JSON.stringify(body)}`);
  }
}
