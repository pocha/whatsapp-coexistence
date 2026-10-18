import 'dotenv/config';
import { initializeApp } from 'firebase-admin/app';

initializeApp();

export { rotateKey } from './accounts';
export { numbers } from './numbersApi';
export { templates, templatesBulk } from './wabaManager';
export { onboarding } from './onboardingApi';
export { sendOtp, verifyOtp } from './otp';
export { webhook } from './webhook';
export { mcp } from './mcp/hosted';
export { joinWaitlist } from './joinWaitlist';
