/**
 * What every CMS screen runs inside: toasts, TanStack Query (client-side server state), the
 * space / environment / locale scope with its Management client, and the feature switches.
 * Mounted once by the shell (routes/shell.tsx), so the header's switchers and the command
 * palette share the screens' cache. Nothing here fetches on the server: queries run after
 * hydration, and the scope is read from the browser.
 */

import { Button } from '@contentworker/ui/button';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useCan } from '~/lib/use-me';
import { CreateSpaceDialog } from './components/layout/CreateSpaceDialog';
import { Body } from './components/page';
import { ClientProvider, useClient, useScopeState } from './lib/client-context';
import { FeaturesProvider } from './lib/features';
import { AppQueryProvider } from './lib/query';
import { ToastProvider } from './lib/toast';

export function CmsProviders({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <AppQueryProvider>
        <ClientProvider>
          <FeaturesProvider value={{}}>{children}</FeaturesProvider>
        </ClientProvider>
      </AppQueryProvider>
    </ToastProvider>
  );
}

/**
 * A CMS screen: its title, the page's body width, and — until the scope is known (after
 * hydration, once `GET /spaces` answers) — a quiet loading line, or why there's nothing to show.
 */
export function CmsPage({
  title,
  children,
  bare,
}: {
  title: string;
  children: React.ReactNode;
  /** Skip the body width (screens that lay out their own full-bleed canvas). */
  bare?: boolean;
}) {
  const state = useScopeState();
  const inner =
    state === 'ready' ? (
      children
    ) : state === 'no-spaces' ? (
      <NoSpaces page={title} />
    ) : state === 'error' ? (
      <ScopeNotice page={title} title="Couldn’t load your spaces">
        The API didn’t answer. Reload the page to try again.
      </ScopeNotice>
    ) : (
      <p className="pt-7 text-muted-foreground text-sm" role="status">
        Loading…
      </p>
    );
  return (
    <>
      <title>{`${title} · contentworker`}</title>
      {bare && state === 'ready' ? inner : <Body>{inner}</Body>}
    </>
  );
}

/**
 * No space to work in. A deployment admin creates the first one here (with the sample content,
 * or empty), and lands in it; anyone else is told who can let them in.
 */
function NoSpaces({ page }: { page: string }) {
  const admin = useCan('admin');
  const { updateConn } = useClient();
  const [open, setOpen] = useState(false);
  if (!admin) {
    return (
      <ScopeNotice page={page} title="No spaces yet">
        You aren’t on any space in this deployment yet. Ask a deployment admin to add you to one.
      </ScopeNotice>
    );
  }
  return (
    <ScopeNotice
      page={page}
      title="Create your first space"
      action={
        <>
          <Button className="mt-4" onClick={() => setOpen(true)}>
            <Plus aria-hidden="true" /> Create a space
          </Button>
          <CreateSpaceDialog
            open={open}
            onOpenChange={setOpen}
            onCreated={(id) => updateConn({ space: id, environment: 'main' })}
          />
        </>
      }
    >
      A space holds a content model, its entries and media, and the team that works on them. Start
      with sample content to see every part of the CMS at work, or with an empty space to model your
      own.
    </ScopeNotice>
  );
}

/** Why a screen has nothing to show: under the page's own h1, so it still says where you are. */
function ScopeNotice({
  page,
  title,
  action,
  children,
}: {
  page: string;
  title: string;
  /** What to do about it, in place of the link to the account page. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="pt-7">
      <h1 className="font-semibold text-[1.75rem] leading-tight tracking-title">{page}</h1>
      <section className="card mt-5 max-w-2xl px-5 py-4" aria-labelledby="cms-scope-notice">
        <h2 id="cms-scope-notice" className="section-title">
          {title}
        </h2>
        <p className="mt-1 max-w-measure text-muted-foreground text-sm">{children}</p>
        {action ?? (
          <Link
            to="/account"
            className="mt-3 inline-block font-medium text-link text-sm hover:underline"
          >
            Your account
          </Link>
        )}
      </section>
    </div>
  );
}
