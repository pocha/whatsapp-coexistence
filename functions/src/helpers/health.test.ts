import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveHealth, healthFromRefusal } from './health';
import type { MetaSnapshot } from './types';

const snapshot = (phone: Record<string, unknown>): Pick<MetaSnapshot, 'phone'> => ({ phone: { ok: true, data: phone } });
const sip = { error_code: 138024, error_description: 'WhatsApp Business calling cannot use SIP because it is not enabled' };

test('a reason or a display name with fields Meta left out is still plain data', () => {
  const derived = deriveHealth(snapshot({ health_status: { entities: [{ entity_type: 'WABA', can_send_message: 'BLOCKED', errors: [{ error_code: 141006 }] }] } }), 5)!;
  assert.equal(derived.health.reasons[0].message, 'Meta gave no description.');
  assert.equal(derived.displayName.name, undefined);
});

test('a blocked account blocks, and calling errors are left out', () => {
  const derived = deriveHealth(
    snapshot({
      verified_name: 'Shop',
      name_status: 'APPROVED',
      health_status: {
        can_send_message: 'BLOCKED',
        entities: [
          { entity_type: 'PHONE_NUMBER', can_send_message: 'AVAILABLE', errors: [sip] },
          { entity_type: 'WABA', can_send_message: 'BLOCKED', errors: [{ error_code: 141006, error_description: 'payment', possible_solution: 'add one' }] },
        ],
      },
    }),
    5,
  )!;
  assert.equal(derived.health.status, 'blocked');
  assert.deepEqual(derived.health.reasons.map((r) => r.code), [141006]);
  assert.equal(derived.displayName.name, 'Shop');
});

test('only the number being limited limits it: an unverified business alone does not', () => {
  const limited = deriveHealth(
    snapshot({ health_status: { entities: [{ entity_type: 'PHONE_NUMBER', can_send_message: 'LIMITED', additional_info: ['Your display name has not been approved yet.'] }] } }),
    5,
  )!;
  assert.equal(limited.health.status, 'limited');

  const unverified = deriveHealth(
    snapshot({ health_status: { entities: [{ entity_type: 'BUSINESS', can_send_message: 'LIMITED', errors: [{ error_code: 141010, error_description: 'not verified' }] }] } }),
    5,
  )!;
  assert.equal(unverified.health.status, 'ok');
  assert.equal(unverified.health.reasons[0].severity, 'info');
});

test('blocked wins over limited, and a read without a status gives none', () => {
  const both = deriveHealth(
    snapshot({ health_status: { entities: [{ entity_type: 'PHONE_NUMBER', can_send_message: 'LIMITED' }, { entity_type: 'WABA', can_send_message: 'BLOCKED' }] } }),
    5,
  )!;
  assert.equal(both.health.status, 'blocked');
  assert.equal(deriveHealth({ phone: { ok: false, error: 'x' } }, 5), null);
  assert.equal(deriveHealth(snapshot({ status: 'CONNECTED' }), 5), null);
});

test('only a refusal that says the account cannot send becomes a status', () => {
  assert.equal(healthFromRefusal({ code: 131042, message: 'payment' }, 1)?.status, 'blocked');
  assert.equal(healthFromRefusal({ code: 131026, message: 'undeliverable' }, 1), null);
  assert.equal(healthFromRefusal(undefined, 1), null);
});
