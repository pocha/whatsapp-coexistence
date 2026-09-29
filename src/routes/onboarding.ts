import { FastifyInstance } from 'fastify';
import { config } from '../config';
import { exchangeCodeForToken, subscribeApp } from '../lib/graphApi';
import { saveOnboardedWaba } from '../lib/store';

interface CompleteBody {
  code: string;
  wabaId: string;
  phoneNumberId: string;
  overrideCallbackUrl?: string;
}

export default async function onboardingRoutes(app: FastifyInstance) {
  // Public, non-secret config the frontend needs to init the Facebook JS SDK
  // and start Embedded Signup.
  app.get('/api/config', async () => ({
    appId: config.appId,
    configId: config.configId,
    baseUrl: config.baseUrl,
  }));

  // Runs after Embedded Signup hands the frontend a `code` + the new WABA's
  // ids. Exchanges the code for an access token, then subscribes this app to
  // the WABA — optionally overriding the webhook straight to the customer's
  // own URL, which is the whole point of the "onboard, then get out of the
  // message path" model.
  app.post<{ Body: CompleteBody }>('/api/onboarding/complete', async (request, reply) => {
    const { code, wabaId, phoneNumberId, overrideCallbackUrl } = request.body;
    if (!code || !wabaId || !phoneNumberId) {
      return reply.code(400).send({ error: 'code, wabaId and phoneNumberId are required' });
    }

    const accessToken = await exchangeCodeForToken(code);
    await subscribeApp(wabaId, accessToken, overrideCallbackUrl);

    if (config.enableTestFeatures) {
      // Kept only so the test-message / create-template buttons below have
      // something to call with. Remove this branch (or set
      // ENABLE_TEST_FEATURES=false) once you're done recording App Review
      // videos — the token isn't needed for the onboarding flow itself.
      saveOnboardedWaba({ wabaId, phoneNumberId, accessToken });
    }

    return { ok: true, wabaId, phoneNumberId, overridden: Boolean(overrideCallbackUrl) };
  });
}
