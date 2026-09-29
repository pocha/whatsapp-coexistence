import { FastifyInstance } from 'fastify';
import { getOnboardedWaba, listOnboardedWabas } from '../lib/store';
import { sendTextMessage, createMessageTemplate } from '../lib/graphApi';

interface SendMessageBody {
  phoneNumberId: string;
  to: string;
  text: string;
}

interface CreateTemplateBody {
  wabaId: string;
  phoneNumberId: string;
  name: string;
  category: string;
  language: string;
  bodyText: string;
}

// Only wired up when ENABLE_TEST_FEATURES=true (src/config.ts). These exist
// solely so you have something to point the camera at for Meta's two
// required App Review videos (send a message, create a template) — see
// README.md. Not part of the onboarding product itself.
export default async function testRoutes(app: FastifyInstance) {
  app.get('/api/test/wabas', async () => listOnboardedWabas().map(({ accessToken, ...rest }) => rest));

  app.post<{ Body: SendMessageBody }>('/api/test/send-message', async (request, reply) => {
    const { phoneNumberId, to, text } = request.body;
    const waba = getOnboardedWaba(phoneNumberId);
    if (!waba) return reply.code(404).send({ error: 'Unknown phoneNumberId — complete onboarding first' });

    const result = await sendTextMessage(phoneNumberId, waba.accessToken, to, text);
    return { ok: true, result };
  });

  app.post<{ Body: CreateTemplateBody }>('/api/test/create-template', async (request, reply) => {
    const { wabaId, phoneNumberId, name, category, language, bodyText } = request.body;
    const waba = getOnboardedWaba(phoneNumberId);
    if (!waba) return reply.code(404).send({ error: 'Unknown phoneNumberId — complete onboarding first' });

    const result = await createMessageTemplate(wabaId, waba.accessToken, {
      name,
      category,
      language,
      bodyText,
    });
    return { ok: true, result };
  });
}
