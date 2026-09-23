// Real-server acceptance checks. No mocks or unit tests.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BoardSession } from '../dist/index.js';

const board = {
  host: process.env.BOARD_HOST,
  port: Number(process.env.BOARD_PORT || 22),
  username: process.env.BOARD_USER,
};
if (!board.host || !board.username || !process.env.BOARD_IDENTITY) {
  throw new Error('Set BOARD_HOST, BOARD_USER, BOARD_IDENTITY; optionally BOARD_PORT and BOARD_JUMPS (JSON array)');
}
const jumps = JSON.parse(process.env.BOARD_JUMPS || '[]');
const directory = await mkdtemp(join(tmpdir(), 'board-session-functional-'));
process.env.XDG_DATA_HOME = directory;
let session;
const start = Date.now();
async function command(text, expected, status = 0) {
  const result = await session.exec(text);
  assert.equal(result.completed, true, JSON.stringify(result));
  assert.equal(result.exitCode, status, JSON.stringify(result));
  if (expected) assert.match(result.text, expected);
  return result;
}
try {
  await assert.rejects(BoardSession.open({ board, jumps }), /setIdentity/);
  const pem = await readFile(process.env.BOARD_IDENTITY);
  await BoardSession.setIdentity(pem);
  await assert.rejects(BoardSession.setIdentity('invalid'), /certificate/);
  assert.equal((await stat(join(directory, 'carizon/board-session/identity.pem'))).mode & 0o777, 0o600);
  console.log('PASS identity configuration, validation, and file permissions');
  session = await BoardSession.open({ board, jumps });
  console.log(`PASS open (${jumps.length} jumps), authenticated local native shell ready`);
  const pid = (await command('printf "PID=%s" "$$"')).text.match(/PID=(\d+)/)[1];
  await command("BS_VALUE='persistent value'; cd /tmp");
  await command('printf "%s|%s|%s" "$BS_VALUE" "$PWD" "$$"', new RegExp(`persistent value\\|/tmp\\|${pid}`));
  await command('printf "stdout\\n"; printf "stderr\\n" >&2; false', /stdout[\s\S]*stderr/, 1);
  await command("printf '%s\\n' \"it's quoted\"\nprintf '%s\\n' '中文输出'", /it's quoted[\s\S]*中文输出/);
  console.log('PASS persistent shell PID, cwd, variables, output, exit codes, multiline and UTF-8');

  await session.send('printf "pending-terminal-output\\n"', true);
  await delay(300);
  const isolated = await command('printf "own-command-output\\n"', /own-command-output/);
  assert.doesNotMatch(isolated.text, /pending-terminal-output/);
  assert.match(session.read().text, /pending-terminal-output/);
  console.log('PASS exec output excludes older unread terminal output');

  const running = session.exec('sleep 0.3; printf "concurrent-done\\n"');
  assert.throws(() => session.exec('echo must-not-run'), /still running/);
  assert.equal((await running).completed, true);
  const timed = await session.exec('sleep 0.5; printf "late-output\\n"', 80);
  assert.equal(timed.completed, false);
  assert.throws(() => session.exec('echo must-not-run'), /still running/);
  await delay(900);
  assert.match(session.read().text, /late-output/);
  assert.equal(session.read().text, '');
  await command('printf "resumed\\n"', /resumed/);
  console.log('PASS concurrent exec rejection, timeout tracking, late read, and recovery');

  const interaction = session.exec('read -r BS_ANSWER; printf "answer=%s\\n" "$BS_ANSWER"');
  await delay(150);
  const sent = await session.send('interactive input', true);
  const answer = await interaction;
  assert.equal(answer.completed, true);
  assert.match(sent.text + answer.text, /answer=interactive input/);
  console.log('PASS interactive send with newline');

  const interrupted = session.exec('sleep 5; printf "should-not-finish\\n"', 1_000);
  await delay(150);
  const interruptOutput = await session.send('\x03');
  const interruptResult = await interrupted;
  if (interruptResult.completed) assert.notEqual(interruptResult.exitCode, 0);
  else {
    assert.throws(() => session.exec('true'), /still running/);
    await session.close();
    session = await BoardSession.open({ board, jumps });
  }
  assert.doesNotMatch(interruptOutput.text + interruptResult.text, /should-not-finish/);
  await command('printf "after-interrupt\\n"', /after-interrupt/);
  console.log('PASS terminal Ctrl-C; uncertain completion stays blocked until close');

  const large = await command("head -c 262144 /dev/zero | tr '\\000' x");
  assert.equal((large.text.match(/x/g) || []).length, 262144);
  console.log('PASS output larger than SSH channel window');
  const input = session.exec('stty -icanon -echo; head -c 1048576 >/dev/null; stty icanon; printf "large-input-done\\n"');
  await delay(200);
  const inputReply = await session.send('x'.repeat(1048576));
  const inputResult = await input;
  assert.equal(inputResult.completed, true);
  assert.match(inputReply.text + inputResult.text, /large-input-done/);
  console.log('PASS 1 MiB interactive input with SSH backpressure');
  await BoardSession.setIdentity(pem);
  await command('printf "identity-replaced-session-alive\\n"', /identity-replaced-session-alive/);
  await session.close();
  await session.close();
  assert.equal(session.isClosed, true);
  assert.throws(() => session.exec('true'), /closed/);
  console.log('PASS identity replacement and idempotent close');

  session = await BoardSession.open({ board, jumps });
  const pending = session.exec('sleep 10');
  const rejected = assert.rejects(pending, /closed/);
  await delay(100);
  await session.close();
  await rejected;
  console.log('PASS reopening and closing a running command');
  session = await BoardSession.open({ board, jumps });
  await assert.rejects(session.exec('exit 7'), /closed|stopped|wolfSSH|disconnect/i);
  assert.equal(session.isClosed, true);
  await session.close();
  console.log('PASS remote shell exit closes the entire session');

  await assert.rejects(BoardSession.open({
    board: { ...board, username: 'board-session-no-such-user' }, jumps,
  }), /auth|closed|wolfSSH/i);
  if (jumps.length) {
    const invalidKey = join(directory, 'invalid-jump-key');
    await writeFile(invalidKey, 'invalid private key', { mode: 0o600 });
    await assert.rejects(BoardSession.open({ board, jumps: [jumps[0], {
      ...jumps[0], host: '127.0.0.1', privateKeyFile: invalidKey,
    }] }), /privateKey|parse/i);
    await assert.rejects(BoardSession.open({ board, jumps: [jumps[0], {
      ...jumps[0], host: '127.0.0.1', port: 1,
    }] }), /forward|refused|closed/i);
  }
  console.log(`PASS authentication failure${jumps.length ? ' and partial-chain cleanup' : ''}`);
  console.log(`PASS all real-server checks in ${((Date.now() - start) / 1000).toFixed(1)}s`);
} finally {
  await session?.close();
  await rm(directory, { recursive: true, force: true });
}
