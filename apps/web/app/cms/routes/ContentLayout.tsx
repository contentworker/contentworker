import { cn } from '@contentworker/ui/lib/utils';
import { SkeletonText } from '@contentworker/ui/skeleton';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { useContentTypeDeleteJob } from '~/cms/components/ContentTypeDeleteJob';
import { StatusDot } from '~/cms/components/status';
import { statusLabel } from '~/cms/lib/format';
import { useClient } from '../lib/client-context';
import { ContentTypeIcon } from '../lib/content-type-icons';
import {
  useContentTypesQuery,
  useInvalidate,
  useQueryKeys,
  useSpaceConfigQuery,
} from '../lib/queries';
import type { ContentOutlet } from './content-context';

/**
 * Content section shell: a secondary nav listing the space's content types,
 * beside an outlet that renders the entries list / entry editor. Content types
 * and locale config come from the query cache and are shared with nested
 * routes; `reload` invalidates both so any nested mutation can refresh them.
 */
export function ContentLayout() {
  const { conn } = useClient();
  const { pathname } = useLocation();
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

  // A content type's delete job, kept here rather than on the overview so its card is still there
  // after a visit to an entry. When it decides the type's fate, the types and entries reload.
  const invalidate = useInvalidate();
  const deleteJob = useContentTypeDeleteJob(() => {
    reload();
    void invalidate(['entries']);
  });

  const sections = useMemo(() => groupContentTypes(types), [types]);
  // The overview lists every type itself, as a catalog: beside it the nav would be a second copy of
  // the same list, so there the page takes the whole width.
  const overview = pathname === '/content' || pathname === '/content/';
  // Every type filed under a group: the groups' own captions head the lists (as Settings' do), and
  // "Content types" names the nav without stacking a second caption over the first group's.
  const allGrouped = sections.length > 0 && sections.every((s) => s.group);

  // Arriving on a type far down a long list (a deep link, the palette): where you are is brought
  // into the nav's own scroller, which otherwise opens at its top.
  const scroller = useRef<HTMLDivElement>(null);
  const openType = types.find(
    (t) => pathname === `/content/${t.apiId}` || pathname.startsWith(`/content/${t.apiId}/`),
  )?.apiId;
  useEffect(() => {
    if (!openType) return;
    scroller.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [openType]);

  const outlet: ContentOutlet = {
    deleteJob,
    types,
    typesPending: typesQuery.isPending,
    locales: cfg?.locales ?? [conn.locale],
    defaultLocale: cfg?.defaultLocale ?? conn.locale,
    fallbacks: cfg?.fallbacks,
    ...(cfg?.localeSettings
      ? {
          directions: Object.fromEntries(
            Object.entries(cfg.localeSettings).map(([l, s]) => [l, s.direction]),
          ),
          delivered: Object.fromEntries(
            Object.entries(cfg.localeSettings).map(([l, s]) => [l, s.delivered]),
          ),
        }
      : {}),
    reload,
  };

  return (
    // Sized by the room the page has, not the screen: beside the assistant's column the page is
    // narrower than the screen says, and the entries table needs the width more than this nav.
    <div className="@container">
      <div className={cn('grid grid-cols-1 gap-6', !overview && '@[40rem]:grid-cols-[13rem_1fr]')}>
        {/* The space's content types beside the page, given 40rem for both (a phone, or a page beside
          the assistant, reaches them from the Content overview's cards). Drawn as the Settings
          section nav is. */}
        {/* Not on the overview, whose catalog is this list: not drawn there at all, hidden or not. */}
        {overview ? null : (
          <nav aria-labelledby="content-types-nav" className="hidden pt-6 @[40rem]:block">
            {/* A model with more types than the window is tall scrolls here, on its own, so the last
              type is never a page of entries away, and never behind the tab bar where that still
              shows. The 0.25rem around the links (and of scroll padding, for a link that focus
              scrolls to an edge) is room for their focus outline, which the scroller would
              otherwise clip. */}
            <div
              ref={scroller}
              className="cw-scroll sticky top-[calc(var(--shell-h)+1.5rem)] -mx-1 max-h-[calc(100dvh-var(--shell-h)-var(--tabbar-h,0px)-3rem)] scroll-py-1 overflow-y-auto px-1 pb-1"
            >
              <h2 id="content-types-nav" className={allGrouped ? 'sr-only' : 'caption px-2.5 pb-1'}>
                Content types
              </h2>
              {/* Types without a group first, then each group under its name: the order an
                author filed them in, found the same way every time. */}
              {sections.map((section, index) => (
                <div key={section.group ?? ''} className={index > 0 ? 'pt-5' : undefined}>
                  {section.group && (
                    <h3 id={sectionId(index)} className="caption px-2.5 pb-1">
                      {section.group}
                    </h3>
                  )}
                  <ul
                    className="flex flex-col gap-0.5"
                    {...(section.group ? { 'aria-labelledby': sectionId(index) } : {})}
                  >
                    {section.types.map((t) => {
                      // Active anywhere under the type, so a singleton's entry (reached through
                      // `/entry`) marks it as the list does its entries.
                      const base = `/content/${t.apiId}`;
                      const active = pathname === base || pathname.startsWith(`${base}/`);
                      const status = t.status !== 'published' ? statusLabel(t.status) : null;
                      return (
                        <li key={t.apiId}>
                          <Link
                            // A singleton opens its one entry, not a list of one.
                            to={t.singleton ? `${base}/entry` : base}
                            aria-current={active ? 'page' : undefined}
                            className={cn(
                              'relative flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-[background-color,color] touch:min-h-11',
                              active
                                ? 'bg-accent font-medium text-accent-foreground current-item'
                                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                            )}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              {/* Every type has an icon (its own, one its name suggests, or a
                                  blank page), so no name sits in like a child of the row above.
                                  The brand accent marks where you are, on the icon alone. */}
                              <ContentTypeIcon
                                type={t}
                                className={cn('size-4 shrink-0', active && 'text-brand')}
                              />
                              <span className="truncate">{t.name}</span>
                            </span>
                            {/* A type that isn't published says so in words, on touch too, and
                                the link is named by what it shows ("Event Draft"). Forced colours
                                drop the dot's fill, so there it is drawn as a ring. */}
                            {status ? <span className="sr-only">, </span> : null}
                            {status ? (
                              <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs">
                                <StatusDot
                                  status={t.status}
                                  className="forced-colors:border forced-colors:border-[CanvasText]"
                                />
                                {status}
                              </span>
                            ) : null}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
              {typesQuery.isPending ? (
                <ul className="flex flex-col gap-0.5">
                  {['72%', '55%', '64%', '48%'].map((w) => (
                    <li key={w} aria-hidden="true" className="px-2.5 py-1.5 text-sm touch:min-h-11">
                      <SkeletonText width={w} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {types.length === 0 && !typesQuery.isPending && (
                <p className="px-2.5 py-1 text-muted-foreground text-sm">No content types yet.</p>
              )}
            </div>
          </nav>
        )}

        <section className="min-w-0">
          <Outlet context={outlet} />
        </section>
      </div>
    </div>
  );
}

/**
 * The id of a group's heading in the content types nav, by its place in the list: two group names
 * that differ only in punctuation ("A B", "A-B") would collide as slugs.
 */
const sectionId = (index: number) => `content-types-group-${index}`;

/**
 * Content types by their `group`, for the nav: the ungrouped first (as `group: undefined`), then
 * each group by name. Within a section the types keep the model's order.
 */
export function groupContentTypes<T extends { readonly group?: string }>(
  types: readonly T[],
): { group?: string; types: T[] }[] {
  const ungrouped = types.filter((t) => !t.group);
  const byGroup = new Map<string, T[]>();
  for (const t of types) {
    if (!t.group) continue;
    byGroup.set(t.group, [...(byGroup.get(t.group) ?? []), t]);
  }
  const groups = [...byGroup.keys()].sort((a, b) => a.localeCompare(b));
  return [
    ...(ungrouped.length > 0 ? [{ types: ungrouped }] : []),
    ...groups.map((group) => ({ group, types: byGroup.get(group) ?? [] })),
  ];
}
