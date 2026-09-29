import { FastifyInstance } from 'fastify';
import { config } from '../config';

const GRAPH_BASE = `https://graph.facebook.com/${config.graphApiVersion}`;

interface SendParams {
  phoneNumberId: string;
}

// The actual product: a stateless proxy in front of Meta's own
// /{phone-number-id}/messages endpoint. The caller supplies their OWN
// permanent WhatsApp access token (via Authorization) on every call — we
// never store it, just forward it straight through to Meta alongside their
// message body. That's what keeps this consistent with "no token storage":
// the token never outlives a single request.
//
// This is intentionally a dumb passthrough for now. Rate limiting and
// per-recipient serialization (the reasons to route sends through us at
// all, instead of calling Meta directly) are upcoming — see README.
export default async function relayRoutes(app: FastifyInstance) {
  app.post<{ Params: SendParams; Body: unknown }>(
    '/api/relay/:phoneNumberId/messages',
    async (request, reply) => {
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'Missing Authorization: Bearer <your WhatsApp access token>' });
      }

      const res = await fetch(`${GRAPH_BASE}/${request.params.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request.body),
      });

      const body = await res.json();
      return reply.code(res.status).send(body);
    },
  );
}
