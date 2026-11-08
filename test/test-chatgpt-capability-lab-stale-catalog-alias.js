import assert from 'node:assert/strict';
import { readUiResource } from '../dist/ui/resources.js';
import { SDK_V2_MRTR_RESOURCE_URI } from '../dist/ui/contracts.js';

const result = await readUiResource(SDK_V2_MRTR_RESOURCE_URI, {
  experimentalMrtr: true,
  chatGptCapabilityLab: true,
});

assert(result, 'MRTR resource alias should resolve');
const content = result.contents?.[0];
assert(content, 'resource content missing');
assert.equal(content.uri, SDK_V2_MRTR_RESOURCE_URI, 'response must preserve requested URI');
assert.match(content.text ?? '', /ChatGPT UI Capability Lab/);
assert.match(content.text ?? '', /state-inc/);
assert.doesNotMatch(content.text ?? '', /mrtr-accept/);
assert.deepEqual(content._meta?.['openai/ui']?.availableDisplayModes, ['inline', 'fullscreen', 'pip']);
console.log('PASS ChatGPT capability lab stale-catalog resource alias');

