import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextStep } from './onboarding';
import type { PhoneNumberDoc } from './types';

const doc = (over: Partial<PhoneNumberDoc>): PhoneNumberDoc =>
  ({
    phoneNumberId: '1',
    wabaId: 'w',
    userId: 'u',
    overrideUrl: 'https://x.example.com',
    encAccessToken: { ciphertext: 'a', iv: 'b', authTag: 'c' },
    isOnBizApp: false,
    metaStatus: 'CONNECTED',
    onboarding: { step: 'done', event: 'FINISH', updatedAt: 1 },
    ...over,
  }) as PhoneNumberDoc;

test('the sync step says what is still to request', () => {
  const next = nextStep(doc({ isOnBizApp: true, sync: { contacts: { state: 'requested' }, history: { state: 'failed' } }, onboarding: { step: 'sync', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', updatedAt: 1 } }));
  assert.equal(next.step, 'sync');
  assert.match(next.instruction, /Still to request: history \(history failed/);
});

test('a finished number with a blocking problem says so; a number without a token must be connected again', () => {
  const blocked = nextStep(doc({ health: { account: { payment: { send: 'block', title: 'Payment method problem', message: 'Fix the payment method.', at: 1 } } } }));
  assert.match(blocked.instruction, /Payment method problem/);
  const lost = nextStep(doc({ encAccessToken: undefined }));
  assert.deepEqual(lost.tools, ['start_onboarding_link']);
});
