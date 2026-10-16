import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTemplateExport } from './templateImport';

const exported = {
  data: [
    {
      id: '123',
      name: 'order_update',
      status: 'APPROVED',
      quality_score: { score: 'GREEN' },
      category: 'UTILITY',
      language: 'en_US',
      parameter_format: 'positional',
      components: [{ type: 'BODY', text: 'Hi {{1}}' }],
    },
    { name: 'half_a_template', language: 'en_US' },
  ],
};

test('an exported template list becomes create requests without the read-only fields, and a bad entry is reported, not fatal', () => {
  const { templates, rejected } = parseTemplateExport(exported);
  assert.deepEqual(templates, [
    {
      name: 'order_update',
      language: 'en_US',
      category: 'UTILITY',
      parameter_format: 'positional',
      components: [{ type: 'BODY', text: 'Hi {{1}}' }],
    },
  ]);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].name, 'half_a_template');
});
