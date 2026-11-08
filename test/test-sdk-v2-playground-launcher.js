import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const launcherPath = path.join(here, '..', 'scripts', 'run-sdk-v2-playground.cmd');
const launcher = fs.readFileSync(launcherPath, 'utf8');

assert.match(launcher, /set "DC_REPO_ROOT=%~dp0\.\."/);
assert.match(launcher, /if not defined DC_SDK_V2_PLAYGROUND_HOME/);
assert.match(launcher, /set "DC_SDK_V2_PLAYGROUND=1"/);
assert.match(launcher, /set "DC_SDK_V2_EXPERIMENTAL_MRTR=1"/);
assert.match(launcher, /set "DC_SDK_V2_FORCE_LEGACY_STDIO=1"/);
assert.match(launcher, /node\.exe "%DC_REPO_ROOT%\\dist\\index\.js" --no-onboarding/);
assert.doesNotMatch(launcher, /[A-Z]:\\Codex\\/i, 'repo launcher must not depend on a machine-specific Codex path');

console.log('PASS SDK v2 Playground launcher keeps runtime flags in a repo-controlled portable entrypoint');
