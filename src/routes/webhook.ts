import { FastifyInstance } from 'fastify';
import { config } from '../config';
import { recordWebhookEvent, getWebhookLog } from '../lib/store';

interface VerifyQuery {
  'hub.mode'?: string;
  'hub.verify_token'?: string;
  'hub.challenge'?: string;
}

export default async function webhookRoutes(app: FastifyInstance) {
  // Meta's webhook verification handshake (run once when you register this
  // URL as a webhook in the App Dashboard).
  app.get<{ Querystring: VerifyQuery }>('/webhook', async (request, reply) => {
    const mode = request.query['hub.mode'];
    const token = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.webhookVerifyToken) {
      return reply.code(200).send(challenge);
    }
    return reply.code(403).send('Forbidden');
  });

  // Receives message/status/coexistence events for any WABA that wasn't
  // overridden to a customer's own webhook. Just logs them in memory so the
  // demo UI can display "a message came in" during testing.
  app.post('/webhook', async (request, reply) => {
    recordWebhookEvent(request.body);
    return reply.code(200).send('EVENT_RECEIVED');
  });

  app.get('/api/webhook/log', async () => getWebhookLog());
}
