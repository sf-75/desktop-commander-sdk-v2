import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TerminalManager } from '../dist/terminal-manager.js';
import { SearchManager } from '../dist/search-manager.js';

const manager = new TerminalManager();
manager.sessions.set(12345, { pid: 12345 });
let attempts = 0;
manager.forceTerminate = async () => {
  attempts += 1;
  return attempts === 1 ? 'failed' : 'terminated';
};

await assert.rejects(manager.dispose(), /could not terminate process sessions/);
assert(manager.sessions.has(12345), 'failed process sessions must remain tracked for retry');
await manager.dispose();

assert.equal(attempts, 2, 'a later dispose() call must retry a previously failed process termination');
console.log('PASS TerminalManager retries disposal after a transient termination failure');

const searchManager = new SearchManager();
searchManager.stopOfficeSources = () => {};
const ripgrepChild = new EventEmitter();
ripgrepChild.pid = 2147483647;
ripgrepChild.exitCode = null;
ripgrepChild.signalCode = null;
ripgrepChild.kill = () => true;
searchManager.sessions.set('retry-session', {
  id: 'retry-session',
  isComplete: false,
  process: ripgrepChild,
});
await assert.rejects(searchManager.dispose(), /SearchManager disposal could not terminate/);
assert(searchManager.sessions.has('retry-session'), 'failed search processes must remain tracked for retry');
ripgrepChild.exitCode = 0;
await searchManager.dispose();
assert.equal(searchManager.sessions.has('retry-session'), false, 'successful retry must release the failed session');
console.log('PASS SearchManager retries disposal after a transient process termination failure');
