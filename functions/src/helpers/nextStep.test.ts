import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextStep } from './nextStep';
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

test('each step names the tools to use next', () => {
  assert.deepEqual(nextStep(doc({ overrideUrl: undefined, onboarding: { step: 'override', event: 'FINISH', updatedAt: 1 } })).tools.slice(0, 1), ['check_callback_url']);
  assert.deepEqual(nextStep(doc({ onboarding: { step: 'not_on_app', event: 'FINISH', updatedAt: 1 } })).tools, ['register_number']);
  assert.deepEqual(nextStep(doc({ onboarding: { step: 'register', event: 'FINISH', updatedAt: 1 } })).tools, ['register_number']);
  assert.ok(nextStep(doc({ onboarding: { step: 'templates', event: 'FINISH', updatedAt: 1 } })).tools.includes('migrate_templates'));
  assert.ok(nextStep(doc({})).tools.includes('send_message'));
});

test('the sync step says what is still to request', () => {
  const next = nextStep(doc({ isOnBizApp: true, sync: { contacts: { state: 'requested' }, history: { state: 'failed' } }, onboarding: { step: 'sync', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', updatedAt: 1 } }));
  assert.equal(next.step, 'sync');
  assert.match(next.instruction, /Still to request: history \(history failed/);
});

test('a finished number with a blocking problem says so; a number without a token must be connected again', () => {
  const blocked = nextStep(
    doc({ health: { status: 'blocked', reasons: [{ chip: 'status', cause: 'payment', title: 'Payment method problem', message: 'm', action: 'Fix the payment method.', scope: 'WABA', severity: 'blocked', at: 1 }] } as never }),
  );
  assert.match(blocked.instruction, /Payment method problem/);
  const lost = nextStep(doc({ encAccessToken: undefined }));
  assert.deepEqual(lost.tools, ['start_onboarding_link']);
});
