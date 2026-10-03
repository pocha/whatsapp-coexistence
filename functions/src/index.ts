import 'dotenv/config';
import { initializeApp } from 'firebase-admin/app';

initializeApp();

export { exchangeCode } from './exchangeCode';
export { setWebhook } from './setWebhook';
export { relayMessage } from './relayMessage';
export { webhook } from './webhook';
export { sendOtp } from './sendOtp';
export { verifyOtp } from './verifyOtp';
export { joinWaitlist } from './joinWaitlist';
