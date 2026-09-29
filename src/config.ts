import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  appId: required('META_APP_ID'),
  appSecret: required('META_APP_SECRET'),
  configId: required('META_CONFIG_ID'),
  webhookVerifyToken: required('META_WEBHOOK_VERIFY_TOKEN'),
  graphApiVersion: process.env.GRAPH_API_VERSION || 'v21.0',
  port: Number(process.env.PORT) || 3000,
  baseUrl: process.env.BASE_URL || '',
  enableTestFeatures: process.env.ENABLE_TEST_FEATURES !== 'false',
};
