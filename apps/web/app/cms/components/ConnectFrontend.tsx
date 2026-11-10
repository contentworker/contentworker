/**
 * Settings → Access → Connect a frontend: everything a site needs to read this space, on one page.
 * It mints the keys (`connectFrontend`, shown once), prints the config for the frontend runtime,
 * the SDK, a Next.js draft mode and live preview, sets the preview URL on the types that have pages
 * (`setContentTypePreview`), and checks that a site's page connects for live preview. It sits under
 * Access because what it makes is keys; the config is text over what `connectFrontend` answers.
 */

import {
  type ContentType,
  checkPreviewTemplate,
  frontendEndpoints,
  ValidationError,
} from '@contentworker/domain';
import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { Checkbox } from '@contentworker/ui/checkbox';
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@contentworker/ui/code-block';
import { Input } from '@contentworker/ui/input';
import { Label } from '@contentworker/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentworker/ui/select';
import { Skeleton } from '@contentworker/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@contentworker/ui/tabs';
import { KeyRound } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ConfirmButton } from '~/cms/components/InlineConfirm';
import { Section } from '~/cms/components/page';
import { ToneBadge } from '~/cms/components/status';
import { useClient } from '../lib/client-context';
import {
  DELIVERY_KEY_PLACEHOLDER,
  type FrontendConfigInput,
  livePreview,
  NEXT_DRAFT_TEMPLATE,
  nextClient,
  nextDraftRoute,
  RUNTIME_SECRET_COMMAND,
  runtimeVars,
  sdkClient,
  sdkEnv,
} from '../lib/frontend-config';
import { apiErrorMessage, type FrontendConnection, type ManagementClient } from '../lib/management';
import {
  useContentTypesQuery,
  useInvalidate,
  useScopedQuery,
  useSpaceConfigQuery,
} from '../lib/queries';
import { useToast } from '../lib/toast';
import { type ConnectionResult, useConnectionCheck } from './pane/use-connection-check';

const ROLE_NONE = '__none__';
export const CONNECT_FRONTEND_GUIDE = 'https://docs.contentworker.app/guides/connect-a-frontend/';

export function ConnectFrontend(props: { client: ManagementClient }) {
  const { client } = props;
  const { conn } = useClient();
  const config = useSpaceConfigQuery();
  // Held for this visit only: the tokens are never stored, and leaving the page forgets them.
  const [connection, setConnection] = useState<FrontendConnection>();
  // Before keys are minted, the endpoints this admin's own origin implies (the server answers the
  // same from its configured origin once keys are minted).
  const [origin, setOrigin] = useState<string>();
  useEffect(() => setOrigin(window.location.origin), []);
  const endpoints =
    connection?.endpoints ?? (origin ? frontendEndpoints(origin) : undefined) ?? undefined;
  const input: FrontendConfigInput | undefined = endpoints
    ? {
        space: conn.space,
        environment: connection?.environment ?? conn.environment,
        locale: config.data?.defaultLocale ?? conn.locale,
        endpoints,
        ...(connection ? { deliveryToken: connection.deliveryKey.token } : {}),
        ...(connection?.previewKey ? { previewToken: connection.previewKey.token } : {}),
      }
    : undefined;

  return (
    <div className="space-y-5">
      <KeysSection client={client} connection={connection} onConnected={setConnection} />
      <ConfigSection input={input} />
      <PreviewUrlsSection client={client} />
      <CheckSection client={client} />
    </div>
  );
}

// --- keys --------------------------------------------------------------------------------------

function KeysSection(props: {
  client: ManagementClient;
  connection: FrontendConnection | undefined;
  onConnected: (c: FrontendConnection) => void;
}) {
  const { client, connection, onConnected } = props;
  const { conn } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [name, setName] = useState('');
  const [roleId, setRoleId] = useState(ROLE_NONE);
  const [previewRoleId, setPreviewRoleId] = useState(ROLE_NONE);
  const [withPreview, setWithPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  // Once keys are shown, minting more replaces them on screen: asked first, since they won't be
  // shown again.
  const [another, setAnother] = useState(false);
  const roles = useScopedQuery(['roles'], () => client.listRoles()).data ?? [];
  const nameId = useId();

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const created = await client.connectFrontend({
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(roleId === ROLE_NONE ? {} : { roleId }),
        ...(withPreview ? { preview: true } : {}),
        ...(withPreview && previewRoleId !== ROLE_NONE ? { previewRoleId } : {}),
      });
      onConnected(created);
      setAnother(false);
      setName('');
      await invalidate(['api-keys']);
      toast.success(created.previewKey ? 'Keys created' : 'Key created');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    // Section's title is an <h2>: the e2e finds the screen by it.
    <Section
      title="Connect a frontend"
      description={
        <>
          A Delivery key reads published content; a Preview key reads drafts, for a server that
          reads them itself. A preview link reads its own entry without one. The config below reads{' '}
          <span className="font-mono">{conn.environment}</span>. Keys are listed, and revoked, under{' '}
          <Link to="/settings/api-keys" className="font-medium text-link hover:underline">
            API keys
          </Link>
          .
        </>
      }
    >
      <div className="space-y-4">
        {connection ? <MintedKeys connection={connection} /> : null}
        {connection && !another ? (
          <ConfirmButton
            message="Create other keys?"
            note="The keys above won’t be shown again. They stay live until revoked under API keys."
            confirmLabel="Create other keys"
            tone="default"
            onConfirm={() => setAnother(true)}
          >
            {(ask) => (
              <Button type="button" variant="outline" onClick={ask}>
                Create other keys…
              </Button>
            )}
          </ConfirmButton>
        ) : (
          // The Preview key's options go on lines of their own under the row, so ticking it moves
          // nothing a pointer may be on its way to.
          <form className="space-y-3" onSubmit={create}>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={nameId}>Name</Label>
                <Input
                  id={nameId}
                  className="w-56"
                  placeholder="Frontend"
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <RoleSelect
                label="Delivery key role"
                roles={roles}
                value={roleId}
                onValueChange={setRoleId}
              />
              <Button type="submit" disabled={busy} className="min-w-28">
                {busy ? 'Creating…' : withPreview ? 'Create keys' : 'Create key'}
              </Button>
            </div>
            <Label className="flex w-fit items-center gap-2 font-normal">
              {/* A Radix checkbox in a wrapping label gets no name in a real browser: named here. */}
              <Checkbox
                aria-label="Also create a Preview key"
                checked={withPreview}
                onCheckedChange={(c) => setWithPreview(c === true)}
              />
              <span>Also create a Preview key</span>
              <span className="text-muted-foreground">
                (a server that reads drafts itself; Next.js draft mode needs none)
              </span>
            </Label>
            {withPreview ? (
              <div className="ps-6">
                <RoleSelect
                  label="Preview key role"
                  roles={roles}
                  value={previewRoleId}
                  onValueChange={setPreviewRoleId}
                />
              </div>
            ) : null}
          </form>
        )}
      </div>
    </Section>
  );
}

/**
 * A key's role narrows what it reads to the role's content grants. The role's scopes become the
 * key's, so the server refuses one that holds more than the key's kind does.
 */
function RoleSelect(props: {
  label: string;
  roles: readonly { id: string; name: string }[];
  value: string;
  onValueChange: (v: string) => void;
}) {
  return (
    <Select value={props.value} onValueChange={props.onValueChange}>
      <SelectTrigger aria-label={props.label} className="w-[220px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ROLE_NONE}>{`${props.label}: none`}</SelectItem>
        {props.roles.map((r) => (
          <SelectItem key={r.id} value={r.id}>
            {r.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function MintedKeys({ connection }: { connection: FrontendConnection }) {
  const keys = [
    { label: 'Delivery key', token: connection.deliveryKey.token },
    ...(connection.previewKey
      ? [{ label: 'Preview key', token: connection.previewKey.token }]
      : []),
  ];
  return (
    <Alert>
      <KeyRound />
      <AlertTitle className="line-clamp-none">
        Copy {keys.length > 1 ? 'these keys' : 'this key'} now: {keys.length > 1 ? 'they' : 'it'}{' '}
        won’t be shown again.
      </AlertTitle>
      <AlertDescription className="space-y-2">
        <p>Keep them as server-side secrets, never in client code or a URL.</p>
        <dl className="space-y-2">
          {keys.map((k) => (
            <div key={k.label} className="flex flex-wrap items-center gap-2">
              <dt className="caption w-28">{k.label}</dt>
              <dd className="flex min-w-0 flex-1 items-center gap-2">
                <code className="min-w-0 break-all font-mono text-foreground text-xs">
                  {k.token}
                </code>
                <CodeBlockCopyButton
                  value={k.token}
                  variant="outline"
                  size="icon-sm"
                  aria-label={`Copy ${k.label.toLowerCase()}`}
                />
              </dd>
            </div>
          ))}
        </dl>
      </AlertDescription>
    </Alert>
  );
}

// --- config ------------------------------------------------------------------------------------

function Snippet(props: { title: string; code: string }) {
  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle>{props.title}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={props.code} aria-label={`Copy ${props.title}`} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent aria-label={props.title}>{props.code}</CodeBlockContent>
    </CodeBlock>
  );
}

function ConfigSection({ input }: { input: FrontendConfigInput | undefined }) {
  const placeholders = input && !input.deliveryToken;
  return (
    <Section
      title="Configuration"
      description={
        placeholders
          ? `Create a key above and these fill in with it; until then they say ${DELIVERY_KEY_PLACEHOLDER}.`
          : 'Ready to paste. Each key goes where a secret goes.'
      }
    >
      {!input ? (
        <div aria-busy="true" className="space-y-2">
          <span className="sr-only">Loading the configuration</span>
          <Skeleton className="h-9 w-72" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <Tabs defaultValue="runtime">
          <TabsList aria-label="How your site reads content" className="w-full overflow-x-auto">
            <TabsTrigger value="runtime">Frontend runtime</TabsTrigger>
            <TabsTrigger value="sdk">SDK</TabsTrigger>
            <TabsTrigger value="next">Next.js</TabsTrigger>
            <TabsTrigger value="live">Live preview</TabsTrigger>
          </TabsList>
          <TabsContent value="runtime" className="space-y-3 pt-3">
            <p className="max-w-measure text-muted-foreground text-sm">
              For a site on <span className="font-mono">@contentworker/frontend</span>: add these to
              its <span className="font-mono">wrangler.jsonc</span>, then store the Delivery key as
              a secret, pasted when wrangler asks for it.
            </p>
            <Snippet title="wrangler.jsonc" code={runtimeVars(input)} />
            <Snippet title="Store the key" code={RUNTIME_SECRET_COMMAND} />
          </TabsContent>
          <TabsContent value="sdk" className="space-y-3 pt-3">
            <p className="max-w-measure text-muted-foreground text-sm">
              For any JavaScript runtime. Read the key on the server only.
            </p>
            <Snippet title=".env" code={sdkEnv(input, Boolean(input.previewToken))} />
            <Snippet title="Delivery client" code={sdkClient(input)} />
          </TabsContent>
          <TabsContent value="next" className="space-y-3 pt-3">
            <p className="max-w-measure text-muted-foreground text-sm">
              A preview link turns draft mode on for its one entry: that entry reads as it is now,
              with the link’s own token, and everything else as published. No Preview key. Point
              each type’s preview URL at the route, as{' '}
              <span className="break-all font-mono">{NEXT_DRAFT_TEMPLATE}</span>.
            </p>
            <Snippet title=".env.local" code={sdkEnv(input, false)} />
            <Snippet title="Draft route" code={nextDraftRoute(input)} />
            <Snippet title="Client" code={nextClient(input)} />
          </TabsContent>
          <TabsContent value="live" className="space-y-3 pt-3">
            <p className="max-w-measure text-muted-foreground text-sm">
              The entry editor’s Site view frames your page; this lets the page connect to this
              admin and show edits as they’re typed. React sites can use{' '}
              <span className="font-mono">useLivePreview</span> from{' '}
              <span className="font-mono">@contentworker/sdk/react</span>.
            </p>
            <Snippet title="Connect the page" code={livePreview(input)} />
          </TabsContent>
        </Tabs>
      )}
    </Section>
  );
}

// --- preview URLs ------------------------------------------------------------------------------

function PreviewUrlsSection({ client }: { client: ManagementClient }) {
  // Every type, as the API lists them: whether one has pages is the site's to say, not ours.
  const types = useContentTypesQuery();
  const pages = types.data ?? [];
  return (
    <Section
      title="Preview URLs"
      description="Where your site shows a draft of each type’s entries, and the page the editor frames; also set in each content type’s settings. Needs {token}; can use {id}, {locale} and a field, as {field:slug}."
    >
      {types.isPending ? (
        <div aria-busy="true" className="space-y-2">
          <span className="sr-only">Loading content types</span>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : pages.length === 0 ? (
        <p className="max-w-measure text-muted-foreground text-sm">
          No content types yet: a type’s preview URL is set once it exists.
        </p>
      ) : (
        <ul className="space-y-4">
          {pages.map((t) => (
            <PreviewUrlRow key={t.apiId} client={client} type={t} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function PreviewUrlRow({ client, type }: { client: ManagementClient; type: ContentType }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const stored = type.preview?.urlTemplate ?? '';
  const [value, setValue] = useState(stored);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(stored), [stored]);
  // A refusal is said beside the field, and focus goes back to it so the reason is read.
  const refuse = (message: string) => {
    setError(message);
    inputRef.current?.focus();
  };
  const changed = value.trim() !== stored;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const template = value.trim();
    if (template) {
      try {
        // The domain's own check, so the field says what is wrong before the save is refused.
        checkPreviewTemplate(template, type.fields, { allowLoopback: true });
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        refuse(err.issues[0]?.message ?? 'This preview URL can’t be used.');
        return;
      }
    }
    setBusy(true);
    try {
      await client.setContentTypePreview(type.apiId, template || null);
      await invalidate(['content-types']);
      toast.success(template ? `Preview URL saved for ${type.name}` : `Preview URL cleared`);
    } catch (err) {
      refuse(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li>
      <form className="space-y-1.5" onSubmit={save}>
        <Label htmlFor={id}>
          {type.name} <span className="font-mono text-muted-foreground text-xs">{type.apiId}</span>
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            ref={inputRef}
            id={id}
            className="min-w-0 flex-1 font-mono"
            inputMode="url"
            spellCheck={false}
            placeholder="https://your-site.example/__preview?entry={id}#token={token}"
            value={value}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setError(undefined);
            }}
          />
          <Button type="submit" variant="outline" disabled={!changed || busy}>
            {busy ? 'Saving…' : value.trim() || !stored ? 'Save' : 'Clear'}
          </Button>
        </div>
        {error ? (
          <p id={`${id}-error`} role="alert" className="max-w-measure text-destructive text-ui">
            {error}
          </p>
        ) : null}
      </form>
    </li>
  );
}

// --- live check --------------------------------------------------------------------------------

function CheckSection({ client }: { client: ManagementClient }) {
  const { conn } = useClient();
  const types = useContentTypesQuery();
  const framed = useMemo(() => (types.data ?? []).filter((t) => t.preview), [types.data]);
  const [picked, setPicked] = useState<string>();
  const typeId = picked && framed.some((t) => t.apiId === picked) ? picked : framed[0]?.apiId;
  const [run, setRun] = useState(0);
  // The type's most recent entry: the page the check frames.
  const entries = useScopedQuery(
    ['entries', typeId ?? 'none', 'connection-check'],
    () => (typeId ? client.listEntries(typeId, { limit: 1 }) : Promise.resolve([])),
    { enabled: Boolean(typeId) },
  );
  const entryId = entries.data?.[0]?.id;
  const check = useConnectionCheck({
    spaceId: conn.space,
    environmentId: conn.environment,
    entryId,
    run,
  });

  return (
    <Section
      title="Check the connection"
      description="Opens an entry’s page from its preview URL, out of sight, and asks whether it connects for live preview, as the editor’s Site view will."
    >
      {framed.length === 0 ? (
        <p className="max-w-measure text-muted-foreground text-sm">
          Set a preview URL above to check a site.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={typeId}
              onValueChange={(v) => {
                // Another type is another page: checked when asked, not on the pick.
                setPicked(v);
                setRun(0);
              }}
            >
              <SelectTrigger aria-label="Content type to check" className="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {framed.map((t) => (
                  <SelectItem key={t.apiId} value={t.apiId}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              disabled={!entryId || check.checking}
              onClick={() => setRun((n) => n + 1)}
            >
              {check.checking ? 'Checking…' : 'Check connection'}
            </Button>
          </div>
          {entries.isSuccess && !entryId ? (
            <p className="max-w-measure text-muted-foreground text-ui">
              This type has no entries yet: add one to check its page.
            </p>
          ) : null}
          <div aria-live="polite">
            {check.result ? <CheckResult result={check.result} /> : null}
          </div>
          {check.src ? (
            <iframe
              key={check.frameKey}
              ref={check.frameRef}
              src={check.src}
              title="Connection check"
              aria-hidden="true"
              tabIndex={-1}
              // Nothing in the page can take focus or be reached while it is out of sight.
              inert
              // Out of sight but laid out at a real size: a page can lay itself out and connect.
              className="pointer-events-none fixed top-0 -left-[200vw] h-[600px] w-[800px] border-0"
            />
          ) : null}
        </div>
      )}
    </Section>
  );
}

function CheckResult({ result }: { result: ConnectionResult }) {
  switch (result.state) {
    case 'checking':
      return <ToneBadge tone="run" label="Checking" />;
    case 'connected':
      return (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <ToneBadge tone="ok" label="Connected" />
          <span>
            {result.origin ? <span className="font-mono">{result.origin}</span> : 'The page'}{' '}
            connects for live preview.
          </span>
        </p>
      );
    case 'sdk':
      return (
        <Alert variant="destructive">
          <AlertTitle className="line-clamp-none">
            {result.detail === 'new' ? 'The site’s SDK is too new' : 'The site’s SDK is too old'}
          </AlertTitle>
          <AlertDescription>
            <p>
              Its <span className="font-mono">@contentworker/sdk</span> shares no live preview
              version with this admin. Use a release this admin supports.
            </p>
          </AlertDescription>
        </Alert>
      );
    case 'not-connected':
      return (
        <Alert>
          <AlertTitle className="line-clamp-none">
            {result.reason === 'failed' ? 'The page didn’t load' : 'Not connected'}
          </AlertTitle>
          <AlertDescription>
            <p>{NOT_CONNECTED[result.reason]}</p>
            {result.reason === 'origin' && result.detail ? (
              <p>
                It answered from <span className="font-mono">{result.detail}</span>.
              </p>
            ) : null}
            <a
              href={CONNECT_FRONTEND_GUIDE}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-link hover:underline"
            >
              Connect a frontend guide<span className="sr-only"> (opens in a new tab)</span>
            </a>
          </AlertDescription>
        </Alert>
      );
    case 'unavailable':
      return (
        <Alert variant="destructive">
          <AlertTitle className="line-clamp-none">The connection couldn’t be checked</AlertTitle>
          <AlertDescription>
            <p>{UNAVAILABLE[result.detail ?? ''] ?? UNAVAILABLE.error}</p>
          </AlertDescription>
        </Alert>
      );
  }
}

const NOT_CONNECTED: Record<string, string> = {
  silent:
    'The page loaded but didn’t offer to connect: call connectPreview with this admin’s origin.',
  failed: 'Check that the site is running and lets this admin frame it (frame-ancestors).',
  origin: 'The page answered from another address than its preview URL names.',
  navigated: 'The page went to an address none of the preview URLs name.',
};

const UNAVAILABLE: Record<string, string> = {
  'not-found': 'Its entry can’t be found in this space and environment.',
  refused: 'Your role can’t make a preview link for this type.',
  incomplete: 'Its entry has no page yet: fill in the fields its preview URL names.',
  error: 'The preview link couldn’t be made. Try again in a moment.',
};
