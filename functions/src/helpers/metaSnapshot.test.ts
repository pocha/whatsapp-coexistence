import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAllFields, readFieldsSkippingUnknown } from './metaSnapshot';

const unknownField = (name: string) => new Error(`Graph API error (400): {"error":{"message":"(#100) Tried accessing nonexisting field (${name})"}}`);

test('a field Meta does not know is dropped and the rest is still read', async () => {
  const asked: string[] = [];
  const get = async (path: string) => {
    asked.push(path);
    if (path.includes('throttle')) throw unknownField('throttle');
    return { status: 'CONNECTED' };
  };
  const result = await readFieldsSkippingUnknown(get, '/1', ['status', 'throttle']);
  assert.deepEqual(result, { status: 'CONNECTED', unavailableFields: ['throttle'] });
  assert.equal(asked.length, 2);
});

test('every field Meta lists is asked for, without the certificate, and the edges are named', async () => {
  const asked: string[] = [];
  const get = async (path: string) => {
    asked.push(path);
    if (path.endsWith('?metadata=1')) return { metadata: { fields: [{ name: 'id' }, { name: 'quality_rating' }, { name: 'certificate' }, { name: 'health_status' }], connections: { phone_numbers: 'x' } } };
    return { quality_rating: 'GREEN' };
  };
  const result = await readAllFields(get, '/1', ['fallback_only']);
  assert.equal(asked[1], '/1?fields=id,quality_rating,health_status');
  assert.deepEqual(result, { quality_rating: 'GREEN', availableEdges: ['phone_numbers'] });
});

test('when Meta will not list the fields the fallback list is used, and a refused field is named without losing the rest', async () => {
  const get = async (path: string) => {
    if (path.endsWith('?metadata=1')) throw new Error('Graph API error (400): no metadata');
    if (path.includes('fields=a,b')) throw new Error('Graph API error (403): (#10) permission');
    if (path.endsWith('fields=a')) return { a: 1 };
    throw new Error('Graph API error (403): (#10) permission denied for b');
  };
  const result = await readAllFields(get, '/1', ['a', 'b']);
  assert.equal(result.a, 1);
  assert.match(String((result.unreadableFields as Record<string, string>).b), /permission denied for b/);
});
