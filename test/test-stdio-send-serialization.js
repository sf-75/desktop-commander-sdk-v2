import assert from 'node:assert/strict';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { FilteredStdioServerTransport } from '../dist/custom-stdio.js';
import { runIfMain } from './helpers/run-if-main.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function runTests() {
  const originalSend = StdioServerTransport.prototype.send;
  const pending = [];
  const started = [];
  let active = 0;
  let maximumActive = 0;

  StdioServerTransport.prototype.send = function (message) {
    active++;
    maximumActive = Math.max(maximumActive, active);
    started.push(message);
    return new Promise((resolve, reject) => pending.push({
      resolve: () => { active--; resolve(); },
      reject: (error) => { active--; reject(error); },
    }));
  };

  const transport = new FilteredStdioServerTransport();
  try {
    const messages = [
      { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'one' } },
      { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'two' } },
      { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'three' } },
    ];
    const sends = messages.map((message) => transport.send(message));
    await tick();
    assert.equal(started.length, 1, 'only the first SDK send may be in flight');
    pending.shift().resolve();
    await tick();
    assert.equal(started.length, 2, 'the second send starts after the first settles');
    pending.shift().resolve();
    await tick();
    assert.equal(started.length, 3, 'the third send starts after the second settles');
    pending.shift().resolve();
    await Promise.all(sends);
    assert.equal(maximumActive, 1, 'SDK transport sends must never overlap');
    assert.deepEqual(started, messages, 'serialized sends must preserve message order');
    console.log('PASS: SDK stdio sends are serialized under backpressure');
    return true;
  } finally {
    transport.cleanup();
    StdioServerTransport.prototype.send = originalSend;
  }
}

runIfMain(import.meta.url, runTests);
