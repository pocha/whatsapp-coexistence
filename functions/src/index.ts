import 'dotenv/config';
import { initializeApp } from 'firebase-admin/app';

initializeApp();

export { exchangeCode, rotateKey } from './accounts';
export { setDisplayName, setWebhook, registerNumber, deregisterNumber, disconnectNumber, relayMessage, templates } from './wabaManager';
export { sendOtp, verifyOtp } from './otp';
export { webhook } from './webhook';
export {
  checkCallbackUrl,
  sendTestEvents,
  setOnboardingStep,
  skipSync,
  startSync,
  verifyTestCodes,
} from './onboarding';
export { mcp } from './mcp/hosted';
export { listNumbers, getNumber } from './numbers';
export { joinWaitlist } from './joinWaitlist';
