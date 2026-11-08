import assert from 'node:assert/strict';
import { createProcessToolContext, disposeProcessToolContext } from '../dist/tools/improved-process-tools.js';
import {
  handleForceTerminate,
  handleInteractWithProcess,
  handleListSessions,
  handleStartProcess,
} from '../dist/handlers/terminal-handlers.js';
import { SearchManager } from '../dist/search-manager.js';
import { handleStartSearch } from '../dist/handlers/search-handlers.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = 'true';

const processContext = createProcessToolContext();
await disposeProcessToolContext(processContext);

const start = await handleStartProcess({ command: 'node:local', timeout_ms: 1000 }, processContext);
assert.equal(start.isError, true);
assert.match(start.content?.[0]?.text ?? '', /closed/i);

const sessions = await handleListSessions(processContext);
assert.match(sessions.content?.[0]?.text ?? '', /no active|no sessions/i);

const interact = await handleInteractWithProcess({ pid: -1000, input: 'console.log("must-not-run")', timeout_ms: 1000 }, processContext);
assert.equal(interact.isError, true);

const terminate = await handleForceTerminate({ pid: -1000 }, processContext);
assert.equal(terminate.isError, undefined);
assert.match(terminate.content?.[0]?.text ?? '', /no active session/i);

const searchManager = new SearchManager();
await searchManager.dispose();
const search = await handleStartSearch({
  path: process.cwd(),
  pattern: 'this-search-must-not-start',
  searchType: 'content',
}, searchManager);
assert.equal(search.isError, true);
assert.match(search.content?.[0]?.text ?? '', /closed/i);
assert.equal(searchManager.listSearchSessions().length, 0);

console.log('PASS process and search handlers reject work after owner disposal');
