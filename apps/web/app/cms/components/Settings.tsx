import { Alert, AlertAction, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@contentworker/ui/alert-dialog';
import { Badge } from '@contentworker/ui/badge';
import { Button } from '@contentworker/ui/button';
import { Card, CardContent, CardHeader } from '@contentworker/ui/card';
import { Checkbox } from '@contentworker/ui/checkbox';
import { Input } from '@contentworker/ui/input';
import { Label } from '@contentworker/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentworker/ui/select';
import { SkeletonPill, SkeletonText } from '@contentworker/ui/skeleton';
import {
  Table,
  TableBody,
  Td as TableCell,
  Th as TableHead,
  TableHead as TableHeader,
  Tr as TableRow,
} from '@contentworker/ui/table';
import { KeyRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AiActions } from '~/cms/components/AiActions';
import { AppExtensions } from '~/cms/components/AppExtensions';
import { Ago } from '~/cms/components/ago';
import { BranchMerge } from '~/cms/components/BranchMerge';
import { ConfirmDialog } from '~/cms/components/ConfirmDialog';
import { ConnectedApps } from '~/cms/components/ConnectedApps';
import { Functions } from '~/cms/components/Functions';
import { ConfirmButton } from '~/cms/components/InlineConfirm';
import { LocaleSettings } from '~/cms/components/LocaleSettings';
import { LoadingStatus } from '~/cms/components/loading';
import { Menus } from '~/cms/components/Menus';
import { Plugins } from '~/cms/components/Plugins';
import { PageHeader } from '~/cms/components/page';
import { Redirects } from '~/cms/components/Redirects';
import { RoleAccessSheet } from '~/cms/components/RoleAccessSheet';
import { StatusBadge } from '~/cms/components/status';
import { Team } from '~/cms/components/Team';
import { TrashSettings } from '~/cms/components/TrashSettings';
import { WebhookDeliveriesSheet } from '~/cms/components/WebhookDeliveriesSheet';
import { WebhookDialog } from '~/cms/components/WebhookDialog';
import { KEY_KINDS, keyKindApi, keyKindLabel } from '../lib/key-kinds';
import {
  type ApiKeyKind,
  apiErrorMessage,
  type CreatedApiKey,
  type ManagementClient,
  type RoleSummary,
  WEBHOOK_TOPICS,
  type WebhookSummary,
  type WebhookTopic,
} from '../lib/management';
import { useContentTypesQuery, useInvalidate, useScopedQuery } from '../lib/queries';
import { describeGrants, saveRoleGrants } from '../lib/role-grants';
import { useToast } from '../lib/toast';
import { DEFAULT_SETTINGS_SECTION } from './layout/nav';
import { SettingsNav } from './layout/SettingsNav';

/** What each `/settings/:section` renders. Ids and grouping live in layout/nav.ts. */
const SECTION_BODY: Record<string, (client: ManagementClient) => React.ReactNode> = {
  team: (client) => <Team client={client} />,
  'api-keys': (client) => <ApiKeys client={client} />,
  roles: (client) => <RolesSettings client={client} />,
  'connected-apps': (client) => <ConnectedApps client={client} />,
  webhooks: (client) => <Webhooks client={client} />,
  functions: (client) => <Functions client={client} />,
  'ai-actions': (client) => <AiActions client={client} />,
  extensions: (client) => <AppExtensions client={client} />,
  plugins: (client) => <Plugins client={client} />,
  locales: (client) => <LocaleSettings client={client} />,
  redirects: (client) => <Redirects client={client} />,
  menus: (client) => <Menus client={client} />,
  trash: (client) => <TrashSettings client={client} />,
  environments: (client) => <Environments client={client} />,
  'audit-log': (client) => <AuditLog client={client} />,
};

/**
 * Space settings, one URL per section (`/settings/:section`), grouped in a
 * section nav (Access, Automation, Extensions, Workspace): a vertical list
 * beside the section from md, a grouped select above it on a phone.
 */
export function Settings(props: {
  client: ManagementClient;
  section: string;
  onSection: (section: string) => void;
}) {
  const { client, section, onSection } = props;
  const body = SECTION_BODY[section] ?? SECTION_BODY[DEFAULT_SETTINGS_SECTION];

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Access, automation, extensions, and workspace configuration for this space."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[11rem_minmax(0,1fr)] md:gap-8">
        <SettingsNav section={section} onSection={onSection} />
        <div className="min-w-0">{body?.(client)}</div>
      </div>
    </div>
  );
}

/** Environments + repointable aliases (blue/green). An alias resolves to a
 *  target environment anywhere `:env` is accepted; repointing is atomic cutover. */
function Environments(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const invalidate = useInvalidate();
  const [alias, setAlias] = useState('');
  const [pickedTarget, setPickedTarget] = useState('');
  const [busy, setBusy] = useState(false);

  const environments = useScopedQuery(['environments'], () => client.listEnvironments()).data ?? [];
  const aliases =
    useScopedQuery(['environment-aliases'], () => client.listEnvironmentAliases()).data ?? [];
  // Default the target picker to the first environment until the user chooses.
  const target = pickedTarget || environments[0]?.id || '';

  const reload = () => invalidate(['environments'], ['environment-aliases']);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await client.setEnvironmentAlias(alias.trim(), target);
      setAlias('');
      await reload();
      toast.success(`Alias “${alias.trim()}” → ${target}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    try {
      await client.deleteEnvironmentAlias(name);
      await reload();
      toast.success('Alias deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const repoint = async (name: string, targetEnvironmentId: string) => {
    try {
      await client.setEnvironmentAlias(name, targetEnvironmentId);
      await reload();
      toast.success(`“${name}” → ${targetEnvironmentId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <h2 className="font-heading font-medium text-base">Environments</h2>
        </CardHeader>
        <CardContent>
          {environments.length === 0 ? (
            <p className="text-muted-foreground text-sm">No environments.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {environments.map((e) => (
                <Badge key={e.id} variant="outline">
                  {e.id}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-heading font-medium text-base">Aliases</h2>
          <p className="text-muted-foreground text-sm">
            A repointable pointer to an environment. Use it as the environment in any API call;
            repoint it for an atomic blue/green cutover.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={save} className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="alias-name">Alias</Label>
              <Input
                id="alias-name"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder="production"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Target environment</Label>
              <Select value={target} onValueChange={setPickedTarget}>
                <SelectTrigger aria-label="Target environment" className="w-[200px]">
                  <SelectValue placeholder="Environment" />
                </SelectTrigger>
                <SelectContent>
                  {environments.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={!alias.trim() || !target || busy}>
              Save alias
            </Button>
          </form>

          {aliases.length === 0 ? (
            <p className="text-muted-foreground text-sm">No aliases yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Alias</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead className="w-40">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {aliases.map((a) => (
                  <TableRow key={a.alias}>
                    <TableCell className="font-medium">{a.alias}</TableCell>
                    <TableCell>
                      <Select
                        value={a.targetEnvironmentId}
                        onValueChange={(v) => repoint(a.alias, v)}
                      >
                        <SelectTrigger
                          aria-label={`Target environment for ${a.alias}`}
                          className="h-8 w-[180px]"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {environments.map((e) => (
                            <SelectItem key={e.id} value={e.id}>
                              {e.id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <ConfirmButton
                        message={`Delete the alias “${a.alias}”?`}
                        note="Clients addressing it stop resolving. This can’t be undone."
                        confirmLabel="Delete alias"
                        onConfirm={() => void remove(a.alias)}
                      >
                        {(ask) => (
                          <Button type="button" variant="ghost" size="sm" onClick={ask}>
                            Delete
                          </Button>
                        )}
                      </ConfirmButton>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <BranchMerge client={client} environments={environments} />
    </div>
  );
}

/** Append-only audit trail of mutating API actions (governance; space:admin). */
function AuditLog(props: { client: ManagementClient }) {
  const { client } = props;
  const invalidate = useInvalidate();

  // The audit log grows on every mutation, so always revalidate on mount.
  const auditQuery = useScopedQuery(['audit-log'], () => client.listAuditLog({ limit: 200 }), {
    staleTime: 0,
  });
  const entries = auditQuery.data ?? [];
  const loading = auditQuery.isPending;
  // isFetching (not isPending) so the Refresh button also disables during
  // button-triggered refetches, not just the first load.
  const refreshing = auditQuery.isFetching;
  const load = () => void invalidate(['audit-log']);

  return (
    // Clipped, not hidden: a long log keeps its header under the shell's as it scrolls.
    <Card className="overflow-clip">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <div>
          <h2 className="font-heading font-medium text-base">Audit log</h2>
          <p className="text-muted-foreground text-sm">
            Every mutating API action in this space, newest first.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={load} disabled={refreshing}>
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {!loading && entries.length === 0 ? (
          <p className="text-muted-foreground text-sm">No audit entries yet.</p>
        ) : (
          <Table
            edge="flush"
            stack="cards"
            sticky
            caption="Audit log"
            aria-busy={loading || undefined}
          >
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead numeric className="w-16">
                  Status
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground text-xs">
                    <Ago at={e.at} />
                  </TableCell>
                  <TableCell label="Actor">
                    <Badge variant="outline">{e.actor}</Badge>
                  </TableCell>
                  <TableCell label="Action" className="font-mono text-xs">
                    {e.action}
                  </TableCell>
                  <TableCell label="Target" className="font-mono text-muted-foreground text-xs">
                    {e.targetId ?? '—'}
                  </TableCell>
                  <TableCell label="Status" numeric>
                    {e.status}
                  </TableCell>
                </TableRow>
              ))}
              {loading
                ? ['48%', '62%', '40%', '55%', '44%'].map((w) => (
                    <TableRow key={w} aria-hidden="true">
                      <TableCell className="text-xs">
                        <SkeletonText width="4.5rem" />
                      </TableCell>
                      <TableCell label="Actor">
                        <SkeletonPill className="w-20" />
                      </TableCell>
                      <TableCell label="Action" className="text-xs">
                        <SkeletonText width="7.5rem" />
                      </TableCell>
                      <TableCell label="Target" className="text-xs">
                        <SkeletonText width={w} />
                      </TableCell>
                      <TableCell label="Status" numeric className="text-sm">
                        <SkeletonText width="1.75rem" className="items-end" />
                      </TableCell>
                    </TableRow>
                  ))
                : null}
            </TableBody>
          </Table>
        )}
        {loading ? <LoadingStatus>Loading the audit log…</LoadingStatus> : null}
      </CardContent>
    </Card>
  );
}

const ROLE_NONE = '__none__';

function RolesSettings(props: { client: ManagementClient }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [accessFor, setAccessFor] = useState<RoleSummary | null>(null);

  const roles = useScopedQuery(['roles'], () => props.client.listRoles()).data ?? [];
  const contentTypes = useContentTypesQuery().data ?? [];

  // The role is replaced whole (PUT), so its name, description and scopes go back as they were.
  const typeNames = new Map(contentTypes.map((t) => [t.apiId, t.name]));

  // Grants only: the rest of the role is re-read at save, and a concurrent grant change refuses.
  const saveAccess = async (role: RoleSummary, contentGrants: RoleSummary['contentGrants']) => {
    await saveRoleGrants(props.client, role, contentGrants);
    await invalidate(['roles']);
    setAccessFor(null);
    toast.success(`Saved content access for ${role.name}`);
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await props.client.createRole({
        name: name.trim(),
        scopes: ['preview:read', 'content:write'],
        contentGrants: [{ contentTypeApiId: '*', actions: ['read', 'write'] }],
      });
      setName('');
      await invalidate(['roles']);
      toast.success('Role created');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const clone = async (id: string, roleName: string) => {
    try {
      await props.client.cloneRole(id, `${roleName} (copy)`);
      await invalidate(['roles']);
      toast.success(`Cloned ${roleName}`);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  const remove = async (id: string) => {
    try {
      await props.client.deleteRole(id);
      await invalidate(['roles']);
      toast.success('Role deleted');
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <h2 className="font-heading text-base font-medium">Roles</h2>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="flex flex-wrap items-center gap-2" onSubmit={create}>
          <Input
            className="w-64"
            placeholder="Role name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" disabled={busy}>
            Create role
          </Button>
        </form>
        <Table stack="cards" caption="Roles, their scopes and content access">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead>Content</TableHead>
              <TableHead className="w-24">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.map((role) => (
              <TableRow key={role.id}>
                <TableCell>
                  <span className="flex flex-wrap items-center gap-2">
                    {role.name}
                    {role.preset ? <Badge variant="outline">Built-in</Badge> : null}
                  </span>
                </TableCell>
                <TableCell label="Scopes" className="text-muted-foreground text-sm">
                  {role.scopes.join(', ')}
                </TableCell>
                <TableCell label="Content" className="text-muted-foreground text-sm">
                  {describeGrants(role.contentGrants, typeNames)}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Content access for ${role.name}`}
                      onClick={() => setAccessFor(role)}
                    >
                      Access
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void clone(role.id, role.name)}
                    >
                      Clone
                    </Button>
                    {role.preset ? null : (
                      <ConfirmDialog
                        message={`Delete the role “${role.name}”?`}
                        note="This can’t be undone."
                        confirmLabel="Delete role"
                        onConfirm={() => void remove(role.id)}
                      >
                        {(ask) => (
                          <Button type="button" variant="ghost" size="sm" onClick={ask}>
                            Delete
                          </Button>
                        )}
                      </ConfirmDialog>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {accessFor ? (
          <RoleAccessSheet
            key={accessFor.id}
            role={accessFor}
            contentTypes={contentTypes}
            open
            onOpenChange={(o) => !o && setAccessFor(null)}
            onSave={(grants) => saveAccess(accessFor, grants)}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function ApiKeys(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const invalidate = useInvalidate();
  const [kind, setKind] = useState<ApiKeyKind>('cda');
  const [roleId, setRoleId] = useState<string>(ROLE_NONE);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // The raw token is shown exactly once, right after minting.
  const [minted, setMinted] = useState<CreatedApiKey>();

  const keys = useScopedQuery(['api-keys'], () => client.listApiKeys()).data ?? [];
  const roles = useScopedQuery(['roles'], () => client.listRoles()).data ?? [];

  const roleName = useMemo(() => {
    const byId = new Map(roles.map((r) => [r.id, r.name]));
    return (id?: string) => (id ? (byId.get(id) ?? id) : undefined);
  }, [roles]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const created = await client.createApiKey({
        kind,
        name: name.trim() || undefined,
        roleId: roleId === ROLE_NONE ? undefined : roleId,
      });
      setMinted(created);
      setName('');
      setRoleId(ROLE_NONE);
      await invalidate(['api-keys']);
      toast.success(`${created.kind.toUpperCase()} key created`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await client.revokeApiKey(id);
      await invalidate(['api-keys']);
      toast.success('Key revoked');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        {/* Explicit heading element — the e2e asserts getByRole('heading', { name: 'API keys' }). */}
        <h2 className="font-heading text-base font-medium">API keys</h2>
      </CardHeader>
      <CardContent className="space-y-4">
        {minted && (
          <Alert>
            <KeyRound />
            <AlertTitle>
              New {keyKindLabel(minted.kind).toLowerCase()} token: copy it now, it won’t be shown
              again.
            </AlertTitle>
            <AlertDescription>
              <code className="break-all text-sm text-foreground">{minted.token}</code>
            </AlertDescription>
            <AlertAction>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => navigator.clipboard?.writeText(minted.token)}
              >
                Copy
              </Button>
            </AlertAction>
          </Alert>
        )}

        <form className="flex flex-wrap items-center gap-2" onSubmit={create}>
          <Select value={kind} onValueChange={(v) => setKind(v as ApiKeyKind)}>
            <SelectTrigger aria-label="API key kind" className="w-[320px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KEY_KINDS.map((k) => (
                <SelectItem key={k.value} value={k.value}>
                  {k.label}
                  <span className="text-muted-foreground">: {k.reads}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={roleId} onValueChange={setRoleId}>
            <SelectTrigger aria-label="Role" className="w-[220px]">
              <SelectValue placeholder="Role (optional)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ROLE_NONE}>No custom role</SelectItem>
              {roles.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            className="w-48"
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create key'}
          </Button>
        </form>

        <Table edge="flush" stack="cards" caption="API keys">
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">Kind</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-24">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((k) => (
              <TableRow key={k.id}>
                <TableCell>
                  <Badge variant="outline" title={keyKindApi(k.kind)}>
                    {keyKindLabel(k.kind)}
                  </Badge>
                </TableCell>
                <TableCell label="Name" className="font-mono text-xs">
                  {k.name ?? <span className="text-muted-foreground">—</span>}
                </TableCell>
                <TableCell label="Role" className="text-muted-foreground">
                  {k.roleId ? roleName(k.roleId) : '—'}
                </TableCell>
                <TableCell label="Scopes" className="text-muted-foreground">
                  <div className="max-w-[360px] truncate" title={k.scopes.join(', ')}>
                    {k.scopes.join(', ')}
                  </div>
                </TableCell>
                <TableCell label="Status">
                  <StatusBadge status={k.revoked ? 'revoked' : 'active'} />
                </TableCell>
                <TableCell className="text-right">
                  {!k.revoked && (
                    <RevokeKeyButton
                      name={k.name ?? `${keyKindLabel(k.kind)} key`}
                      onConfirm={() => revoke(k.id)}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
            {keys.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  No API keys yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** Destructive "Revoke" action behind a confirm dialog — revoking is permanent. */
function RevokeKeyButton(props: { name: string; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="text-destructive">
          Revoke
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke “{props.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This immediately and permanently disables the key. Any client using its token will stop
            working. This can’t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={props.onConfirm}>
            Revoke key
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function Webhooks(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const invalidate = useInvalidate();
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [topics, setTopics] = useState<WebhookTopic[]>(['*']);
  const [everywhere, setEverywhere] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<WebhookSummary | null>(null);
  // The hook whose log is open, and the test just queued for it, which the log waits to see.
  const [deliveriesFor, setDeliveriesFor] = useState<{
    webhook: WebhookSummary;
    awaitEventId?: string;
  } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const hooks = useScopedQuery(['webhooks'], () => client.listWebhooks()).data ?? [];
  const reload = () => invalidate(['webhooks']);

  const toggleActive = async (h: WebhookSummary) => {
    try {
      await client.updateWebhook(h.id, { active: !h.active });
      await reload();
      toast.success(h.active ? 'Webhook paused' : 'Webhook resumed');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  // Queued, not sent: the engine sends it like any delivery. The log opens and waits for it.
  const sendTest = async (h: WebhookSummary) => {
    setTesting(h.id);
    try {
      const queued = await client.sendWebhookTest(h.id);
      toast.success('Test event queued.');
      setDeliveriesFor({ webhook: h, awaitEventId: queued.eventId });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(null);
    }
  };

  const remove = async (id: string) => {
    try {
      await client.deleteWebhook(id);
      await reload();
      toast.success('Webhook deleted');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const saveEdit = async (changes: {
    url: string;
    topics: WebhookTopic[];
    active: boolean;
    secret?: string;
    allEnvironments?: boolean;
  }) => {
    if (!editing) return;
    await client.updateWebhook(editing.id, changes);
    await reload();
    toast.success('Webhook updated');
  };

  const toggleTopic = (t: WebhookTopic) =>
    setTopics((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || !secret.trim() || topics.length === 0) return;
    setBusy(true);
    try {
      // Off, the hook hears only the environment being viewed (allEnvironments is left out rather
      // than sent false: viewed through an alias, the API makes it space-wide instead).
      await client.createWebhook({
        url: url.trim(),
        secret: secret.trim(),
        topics,
        ...(everywhere ? { allEnvironments: true } : {}),
      });
      setUrl('');
      setSecret('');
      setTopics(['*']);
      setEverywhere(false);
      await reload();
      toast.success('Webhook added');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <h2 className="font-heading text-base font-medium">Webhooks</h2>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={create} className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="flex-2 min-w-56"
              placeholder="https://example.com/hooks/cms"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Input
              className="flex-1 min-w-40"
              placeholder="Signing secret"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
            <Button type="submit" disabled={busy}>
              {busy ? 'Adding…' : 'Add webhook'}
            </Button>
          </div>
          <div className="flex flex-wrap gap-4">
            {WEBHOOK_TOPICS.map((t) => (
              <Label key={t} className="flex items-center gap-2 font-normal">
                {/* Radix renders <button role="checkbox">. An *implicit*
                    (wrapping) label does not name it — verified in Chrome's
                    accessibility tree — so the name is set explicitly. An
                    explicit htmlFor/id pair would work too; aria-label is what
                    the rest of the admin uses. */}
                <Checkbox
                  aria-label={t}
                  checked={topics.includes(t)}
                  onCheckedChange={() => toggleTopic(t)}
                />
                <span>{t}</span>
              </Label>
            ))}
          </div>
          <Label className="flex items-center gap-2 font-normal">
            <Checkbox
              aria-label="Send events from every environment"
              checked={everywhere}
              onCheckedChange={(c) => setEverywhere(c === true)}
            />
            <span>Send events from every environment</span>
          </Label>
        </form>

        <Table edge="flush" stack="cards" caption="Webhooks">
          <TableHeader>
            <TableRow>
              <TableHead>Endpoint</TableHead>
              <TableHead>Topics</TableHead>
              <TableHead>Environments</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-80">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {hooks.map((h) => (
              <TableRow key={h.id}>
                <TableCell className="break-all font-mono text-xs">{h.url}</TableCell>
                <TableCell label="Topics" className="text-muted-foreground">
                  {h.topics.join(', ')}
                </TableCell>
                <TableCell label="Environments">
                  {h.environmentId === null ? (
                    <Badge variant="outline">All environments</Badge>
                  ) : (
                    <Badge variant="outline" className="font-mono">
                      {h.environmentId}
                    </Badge>
                  )}
                </TableCell>
                <TableCell label="Status">
                  <StatusBadge status={h.active ? 'active' : 'paused'} />
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeliveriesFor({ webhook: h })}
                    >
                      Deliveries
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={testing === h.id}
                      aria-label={`${testing === h.id ? 'Sending test' : 'Send test'} to ${h.url}`}
                      onClick={() => sendTest(h)}
                    >
                      {testing === h.id ? 'Sending test…' : 'Send test'}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => toggleActive(h)}>
                      {h.active ? 'Pause' : 'Resume'}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(h)}>
                      Edit
                    </Button>
                    <DeleteWebhookButton url={h.url} onConfirm={() => remove(h.id)} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {hooks.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  No webhooks yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
      {editing && (
        <WebhookDialog
          key={editing.id}
          open
          onOpenChange={(o) => !o && setEditing(null)}
          webhook={editing}
          onSave={saveEdit}
        />
      )}
      {deliveriesFor && (
        <WebhookDeliveriesSheet
          key={`${deliveriesFor.webhook.id}:${deliveriesFor.awaitEventId ?? ''}`}
          open
          onOpenChange={(o) => !o && setDeliveriesFor(null)}
          webhook={deliveriesFor.webhook}
          {...(deliveriesFor.awaitEventId ? { awaitEventId: deliveriesFor.awaitEventId } : {})}
        />
      )}
    </Card>
  );
}

/** Destructive "Delete" action behind a confirm dialog. */
function DeleteWebhookButton(props: { url: string; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="text-destructive">
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete webhook?</AlertDialogTitle>
          <AlertDialogDescription>
            Stop delivering events to <span className="break-all font-mono">{props.url}</span> and
            remove this subscription. This can’t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={props.onConfirm}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
