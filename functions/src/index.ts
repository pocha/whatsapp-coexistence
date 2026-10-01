import 'dotenv/config';
import { initializeApp } from 'firebase-admin/app';

initializeApp();

export { checkEndpoint } from './checkEndpoint';
export { completeOnboarding } from './completeOnboarding';
export { relayMessage } from './relayMessage';
export { webhook } from './webhook';
export { sendOtp } from './sendOtp';
export { verifyOtp } from './verifyOtp';
