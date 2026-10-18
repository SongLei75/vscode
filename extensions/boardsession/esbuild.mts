/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { access, cp, rm } from 'node:fs/promises';
import { run } from '../esbuild-extension-common.mts';

const srcDir = path.join(import.meta.dirname, 'src');
const outDir = path.join(import.meta.dirname, 'dist');
const dependencies = path.join(import.meta.dirname, 'node_modules');
// Fail early if the locked installed package lacks the worker or either platform's native runtime.
for (const file of ['dist/native-worker.js', 'prebuilds/debug.key', 'prebuilds/linux-x64/board_session.node', 'prebuilds/win32-x64/board_session.node']) {
	await access(path.join(dependencies, '@carizon/board-session', file));
}
await run({
	platform: 'node',
	format: 'esm',
	entryPoints: { extension: path.join(srcDir, 'extension.ts') },
	srcDir,
	outdir: outDir,
	additionalOptions: { external: ['vscode', '@carizon/board-session'] },
}, process.argv, async outputDirectory => {
	// Package the installed runtime without an extra installation during compilation.
	const destination = path.join(outputDirectory, 'node_modules');
	await rm(destination, { recursive: true, force: true });
	await cp(dependencies, destination, {
		recursive: true,
		filter: source => !path.relative(dependencies, source).split(path.sep).some(part =>
			['@types', '.bin', 'test', 'tests', 'fixtures', 'examples', '.package-lock.json'].includes(part)),
	});
});
