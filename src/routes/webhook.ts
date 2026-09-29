import { FastifyInstance } from 'fastify';
import { config } from '../config';

interface VerifyQuery {
  'hub.mode'?: string;
  'hub.verify_token'?: string;
  'hub.challenge'?: string;
}

// Meta requires an app-level webhook URL to be configured regardless of
// whether any given WABA overrides it — this is that fallback. In the real
// coexistence flow every onboarded WABA sets `override_callback_uri` (see
// onboarding.ts), so Meta delivers incoming events straight to the
// business's own server and this handler never sees them.
export default async function webhookRoutes(app: FastifyInstance) {
  app.get<{ Querystring: VerifyQuery }>('/webhook', async (request, reply) => {
    const mode = request.query['hub.mode'];
    const token = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.webhookVerifyToken) {
      return reply.code(200).send(challenge);
    }
    return reply.code(403).send('Forbidden');
  });

  app.post('/webhook', async (_request, reply) => reply.code(200).send('EVENT_RECEIVED'));
}
