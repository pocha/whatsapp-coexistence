import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config';
import onboardingRoutes from './routes/onboarding';
import webhookRoutes from './routes/webhook';
import testRoutes from './routes/test';

const app = Fastify({ logger: true });

app.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'public'),
});

app.register(onboardingRoutes);
app.register(webhookRoutes);
if (config.enableTestFeatures) {
  app.register(testRoutes);
}

app.listen({ port: config.port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
