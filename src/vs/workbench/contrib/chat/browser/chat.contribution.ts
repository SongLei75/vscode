/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './widget/input/chatInputPrompt.js';
// Register the chat toolbar hover bridge eagerly so extensions can use it during activation,
// even before the chat input part (its only other importer) is lazily loaded.
import './widget/input/chatToolbarHover.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ExportAgentHostDebugLogsAction } from './actions/exportAgentHostDebugLogsAction.js';
import { ForkConversationAction } from './actions/chatForkActions.js';
import { IChatResponseFileChangesService } from './chatResponseFileChangesService.js';
import { EditorChatResponseFileChangesService } from './editorChatResponseFileChangesService.js';

registerAction2(ForkConversationAction);
registerAction2(ExportAgentHostDebugLogsAction);
registerSingleton(IChatResponseFileChangesService, EditorChatResponseFileChangesService, InstantiationType.Delayed);
