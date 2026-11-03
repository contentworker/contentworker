import type { ContentType } from '@contentworker/domain';
import { useOutletContext } from 'react-router';
import type { TextDirection } from '../lib/management';

/** Shared data the Content layout provides to its nested entry routes. */
export interface ContentOutlet {
  readonly types: ContentType[];
  /** The types haven't arrived yet: a missing type is still loading, not missing. */
  readonly typesPending: boolean;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly fallbacks?: Readonly<Record<string, string | null>>;
  /** Each locale's text direction (`dir` on its inputs); absent until the config loads. */
  readonly directions?: Readonly<Record<string, TextDirection>>;
  /** Whether Delivery serves each locale ("Not delivered" on its tab); absent until it loads. */
  readonly delivered?: Readonly<Record<string, boolean>>;
  reload(): void;
}

export function useContentOutlet(): ContentOutlet {
  return useOutletContext<ContentOutlet>();
}
