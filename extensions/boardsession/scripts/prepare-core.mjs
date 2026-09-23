/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import { accessSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const core = fileURLToPath(new URL('../board-session/', import.meta.url));
const packages = fileURLToPath(new URL('../packages/', import.meta.url));

function npm(args, cwd) {
	const result = spawnSync('npm', args, { cwd, stdio: 'inherit' });
	if (result.error) { throw result.error; }
	if (result.status !== 0) { throw new Error(`npm ${args[0]} failed (${result.status})`); }
}

/** Build and pack the independent core before installing its archive dependency. */
export function prepareCore() {
	if (process.platform !== 'linux' || process.arch !== 'x64') {
		throw new Error('BoardSession currently requires Linux x64 native artifacts.');
	}
	// Fail early if the intentionally untracked internal identity has not been provisioned.
	accessSync(new URL('../board-session/prebuilds/client-identity.pem', import.meta.url));
	mkdirSync(packages, { recursive: true });
	npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], core);
	npm(['run', 'build'], core);
	npm(['pack', '--pack-destination', packages], core);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	prepareCore();
}
