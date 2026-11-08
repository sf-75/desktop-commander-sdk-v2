import assert from 'node:assert/strict';
import { commandManager } from '../dist/command-manager.js';
import { runIfMain } from './helpers/run-if-main.js';

async function runTests() {
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';

  for (const subcommand of ['doctor', 'run', '--help']) {
    const dynamicCommand = '& $client ' + subcommand;
    const reading = await commandManager.readCommands(dynamicCommand, shell);
    assert.equal(reading.commands[0]?.name, '$client', dynamicCommand);
    assert.equal(reading.commands[0]?.nameAtRunTime, true, dynamicCommand);
    const check = await commandManager.checkCommand(dynamicCommand, shell);
    assert.equal(check.verdict, 'unseen', dynamicCommand);
    assert.ok(check.unseen.some(({ what, inFile }) => what === '$client' && !inFile), dynamicCommand);
    assert.equal(await commandManager.validateCommand(dynamicCommand, shell), true, dynamicCommand);
  }

  const chained = await commandManager.checkCommand('echo before; & $client init --help; echo after', shell);
  assert.equal(chained.verdict, 'unseen');
  assert.ok(chained.unseen.some(({ what }) => what === '$client'));

  for (const staticTarget of ['& init --help', '& "init" --help', "& 'init' --help", '& /sbin/init --help']) {
    const check = await commandManager.checkCommand(staticTarget, shell);
    assert.deepEqual(check, { verdict: 'blocked', name: 'init' }, staticTarget);
    assert.equal(await commandManager.validateCommand(staticTarget, shell), false, staticTarget);
  }

  for (const command of [
    '& $client doctor --help; & init --help',
    '& init --help; & $client doctor --help',
    '& $client $(init)',
  ]) {
    const check = await commandManager.checkCommand(command, shell);
    assert.equal(check.verdict, 'blocked', command);
  }

  const quoted = await commandManager.readCommands('echo "& $client init --help"', shell);
  assert.equal(quoted.commands.some(({ nameAtRunTime }) => nameAtRunTime), false);

  const dynamicTargets = [
    '& "$client" init --help',
    '& ($client) init --help',
    '& ($' + '{client}) init --help',
    '& $(Get-Command tool) init --help',
    '& @($client)[0] init --help',
  ];
  for (const dynamicTarget of dynamicTargets) {
    const check = await commandManager.checkCommand(dynamicTarget, shell);
    assert.equal(check.verdict, 'unseen', dynamicTarget);
    assert.equal(await commandManager.validateCommand(dynamicTarget, shell), true, dynamicTarget);
  }

  console.log('PASS: PowerShell dynamic call targets are reported as unseen while static blocked targets remain refused');
  return true;
}

runIfMain(import.meta.url, runTests);
export default runTests;
