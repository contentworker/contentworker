import { getAiSettings, setAiSettings } from '@contentworker/application';
import { AI_CAPABILITIES, AI_GUIDANCE_MAX_CHARS, SCOPES } from '@contentworker/domain';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { aiSettingsSetBody } from '../../api/validation';
import { ok, READ_ONLY, scopeArgs, scopeOf, type ToolContext, toolSchema } from './shared';

/** The space's AI settings: the same use-cases, scopes and checks as `/ai-settings`. */
export function registerAiSettingsTools(server: McpServer, t: ToolContext): void {
  const { ctx, guard } = t;

  server.registerTool(
    'ai_settings_get',
    {
      description:
        'The space’s AI settings: for each AI capability ' +
        `(${AI_CAPABILITIES.join(', ')}), whether it is on, the model tier it runs on (null: ` +
        'each call site’s default) and the guidance added to its prompt, with the version and ' +
        'who set it. Version 0, everything on, before the first set. A capability that is off ' +
        'refuses with ai_capability_disabled.',
      inputSchema: toolSchema('ai_settings_get', () => z.object({ ...scopeArgs })),
      annotations: READ_ONLY,
    },
    async (args) => {
      guard(SCOPES.previewRead, scopeOf(args));
      return ok(await getAiSettings(ctx, scopeOf(args).spaceId));
    },
  );

  server.registerTool(
    'ai_settings_set',
    {
      description:
        'Set AI capabilities for the space (needs space:admin): capabilities maps a capability ' +
        'id to { enabled, tier?, guidance? }; each one named is replaced whole, the rest stay. ' +
        'Read ai_settings_get first and send its version as expectedVersion. Guidance is plain ' +
        `text, at most ${AI_GUIDANCE_MAX_CHARS} characters, about tone and style only. Show the ` +
        'person the change before setting it.',
      inputSchema: toolSchema('ai_settings_set', () => aiSettingsSetBody.extend({ ...scopeArgs })),
    },
    async (args) => {
      guard(SCOPES.spaceAdmin, scopeOf(args));
      const { space: _s, environment: _e, ...input } = args;
      return ok(await setAiSettings(ctx, t.principal, scopeOf(args).spaceId, input));
    },
  );
}
