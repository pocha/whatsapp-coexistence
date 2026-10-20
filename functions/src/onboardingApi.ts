import { onRequest } from 'firebase-functions/v2/https';
import { handle, newApp, numberRoute } from './helpers/http';
import { checkCallbackUrl, sendTestEvents, setOnboardingStep, skipSync, startSync, verifyTestCodes } from './onboarding';

// /onboarding: the wizard. The three checks come before there is a number, so they take the dashboard's
// sign-in or the key in the body. The rest are about one number and take the key as the bearer token.
//
//   POST /onboarding/callback-check       does Meta's handshake against a callback URL
//   POST /onboarding/test-events          posts a test event of each kind to it, with fresh codes
//   POST /onboarding/test-codes           says which typed codes match the last send
//   PUT  /onboarding/<id>/step            moves the wizard on
//   POST /onboarding/<id>/sync            requests the contacts or the history sync
//   POST /onboarding/<id>/sync/skip       skips both syncs

const app = newApp();
app.post('/callback-check', handle(checkCallbackUrl));
app.post('/test-events', handle(sendTestEvents));
app.post('/test-codes', handle(verifyTestCodes));
app.put('/:phoneNumberId/step', numberRoute(setOnboardingStep, { keyRequired: true }));
app.post('/:phoneNumberId/sync', numberRoute(startSync, { keyRequired: true }));
app.post('/:phoneNumberId/sync/skip', numberRoute(skipSync, { keyRequired: true }));

export const onboarding = onRequest(app);
