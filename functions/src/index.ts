import 'dotenv/config';
import { initializeApp } from 'firebase-admin/app';

initializeApp();

export { exchangeCode, rotateKey } from './accounts';
export { setWebhook, registerNumber, deregisterNumber, disconnectNumber, relayMessage, templates } from './wabaManager';
export { sendOtp, verifyOtp } from './otp';
export { webhook } from './webhook';
export {
  checkCallbackUrl,
  sendTestEvents,
  setOnboardingStep,
  startSync,
  verifyTestCodes,
} from './onboarding';
export { listNumbers, getNumber } from './numbers';
export { joinWaitlist } from './joinWaitlist';
