/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { cp, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { run } from '../esbuild-extension-common.mts';
import { prepareCore } from './scripts/prepare-core.mjs';

prepareCore();
const srcDir = path.join(import.meta.dirname, 'src');
const outDir = path.join(import.meta.dirname, 'dist');
const runtimeDir = await mkdtemp(path.join(tmpdir(), 'boardsession-runtime-'));
// Keep the normal dependency installation intact: VS Code type-checks concurrently with esbuild.
// The private temporary directory also keeps the packaged debug identity out of shared build scratch space.
process.once('exit', () => rmSync(runtimeDir, { recursive: true, force: true }));
await mkdir(path.join(runtimeDir, 'packages'));
for (const file of ['package.json', 'package-lock.json', 'packages/carizon-board-session-0.1.0.tgz']) {
	await cp(path.join(import.meta.dirname, file), path.join(runtimeDir, file));
}
const installed = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
	cwd: runtimeDir, stdio: 'inherit',
});
if (installed.error) { throw installed.error; }
if (installed.status !== 0) { throw new Error('Cannot install the BoardSession runtime archive'); }

await run({
	platform: 'node',
	format: 'esm',
	entryPoints: { extension: path.join(srcDir, 'extension.ts') },
	srcDir,
	outdir: outDir,
	additionalOptions: { external: ['vscode', '@carizon/board-session'] },
}, process.argv, async outputDirectory => {
	// Standard vsce collection includes dist, including this complete npm-installed runtime.
	const destination = path.join(outputDirectory, 'node_modules');
	await rm(destination, { recursive: true, force: true });
	const dependencies = path.join(runtimeDir, 'node_modules');
	await cp(dependencies, destination, {
		recursive: true,
		filter: source => !path.relative(dependencies, source).split(path.sep).some(part =>
			['test', 'tests', 'fixtures', 'examples', '.package-lock.json'].includes(part)),
	});
});
