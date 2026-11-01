import { cn } from '@contentworker/ui/lib/utils';
import { SkeletonText } from '@contentworker/ui/skeleton';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { NavLink, Outlet } from 'react-router';
import { StatusDot } from '~/cms/components/status';
import { useClient } from '../lib/client-context';
import { useContentTypesQuery, useQueryKeys, useSpaceConfigQuery } from '../lib/queries';
import type { ContentOutlet } from './content-context';

/**
 * Content section shell: a secondary nav listing the space's content types,
 * beside an outlet that renders the entries list / entry editor. Content types
 * and locale config come from the query cache and are shared with nested
 * routes; `reload` invalidates both so any nested mutation can refresh them.
 */
export function ContentLayout() {
  const { conn } = useClient();
  const queryClient = useQueryClient();
  const keys = useQueryKeys();
  const typesQuery = useContentTypesQuery();
  const configQuery = useSpaceConfigQuery();

  const types = typesQuery.data ?? [];
  const cfg = configQuery.data ?? null;

  const reload = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: keys.contentTypes });
    void queryClient.invalidateQueries({ queryKey: keys.spaceConfig });
  }, [queryClient, keys]);

  const outlet: ContentOutlet = {
    types,
    typesPending: typesQuery.isPending,
    locales: cfg?.locales ?? [conn.locale],
    defaultLocale: cfg?.defaultLocale ?? conn.locale,
    fallbacks: cfg?.fallbacks,
    reload,
  };

  return (
    // Sized by the room the page has, not the screen: beside the assistant's column the page is
    // narrower than the screen says, and the entries table needs the width more than this nav.
    <div className="@container">
      <div className="grid grid-cols-1 gap-6 @[40rem]:grid-cols-[13rem_1fr]">
        {/* The space's content types beside the page, given 40rem for both (a phone, or a page beside
          the assistant, reaches them from the Content overview's cards). Drawn as the Settings
          section nav is. */}
        <nav aria-labelledby="content-types-nav" className="hidden pt-6 @[40rem]:block">
          <div className="sticky top-[calc(var(--shell-h)+1.5rem)]">
            <h2 id="content-types-nav" className="caption px-2.5 pb-1">
              Content types
            </h2>
            <ul className="flex flex-col gap-0.5">
              {types.map((t) => (
                <li key={t.apiId}>
                  <NavLink
                    to={`/content/${t.apiId}`}
                    className={({ isActive }) =>
                      cn(
                        'relative flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-[background-color,color] touch:min-h-11',
                        isActive
                          ? 'bg-accent font-medium text-accent-foreground before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-brand'
                          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                      )
                    }
                  >
                    <span className="truncate">{t.name}</span>
                    {t.status !== 'published' ? <StatusDot status={t.status} /> : null}
                  </NavLink>
                </li>
              ))}
              {typesQuery.isPending
                ? ['72%', '55%', '64%', '48%'].map((w) => (
                    <li key={w} aria-hidden="true" className="px-2.5 py-1.5 text-sm touch:min-h-11">
                      <SkeletonText width={w} />
                    </li>
                  ))
                : null}
            </ul>
            {types.length === 0 && !typesQuery.isPending && (
              <p className="px-2.5 py-1 text-muted-foreground text-sm">No content types yet.</p>
            )}
          </div>
        </nav>

        <section className="min-w-0">
          <Outlet context={outlet} />
        </section>
      </div>
    </div>
  );
}
