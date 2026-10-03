// Public, non-secret Meta App config.
// META_APP_ID / META_CONFIG_ID: developers.facebook.com/apps → App Settings
// → Basic (App ID), and Facebook Login for Business → Configurations, the
// "WhatsApp Embedded Signup" one — used by the Embedded Signup popup.
export const META_APP_ID = '3291833217871706';
export const META_CONFIG_ID = '3382824061895514';

// Sent to every business's incoming-message URL during the verification
// handshake, so it is not a secret. Must equal WEBHOOK_VERIFY_TOKEN in
// functions/.env (the Functions can't import from src/). Shown on a WABA's
// page so the test chatbot can be configured.
export const WEBHOOK_VERIFY_TOKEN = 'hail_watobot';
