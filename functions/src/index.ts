import 'dotenv/config';
import { initializeApp } from 'firebase-admin/app';

initializeApp();

export { exchangeCode, rotateKey } from './accounts';
export { setWebhook, registerNumber, relayMessage, templates } from './wabaManager';
export { sendOtp, verifyOtp } from './otp';
export { webhook } from './webhook';
export {
  checkCallbackUrl,
  deregisterNumber,
  disconnectNumber,
  sendTestEvents,
  setOnboardingStep,
  startSync,
  verifyTestCodes,
} from './onboarding';
export { joinWaitlist } from './joinWaitlist';
