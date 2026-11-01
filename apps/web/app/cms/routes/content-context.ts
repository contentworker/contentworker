import type { ContentType } from '@contentworker/domain';
import { useOutletContext } from 'react-router';

/** Shared data the Content layout provides to its nested entry routes. */
export interface ContentOutlet {
  readonly types: ContentType[];
  /** The types haven't arrived yet: a missing type is still loading, not missing. */
  readonly typesPending: boolean;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly fallbacks?: Readonly<Record<string, string | null>>;
  reload(): void;
}

export function useContentOutlet(): ContentOutlet {
  return useOutletContext<ContentOutlet>();
}
