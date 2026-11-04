/**
 * Inject the assistant's identity into its own Session, and only that Session.
 *
 * A Session created with a `cwd` is still an ordinary blank conversation: DSH
 * gives it a system prompt built from the harness defaults plus whatever plugins
 * contribute, and none of those know the Session is supposed to be an assistant.
 * That is why opening it felt identical to a new chat.
 *
 * Two facts make a targeted injection possible, both taken from the working
 * `ds-bot` plugin rather than guessed:
 *
 * 1. `systemPrompt.section()` accepts a render function that receives the
 *    assembly context, which carries the rendering Agent (`context.agent.id`).
 * 2. Registering the section on the Agent's own context scope means it applies
 *    to that Agent only, not to every Session in the process.
 *
 * So the assistant's Session gets an identity; a user's ordinary chat does not.
 */
import type { DshContextLike, OneConfig } from '../types.js';
import type { OneCore } from './registry.js';
import type { OneSettings } from './settings.js';
/**
 * Register the identity section.
 *
 * Returns a disposer and never throws: a host without `systemPrompt` (an older
 * build) must keep the rest of the plugin working, only without the identity.
 */
export declare function registerAssistantPersona(ctx: DshContextLike, core: OneCore, settings: OneSettings, config: OneConfig): () => void;
/**
 * Resolve the assistant's home as a real DSH Workspace.
 *
 * A `cwd` alone puts the Session in a folder the client groups under an
 * inferred Workspace. Registering the path as an actual Workspace is firmer: the
 * client then resolves a real Workspace id, which is what keeps the "choose a
 * workspace" prompt away even after a restart reorders its own session list.
 */
export declare function ensureAssistantWorkspace(ctx: DshContextLike, path: string, name: string): Promise<string | undefined>;
