/**
 * The admin half of the live preview channel, for `apps/web`. A workspace
 * export only: it is not part of the published `@contentworker/sdk`.
 */
export {
  connectPreviewHost,
  type PreviewHost,
  type PreviewHostEvents,
  type PreviewHostOptions,
  type PreviewHostWindow,
  type PreviewSession,
} from './live-preview/host.js';
export * from './live-preview/protocol.js';
