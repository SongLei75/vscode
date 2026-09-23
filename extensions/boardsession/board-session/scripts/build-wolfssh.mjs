// Build the consumed wolfSSH library for a headless Node.js process.
// Protocol implementation stays in the external wolfSSH source tree.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { availableParallelism } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.env.WOLFSSH_SOURCE || join(root, '../wolf/wolfssh'));
const ssl = resolve(process.env.WOLFSSL_ROOT || join(root, '../wolf/out/build/linux/stage/wolfssl'));
const build = join(root, 'build/wolfssh-source');
const prefix = join(root, 'build/wolfssh');
if (!existsSync(join(source, 'configure.ac'))) throw new Error('Set WOLFSSH_SOURCE to the wolfSSH source directory');
mkdirSync(join(root, 'build'), { recursive: true });
rmSync(build, { recursive: true, force: true });
cpSync(source, build, { recursive: true, filter: path => !path.split('/').includes('.git') });
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: build, stdio: 'inherit', env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run('./autogen.sh', []);
run('./configure', [`--prefix=${prefix}`, `--with-wolfssl=${ssl}`, '--enable-certs',
  '--enable-term', '--enable-shared', '--disable-static', '--disable-examples'],
  { ...process.env, CPPFLAGS: `${process.env.CPPFLAGS || ''} -DNO_TERMIOS` });
run('make', ['-j', String(Math.min(availableParallelism(), 8)), 'src/libwolfssh.la']);
run('make', ['install-libLTLIBRARIES', 'install-nobase_includeHEADERS']);
