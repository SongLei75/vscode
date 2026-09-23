import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ssh = process.env.WOLFSSH_ROOT || join(root, 'build/wolfssh');
const ssl = process.env.WOLFSSL_ROOT || join(root, 'build/wolfssl');
const headers = process.env.NODE_INCLUDE_DIR || [
  resolve(dirname(process.execPath), '../include/node'), '/usr/include/node',
].find(path => existsSync(join(path, 'node_api.h')));
if (!headers) throw new Error('Set NODE_INCLUDE_DIR to the directory containing node_api.h');
const artifacts = join(root, 'prebuilds', `${process.platform}-${process.arch}`);
mkdirSync(artifacts, { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run('cmake', ['-S', 'native', '-B', 'build', '-DCMAKE_BUILD_TYPE=Release',
  `-DWOLFSSH_ROOT=${ssh}`, `-DWOLFSSL_ROOT=${ssl}`, `-DNODE_INCLUDE_DIR=${headers}`, `-DARTIFACT_DIR=${artifacts}`]);
run('cmake', ['--build', 'build', '--parallel']);

// Preserve the notices already bundled with the local snapshot.
if (!existsSync(join(artifacts, 'wolfSSH-LICENSING')) || !existsSync(join(artifacts, 'wolfSSL-COPYING'))) {
  throw new Error('Missing wolfSSH/wolfSSL license notices in prebuilds');
}
