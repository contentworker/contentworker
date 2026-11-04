/**
 * Settings → Access → Space access: who can work in THIS space and with what role. People here
 * are the deployment's own accounts (People and sign-in, /team), matched by email; adding someone
 * here gives them this space, not a deployment account. Long-lived API keys are listed with their
 * role too. Changing a role
 * asks in place (InlineConfirm), and removing someone in a modal; the space's last administrator can't be demoted, disabled,
 * removed or revoked, and the page says so where the action would be rather than failing after.
 */

import { Badge } from '@contentworker/ui/badge';
import { Button } from '@contentworker/ui/button';
import { Input } from '@contentworker/ui/input';
import { Label } from '@contentworker/ui/label';
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from '@contentworker/ui/native-select';
import { Switch } from '@contentworker/ui/switch';
import {
  Table,
  TableBody,
  Td as TableCell,
  Th as TableHead,
  TableHead as TableHeader,
  Tr as TableRow,
} from '@contentworker/ui/table';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Ago } from '~/cms/components/ago';
import { ConfirmDialog } from '~/cms/components/ConfirmDialog';
import { ConfirmButton, InlineConfirm } from '~/cms/components/InlineConfirm';
import { Empty, Section } from '~/cms/components/page';
import { StatusBadge } from '~/cms/components/status';
import { keyKindApi, keyKindLabel } from '../lib/key-kinds';
import {
  apiErrorMessage,
  type ManagementClient,
  type RolePresetSummary,
  type RoleSummary,
  type TeamKey,
  type TeamPerson,
  type TeamRole,
  type TeamSummary,
} from '../lib/management';
import { useInvalidate, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

/** The message shown wherever an action would take away the last administrator. */
export const LAST_ADMIN_MESSAGE =
  'The last administrator can’t be demoted, disabled, removed or revoked. Make someone else an administrator first.';

const ISSUANCE: Record<TeamKey['issuance'], string> = {
  key: 'API key',
  pat: 'Personal token',
  oauth: 'Connected app',
  setup: 'Setup administrator',
};

interface RoleOption {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly admin: boolean;
}

/** Presets first, in order, then the space's custom roles. */
function roleOptions(presets: readonly RolePresetSummary[], roles: readonly RoleSummary[]) {
  const preset: RoleOption[] = presets.map((p) => ({
    id: p.roleId,
    name: p.name,
    description: p.description,
    admin: p.scopes.includes('space:admin'),
  }));
  const custom: RoleOption[] = roles
    .filter((r) => !r.preset)
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      admin: r.scopes.includes('space:admin'),
    }));
  return { preset, custom, all: [...preset, ...custom] };
}

export function Team(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const invalidate = useInvalidate();
  const team = useScopedQuery(['team'], () => client.getTeam());
  const presets = useScopedQuery(['role-presets'], () => client.listRolePresets()).data ?? [];
  const roles = useScopedQuery(['roles'], () => client.listRoles()).data ?? [];
  const options = useMemo(() => roleOptions(presets, roles), [presets, roles]);
  const data = team.data;

  const refresh = () => invalidate(['team']);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      await refresh();
      toast.success(done);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  return (
    <div className="space-y-6">
      <People client={client} team={data} options={options} act={act} />
      <Keys team={data} options={options} act={act} client={client} />
      {data?.sso ? <SignIn client={client} team={data} act={act} /> : null}
    </div>
  );
}

type Act = (fn: () => Promise<unknown>, done: string) => Promise<void>;
type Options = ReturnType<typeof roleOptions>;

/** The last admin: one administrator left, and this is it. */
const isLastAdmin = (team: TeamSummary | undefined, admin: boolean) =>
  !!team && admin && team.adminCount <= 1;

function People(props: {
  client: ManagementClient;
  team: TeamSummary | undefined;
  options: Options;
  act: Act;
}) {
  const { client, team, options, act } = props;
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('viewer');
  const people = team?.people ?? [];

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    await act(
      () =>
        client.addMember({
          email: email.trim(),
          ...(name.trim() ? { name: name.trim() } : {}),
          role,
        }),
      `${email.trim()} added`,
    );
    setEmail('');
    setName('');
  };

  return (
    <Section
      title="People in this space"
      description={
        <>
          Who can work in this space, and their role here. People sign in with their deployment
          account (managed under{' '}
          <Link to="/team" className="text-link underline">
            People and sign-in
          </Link>
          ); their email links them to this space.
        </>
      }
      flush
    >
      <form className="flex flex-wrap items-end gap-2 px-5 py-4" onSubmit={add}>
        <div className="space-y-1.5">
          <Label htmlFor="team-email">Email</Label>
          <Input
            id="team-email"
            type="email"
            className="w-64"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="team-name">
            Name <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="team-name"
            className="w-48"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="team-role">Role</Label>
          <NativeSelect id="team-role" value={role} onChange={(e) => setRole(e.target.value)}>
            {['viewer', 'approver', 'editor', 'manager', 'admin'].map((p, i) => (
              <NativeSelectOption key={p} value={p}>
                {options.preset[i]?.name ?? p}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit">Add person</Button>
      </form>
      {/* No one at all is the news, so it is `Empty` in place of the table. */}
      {team && people.length === 0 ? (
        <Empty>No one on the team yet. Add someone by email above.</Empty>
      ) : (
        <Table stack="cards" caption="People">
          <TableHeader>
            <TableRow>
              <TableHead>Person</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="w-28">Status</TableHead>
              <TableHead className="w-40">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {people.map((p) => (
              <PersonRow
                key={p.id}
                person={p}
                team={team}
                options={options}
                act={act}
                client={client}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

function PersonRow(props: {
  person: TeamPerson;
  team: TeamSummary | undefined;
  options: Options;
  act: Act;
  client: ManagementClient;
}) {
  const { person: p, team, options, act, client } = props;
  // People are administrators only where they can sign in (SSO).
  const last = isLastAdmin(team, p.admin && !!team?.sso && !p.disabled);
  const who = p.name ? `${p.name} (${p.email})` : p.email;
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{p.name ?? p.email}</div>
        {p.name ? <div className="text-muted-foreground text-xs">{p.email}</div> : null}
        {!p.linked ? (
          <div className="text-muted-foreground text-xs">Hasn’t signed in yet</div>
        ) : null}
      </TableCell>
      <TableCell label="Role">
        <RoleChange
          subject={who}
          current={p.role}
          options={options}
          lastAdmin={last}
          onChange={(roleId, roleName) =>
            act(
              () => client.updateMember(p.id, { role: roleId ?? undefined }),
              `${who} is now ${roleName}`,
            )
          }
        />
      </TableCell>
      <TableCell label={p.disabled ? 'Status' : undefined}>
        {/* Only the exception is stamped: a row of "Active" on everyone says nothing. */}
        {p.disabled ? <StatusBadge status="disabled" /> : <span className="sr-only">Active</span>}
      </TableCell>
      <TableCell className="text-right">
        {last ? (
          <span className="text-muted-foreground text-xs">Last administrator</span>
        ) : (
          <div className="flex flex-wrap justify-end gap-1">
            <ConfirmButton
              message={p.disabled ? `Let ${who} sign in again?` : `Turn off ${who}’s access?`}
              note={
                p.disabled ? undefined : 'Their SSO sign-in is refused until you turn it back on.'
              }
              confirmLabel={p.disabled ? 'Turn on' : 'Turn off'}
              tone={p.disabled ? 'default' : 'destructive'}
              onConfirm={() =>
                void act(
                  () => client.updateMember(p.id, { disabled: !p.disabled }),
                  p.disabled ? `${who} can sign in` : `${who}’s access is off`,
                )
              }
            >
              {(ask) => (
                <Button type="button" variant="ghost" size="sm" onClick={ask}>
                  {p.disabled ? 'Turn on' : 'Turn off'}
                </Button>
              )}
            </ConfirmButton>
            <ConfirmDialog
              message={`Remove ${who} from the team?`}
              note="They lose their role here; adding them again starts over."
              confirmLabel="Remove"
              onConfirm={() => void act(() => client.removeMember(p.id), `${who} removed`)}
            >
              {(ask) => (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={ask}
                >
                  Remove
                </Button>
              )}
            </ConfirmDialog>
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

function Keys(props: {
  client: ManagementClient;
  team: TeamSummary | undefined;
  options: Options;
  act: Act;
}) {
  const { client, team, options, act } = props;
  const keys = team?.keys ?? [];
  return (
    <Section
      title="API keys"
      description="Long-lived keys and the role each acts with. Mint and revoke them under API keys."
      flush
    >
      {team && keys.length === 0 ? (
        <Empty>No API keys.</Empty>
      ) : (
        <Table stack="cards" caption="API keys and their roles">
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="w-32">Last used</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((k) => {
              const label = k.name ?? `${keyKindLabel(k.kind)} key`;
              return (
                <TableRow key={k.id}>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{label}</span>
                      <Badge variant="outline" title={keyKindApi(k.kind)}>
                        {keyKindLabel(k.kind)}
                      </Badge>
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {ISSUANCE[k.issuance]}
                      {k.subject ? ` · ${k.subject}` : ''}
                    </div>
                  </TableCell>
                  <TableCell label="Role">
                    <RoleChange
                      subject={label}
                      current={k.role}
                      options={options}
                      lastAdmin={isLastAdmin(team, k.admin)}
                      allowNone
                      onChange={(roleId, roleName) =>
                        act(() => client.setApiKeyRole(k.id, roleId), `${label} is now ${roleName}`)
                      }
                    />
                  </TableCell>
                  <TableCell label="Last used" className="text-muted-foreground">
                    {k.lastUsedAt ? <Ago at={k.lastUsedAt} /> : 'Never'}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

const NONE = '__none__';

/**
 * The role, as a select; picking another asks in place before changing it. On the last
 * administrator, picking a role that isn't an administrator's says why it can't instead.
 */
function RoleChange(props: {
  subject: string;
  current: TeamRole | null;
  options: Options;
  lastAdmin: boolean;
  allowNone?: boolean;
  onChange: (roleId: string | null, roleName: string) => Promise<void>;
}) {
  const { subject, current, options, lastAdmin, allowNone, onChange } = props;
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = current?.id ?? NONE;
  const target = pending === NONE ? null : options.all.find((o) => o.id === pending);
  const targetName = pending === NONE ? 'No role (key defaults)' : (target?.name ?? '');
  const blocked = lastAdmin && pending !== null && !target?.admin;

  return (
    <div className="min-w-0 space-y-2">
      <NativeSelect
        aria-label={`Role for ${subject}`}
        value={pending ?? value}
        onChange={(e) => setPending(e.target.value === value ? null : e.target.value)}
        disabled={busy}
      >
        {allowNone ? (
          <NativeSelectOption value={NONE}>No role (key defaults)</NativeSelectOption>
        ) : null}
        {!current && !allowNone ? (
          <NativeSelectOption value={NONE}>No role</NativeSelectOption>
        ) : null}
        <NativeSelectOptGroup label="Presets">
          {options.preset.map((o) => (
            <NativeSelectOption key={o.id} value={o.id}>
              {o.name}
            </NativeSelectOption>
          ))}
        </NativeSelectOptGroup>
        {options.custom.length ? (
          <NativeSelectOptGroup label="Custom roles">
            {options.custom.map((o) => (
              <NativeSelectOption key={o.id} value={o.id}>
                {o.name}
              </NativeSelectOption>
            ))}
          </NativeSelectOptGroup>
        ) : null}
      </NativeSelect>
      {pending !== null ? (
        blocked ? (
          <InlineConfirm
            message={`${subject} is the last administrator.`}
            note={LAST_ADMIN_MESSAGE}
            cancelLabel="OK"
            onCancel={() => setPending(null)}
          >
            {null}
          </InlineConfirm>
        ) : (
          <InlineConfirm
            message={`Change ${subject} to ${targetName}?`}
            note={target?.description ?? 'They act with their kind’s default scopes.'}
            onCancel={() => setPending(null)}
          >
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onChange(pending === NONE ? null : pending, targetName);
                } finally {
                  setBusy(false);
                  setPending(null);
                }
              }}
            >
              Change role
            </Button>
          </InlineConfirm>
        )
      ) : null}
    </div>
  );
}

function SignIn(props: { client: ManagementClient; team: TeamSummary; act: Act }) {
  const { client, team, act } = props;
  const on = team.settings.ssoOnly;
  return (
    <Section
      title="Sign-in"
      description="With single sign-on required, the administrator token setup created stops working. A setup recovery code turns this off again."
    >
      <div className="flex items-center gap-3">
        <Switch
          id="team-sso-only"
          checked={on}
          onCheckedChange={(next) =>
            void act(
              () => client.setAccessSettings({ ssoOnly: next }),
              next ? 'Single sign-on is required' : 'Single sign-on is no longer required',
            )
          }
        />
        <Label htmlFor="team-sso-only">Require single sign-on for people</Label>
      </div>
    </Section>
  );
}
