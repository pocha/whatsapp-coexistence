// Plain process.env config, loaded from functions/.env by `dotenv/config`
// (imported first thing in index.ts). One file, one convention, used
// identically for the emulator and deployed functions — no Secret Manager,
// no Firebase params system. Simpler, at the cost of secrets living in a
// plain-text file instead of an encrypted store; acceptable trade-off here
// since it's gitignored and only readable by whoever can already deploy.
//
// Fields are lazy getters, not eagerly read at module load: importing this
// file (even transitively) must not throw just because some *other* field
// isn't set in the current environment — e.g. unit tests import graphApi.ts
// directly, without index.ts's dotenv bootstrap, and only exercise fields
// that don't need it.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}. See functions/.env.example.`);
  return value;
}

export const config = {
  get metaAppId() {
    return required('META_APP_ID');
  },
  get metaAppSecret() {
    return required('META_APP_SECRET');
  },
  get webhookVerifyToken() {
    return required('WEBHOOK_VERIFY_TOKEN');
  },
  get watobotApiKey() {
    return required('WATOBOT_API_KEY');
  },
  graphApiVersion: 'v21.0',
};
