import { users } from '@contentworker/db/auth';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@contentworker/ui/dropdown-menu';
import { cn } from '@contentworker/ui/lib/utils';
import { Segmented, SegmentedItem } from '@contentworker/ui/segmented';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@contentworker/ui/sheet';
import { and, eq, isNull } from 'drizzle-orm';
import {
  Ellipsis,
  FileText,
  LayoutDashboard,
  Monitor,
  Moon,
  Rocket,
  Search,
  Stamp,
  Sun,
  UserRound,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  Link,
  NavLink,
  Outlet,
  useLoaderData,
  useLocation,
  useNavigate,
  useNavigation,
} from 'react-router';
import { CommandPalette, openCommandPalette } from '~/cms/components/layout/CommandPalette';
import { OPEN_SHORTCUTS_EVENT } from '~/cms/components/layout/KeyboardShortcuts';
import { NewEntry } from '~/cms/components/layout/NewEntry';
import { SpaceSwitcher } from '~/cms/components/layout/SpaceSwitcher';
import { useOptionalClient } from '~/cms/lib/client-context';
import { useModKeyLabel, usePageShortcutGroups } from '~/cms/lib/shortcuts';
import { CmsProviders } from '~/cms/providers';
import { Mark } from '~/components/mark';
import { authEnabled, requireUser } from '~/lib/auth.server';
import { db } from '~/lib/env.server';
import { atLeast, type Principal, ROLE_LABELS } from '~/lib/roles';
import { SCREENS } from '~/lib/screens';
import { pageShortcut } from '~/lib/shortcuts';
import { type ThemeChoice, useTheme } from '~/lib/theme';
import type { Route } from './+types/shell';

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request);
  // Until their two-factor sign-in or own password is set, a person sees only their Account page.
  if (me.twoFactorDue || me.passwordChangeDue) return { auth: true, me, nav: false, admins: [] };
  const [admins, auth] = await Promise.all([
    // Who to ask when a page needs a higher role: up to three active admins.
    atLeast(me.role, 'admin')
      ? []
      : db()
          .select({ name: users.name, email: users.email })
          .from(users)
          .where(and(eq(users.role, 'admin'), isNull(users.disabledAt)))
          .orderBy(users.name)
          .limit(3),
    authEnabled(),
  ]);
  return { auth, me, nav: true, admins };
}

type NavItem = { to: string; label: string; end?: boolean };

/** The CMS, in this order everywhere: the day's work, then the library, then settings. */
const NAV: { title?: string; items: NavItem[] }[] = [
  {
    items: [
      { to: '/dashboard', label: 'Overview' },
      { to: SCREENS.content.to, label: SCREENS.content.label },
      { to: SCREENS.approvals.to, label: SCREENS.approvals.label },
      { to: SCREENS.releases.to, label: SCREENS.releases.label },
    ],
  },
  {
    title: 'Library',
    items: [
      { to: SCREENS.media.to, label: SCREENS.media.label },
      { to: SCREENS.taxonomy.to, label: SCREENS.taxonomy.label },
      { to: SCREENS.workflows.to, label: SCREENS.workflows.label },
    ],
  },
  { title: 'Space', items: [{ to: SCREENS.settings.to, label: SCREENS.settings.label }] },
];

/** The deployment's own pages, for admins. */
const WORKSPACE: NavItem[] = [
  { to: '/team', label: 'People and sign-in' },
  { to: '/audit', label: 'Audit log' },
];

/** Phones: the day's work as tabs, everything else under More. */
const TABS: (NavItem & { icon: typeof Sun })[] = [
  { to: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { to: '/content', label: 'Content', icon: FileText },
  { to: '/approvals', label: 'Approvals', icon: Stamp },
  { to: '/releases', label: 'Releases', icon: Rocket },
];

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'Match system', icon: Monitor },
];

/** Go-to keys: G, then a letter. */
const GO: { key: string; to: string; label: string }[] = [
  { key: 'h', to: '/dashboard', label: 'Overview' },
  { key: 'c', to: '/content', label: 'Content' },
  { key: 'a', to: '/approvals', label: 'Approvals' },
  { key: 'r', to: '/releases', label: 'Releases' },
  { key: 'w', to: '/workflows', label: 'Workflows' },
  { key: 'm', to: '/media', label: 'Media' },
  { key: 't', to: '/taxonomy', label: 'Taxonomy' },
  { key: 's', to: SCREENS.settings.to, label: 'Settings' },
];

/** Whether `path` is the link's page or under it. Settings' sections all count as Settings. */
const isAt = (path: string, { to, end }: NavItem) => {
  const base = to.startsWith('/settings/') ? '/settings' : to;
  return end ? path === base : path === base || path.startsWith(`${base}/`);
};

/**
 * G then a letter goes to a page; ? lists the shortcuts. Page shortcuts' rules apply (not while
 * typing or with a menu open), and the listener runs first, so a page's own keys never see the
 * letter that finished a G.
 */
function useGoKeys(onHelp: () => void) {
  const navigate = useNavigate();
  useEffect(() => {
    let armed = 0;
    const onKey = (e: KeyboardEvent) => {
      if (!pageShortcut(e)) {
        armed = 0;
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        armed = 0;
        onHelp();
        return;
      }
      const go = Date.now() - armed < 1500 ? GO.find((g) => g.key === e.key) : undefined;
      if (go) {
        e.preventDefault();
        e.stopImmediatePropagation();
        armed = 0;
        navigate(go.to);
        return;
      }
      armed = e.key === 'g' ? Date.now() : 0;
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [navigate, onHelp]);
}

/** Keys, joined by "then" for a sequence or "+" for a chord. */
function Keys({ keys, chord }: { keys: readonly string[]; chord?: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
      {keys.map((k, i) => (
        <span key={`${i}-${k}`} className="contents">
          {i ? (chord ? '+' : 'then') : null}
          <kbd className="min-w-6 rounded-md border px-1.5 py-0.5 text-center font-sans text-foreground text-xs">
            {k}
          </kbd>
        </span>
      ))}
    </span>
  );
}

/** Every keyboard shortcut, from ? or the account menu. */
function ShortcutsSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const row = 'flex items-center justify-between gap-4 py-1.5 text-sm';
  // The page's own keys (J/K/X in a table, the editor's ⌘S), as the screen registers them.
  const pageGroups = usePageShortcutGroups();
  const mod = useModKeyLabel();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0 overflow-y-auto">
        <div className="border-b px-4 pt-4 pb-3 pr-14">
          <SheetTitle className="font-semibold text-base tracking-title">
            Keyboard shortcuts
          </SheetTitle>
          <SheetDescription className="text-xs">
            Single keys work outside fields, with no menu open.
          </SheetDescription>
        </div>
        <section className="px-4 pt-3 pb-2">
          <h3 className="caption mb-1">Everywhere</h3>
          <ul>
            {GO.map((g) => (
              <li key={g.key} className={row}>
                {`Go to ${g.label}`}
                <Keys keys={['G', g.key.toUpperCase()]} />
              </li>
            ))}
            <li className={row}>
              Search and run commands
              <Keys keys={[mod, 'K']} chord />
            </li>
            <li className={row}>
              This list
              <Keys keys={['?']} />
            </li>
          </ul>
        </section>
        {pageGroups.map((g) => (
          <section key={g.id} className="border-t px-4 pt-3 pb-2">
            <h3 className="caption mb-1">{g.title}</h3>
            <ul>
              {g.items.map((it) => (
                <li key={it.label} className={row}>
                  {it.label}
                  <Keys keys={it.keys.map((k) => (k === 'Mod' ? mod : k))} chord={it.chord} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </SheetContent>
    </Sheet>
  );
}

/** Colour changes named so they leave the focus outline alone. */
const tint = 'transition-[color,background-color,border-color]';

/** Where a navigation is heading (so the link you chose marks at once), else where you are. */
function useCurrentPath() {
  const { pathname } = useLocation();
  const navigation = useNavigation();
  return navigation.state === 'loading' && !navigation.formMethod
    ? navigation.location.pathname
    : pathname;
}

/** True once a navigation has taken longer than `after` ms; quick ones never flash a cue. */
function useSlowNavigation(after = 400) {
  const loading = useNavigation().state === 'loading';
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading) {
      setSlow(false);
      return;
    }
    const t = window.setTimeout(() => setSlow(true), after);
    return () => window.clearTimeout(t);
  }, [loading, after]);
  return slow;
}

/** Under the top bar while a page is slow to arrive. */
function PendingBar() {
  return useSlowNavigation() ? (
    <div className="absolute inset-x-0 -bottom-px h-0.5 overflow-hidden" aria-hidden="true">
      <div className="cw-pending h-full w-2/5 bg-link" />
    </div>
  ) : null;
}

export default function Shell() {
  const slow = useSlowNavigation();
  const { auth, me, nav: showNav } = useLoaderData<typeof loader>();
  const workspace = showNav && atLeast(me.role, 'admin') ? WORKSPACE : [];
  const path = useCurrentPath();
  const [shortcuts, setShortcuts] = useState(false);
  const openShortcuts = useCallback(() => setShortcuts(true), []);
  useGoKeys(openShortcuts);
  // The command palette's "Keyboard shortcuts" opens the same sheet.
  useEffect(() => {
    window.addEventListener(OPEN_SHORTCUTS_EVENT, openShortcuts);
    return () => window.removeEventListener(OPEN_SHORTCUTS_EVENT, openShortcuts);
  }, [openShortcuts]);
  return (
    <CmsProviders>
      <div className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-card px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
        >
          Skip to content
        </a>
        {/* 3rem tall with its rule, under the status bar's inset: full-height pages subtract
          --shell-h (app.css). */}
        <header className="sticky top-0 z-40 border-b bg-background pt-safe-0">
          <div className="flex h-[calc(3rem-1px)] items-center gap-3 px-safe-4 sm:px-safe-5">
            <Link
              to="/dashboard"
              className="hit-area -mx-1.5 flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 font-semibold tracking-title text-base"
              aria-label="contentworker overview"
            >
              <Mark className="size-5" />
              <span>contentworker</span>
            </Link>
            {/* The space, environment and locale every CMS screen works in (on a phone, in More). */}
            {showNav ? (
              <div className="hidden min-w-0 lg:flex">
                <SpaceSwitcher />
              </div>
            ) : null}
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {showNav ? <ShellNewEntry path={path} /> : null}
              {showNav ? <SearchButton /> : null}
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={`${shortWho(me)}, account menu`}
                  title={who(me)}
                  className={cn(
                    'hit-area hidden h-8 items-center gap-2 rounded-4xl border px-3 text-ui text-muted-foreground hover:bg-accent hover:text-foreground md:flex data-[state=open]:bg-accent data-[state=open]:text-foreground',
                    tint,
                  )}
                >
                  <UserRound className="size-4" aria-hidden="true" />
                  <span className="max-w-40 truncate">{shortWho(me)}</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <AccountItems me={me} auth={auth} onShortcuts={openShortcuts} />
                </DropdownMenuContent>
              </DropdownMenu>
              {/* Signing out is a POST; the account menu's item submits this. */}
              <form id="sign-out" method="post" action="/logout" hidden />
            </div>
          </div>
          <PendingBar />
        </header>
        <div className="flex min-h-0 flex-1">
          {showNav ? <Sidebar path={path} workspace={workspace} /> : null}
          <main
            id="main"
            tabIndex={-1}
            aria-busy={slow || undefined}
            className="min-w-0 flex-1 pb-[var(--tabbar-h)] outline-none md:pb-0"
          >
            <Outlet />
          </main>
        </div>
        {showNav ? <TabBar path={path} workspace={workspace} /> : null}
        {showNav ? <ShortcutsSheet open={shortcuts} onOpenChange={setShortcuts} /> : null}
        {showNav ? <CommandPalette /> : null}
      </div>
    </CmsProviders>
  );
}

/** Tablets and up: every page in a column on the left, grouped as NAV groups them. */
function Sidebar({ path, workspace }: { path: string; workspace: NavItem[] }) {
  const link = (item: NavItem) => {
    const here = isAt(path, item);
    return (
      <li key={item.to}>
        <NavLink
          to={item.to}
          end={item.end}
          aria-current={here ? 'page' : undefined}
          className={cn(
            'flex min-h-8 items-center rounded-md px-2.5 text-ui touch:min-h-11',
            tint,
            here
              ? 'bg-accent font-medium text-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          {item.label}
        </NavLink>
      </li>
    );
  };
  const groups = workspace.length ? [...NAV, { title: 'Deployment', items: workspace }] : NAV;
  return (
    <nav
      aria-label="Main"
      className="sticky top-[var(--shell-h)] hidden h-[calc(100dvh-var(--shell-h))] w-56 shrink-0 overflow-y-auto border-r px-3 py-4 md:block"
    >
      {groups.map((g, i) => (
        <div key={g.title ?? 'main'} className={cn(i > 0 && 'mt-5')}>
          {g.title ? <h2 className="caption mb-1 px-2.5">{g.title}</h2> : null}
          <ul className="space-y-0.5">{g.items.map(link)}</ul>
        </div>
      ))}
    </nav>
  );
}

/**
 * Phones: the main pages as tabs along the bottom, in thumb reach and clear of the home
 * indicator, and More for everything else.
 */
function TabBar({ path, workspace }: { path: string; workspace: NavItem[] }) {
  const { pathname } = useLocation();
  const [more, setMore] = useState(false);
  // A link in the sheet closes it by navigating; so does the back button (pathname is the trigger).
  useEffect(() => setMore(false), [pathname]);
  const inTab = TABS.some((t) => isAt(path, t));
  const item = cn(
    'relative flex flex-col items-center justify-center gap-0.5 text-2xs short:gap-0',
    tint,
  );
  const state = (active: boolean) =>
    active
      ? 'font-medium text-foreground before:absolute before:inset-x-3 before:top-0 before:h-0.5 before:bg-foreground'
      : 'text-muted-foreground';
  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 h-[var(--tabbar-h)] border-t bg-background px-safe-0 pb-[var(--safe-bottom)] md:hidden"
      >
        <ul
          className="grid h-full"
          style={{ gridTemplateColumns: `repeat(${TABS.length + 1}, 1fr)` }}
        >
          {TABS.map((t) => (
            <li key={t.to} className="contents">
              <NavLink to={t.to} className={cn(item, state(isAt(path, t)))}>
                <t.icon className="size-5" aria-hidden="true" />
                <span className="short:sr-only">{t.label}</span>
              </NavLink>
            </li>
          ))}
          <li className="contents">
            <button
              type="button"
              onClick={() => setMore(true)}
              aria-haspopup="dialog"
              aria-expanded={more}
              className={cn(item, state(more || !inTab))}
            >
              <Ellipsis className="size-5" aria-hidden="true" />
              <span className="short:sr-only">More</span>
            </button>
          </li>
        </ul>
      </nav>
      <Sheet open={more} onOpenChange={setMore}>
        <SheetContent side="bottom" className="gap-0 md:hidden">
          <MoreMenu workspace={workspace} />
        </SheetContent>
      </Sheet>
    </>
  );
}

/** The More sheet: the pages without a tab, the deployment's, then account, theme and sign-out. */
function MoreMenu({ workspace }: { workspace: NavItem[] }) {
  const { me, auth } = useLoaderData<typeof loader>();
  const theme = useTheme();
  const row =
    'flex min-h-11 items-center justify-between gap-3 rounded-md px-3 text-base hover:bg-accent aria-[current=page]:font-medium';
  const heading = 'caption px-3 pt-2 pb-1';
  const list = (items: NavItem[]) => (
    <ul>
      {items.map(({ to, label, end }) => (
        <li key={to}>
          <NavLink to={to} end={end} className={row}>
            {label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
  const pages = NAV.flatMap((g) => g.items).filter((n) => !TABS.some((t) => t.to === n.to));
  return (
    <>
      <div className="border-b px-4 pt-4 pb-3 pr-14">
        <SheetTitle className="truncate font-semibold text-base tracking-title">
          {who(me)}
        </SheetTitle>
        <SheetDescription className="text-xs">{ROLE_LABELS[me.role]}</SheetDescription>
      </div>
      <div className="border-b px-4 py-3">
        <h2 className="caption mb-2">Working in</h2>
        <SpaceSwitcher stacked />
      </div>
      <div className="max-h-[50dvh] overflow-y-auto p-2">
        <h2 className={heading}>Pages</h2>
        {list(pages)}
        {workspace.length ? (
          <>
            <h2 className={cn(heading, 'pt-3')}>Deployment</h2>
            {list(workspace)}
          </>
        ) : null}
      </div>
      <div className="border-t p-2">{list([{ to: '/account', label: 'Account' }])}</div>
      <fieldset className="border-t px-4 pt-3 pb-3">
        <legend className="caption float-left mb-2 w-full">Theme</legend>
        <Segmented
          aria-label="Theme"
          value={theme.choice}
          onValueChange={(v) => theme.setChoice(v as typeof theme.choice)}
          className="clear-left grid w-full"
        >
          {THEMES.map(({ value, label, icon: Icon }) => (
            <SegmentedItem key={value} value={value} className="min-h-10">
              <Icon aria-hidden="true" />
              {value === 'system' ? 'System' : label}
            </SegmentedItem>
          ))}
        </Segmented>
      </fieldset>
      {auth ? (
        <div className="border-t p-2">
          <form method="post" action="/logout">
            <button type="submit" className={cn(row, 'w-full text-left')}>
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </>
  );
}

/** How the signed-in person is named: their email, or open local development. */
const who = (me: Principal) => (me.kind === 'user' ? (me.email ?? me.name) : 'Sign-in is off');

/** The same, short enough for the account button. */
const shortWho = (me: Principal) =>
  me.kind === 'user' ? me.name : `${ROLE_LABELS[me.role]}, no sign-in`;

/** Who is signed in, their account, the keyboard shortcuts, the theme, and signing in or out. */
function AccountItems({
  me,
  auth,
  onShortcuts,
}: {
  me: Principal;
  auth: boolean;
  onShortcuts: () => void;
}) {
  const admin = atLeast(me.role, 'admin');
  const theme = useTheme();
  return (
    <>
      <DropdownMenuLabel className="font-normal">
        <span className="block truncate font-semibold text-foreground text-sm" title={who(me)}>
          {who(me)}
        </span>
        <span className="text-muted-foreground text-xs">{ROLE_LABELS[me.role]}</span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <Link to="/account">Account</Link>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onShortcuts} className="hidden justify-between fine:flex">
        Keyboard shortcuts
        <kbd className="font-normal font-sans text-2xs text-muted-foreground">?</kbd>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="caption">Theme</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={theme.choice}
        onValueChange={(v) => theme.setChoice(v as ThemeChoice)}
      >
        {THEMES.map(({ value: v, label, icon: Icon }) => (
          <DropdownMenuRadioItem key={v} value={v}>
            <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {auth || admin ? <DropdownMenuSeparator /> : null}
      {auth ? (
        <DropdownMenuItem asChild>
          {/* The form sits outside the menu, which unmounts as it closes. */}
          <button type="submit" form="sign-out" className="w-full">
            Sign out
          </button>
        </DropdownMenuItem>
      ) : admin ? (
        <DropdownMenuItem asChild>
          <Link to="/team">Set up sign-in</Link>
        </DropdownMenuItem>
      ) : null}
    </>
  );
}

/** ⌘K: every page, action, content type and entry (cms/components/layout/CommandPalette). */
function SearchButton() {
  const mod = useModKeyLabel();
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      title={`Search pages, entries and commands (${mod}K)`}
      aria-keyshortcuts="Meta+K Control+K"
      className={cn(
        'hit-area flex h-8 items-center gap-2 rounded-4xl border px-3 text-muted-foreground text-ui hover:bg-accent hover:text-foreground',
        tint,
      )}
    >
      <Search className="size-4" aria-hidden="true" />
      {/* Named by its word (visible from sm), so a voice command can say it. */}
      <span className="max-sm:sr-only">Search</span>
    </button>
  );
}

/**
 * New entry, in the header once the space is known: an outline on Approvals and Workflows, where
 * starting an entry isn't the page's point (cms/components/layout/NewEntry).
 */
function ShellNewEntry({ path }: { path: string }) {
  if (!useOptionalClient()?.ready) return null;
  const quiet = path.startsWith('/approvals') || path.startsWith('/workflows');
  // Phones: a floating pill above the tab bar on Content's lists, where it's the page's next step
  // (not in the editor, which keeps its own actions there).
  const float = /^\/content(\/[^/]+)?$/.test(path);
  return (
    <>
      <span className="hidden md:contents">
        <NewEntry look="header" quiet={quiet} />
      </span>
      {float ? <NewEntry look="float" /> : null}
    </>
  );
}
