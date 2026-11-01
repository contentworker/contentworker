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
import { Button } from '@contentworker/ui/button';
import { Card, CardContent, CardHeader } from '@contentworker/ui/card';
import { Checkbox } from '@contentworker/ui/checkbox';
import { Input } from '@contentworker/ui/input';
import { Label } from '@contentworker/ui/label';
import {
  Table,
  TableBody,
  Td as TableCell,
  Th as TableHead,
  TableHead as TableHeader,
  Tr as TableRow,
} from '@contentworker/ui/table';
import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { Ago } from '~/cms/components/ago';
import { StatusBadge } from '~/cms/components/status';
import { When } from '~/cms/components/when';
import {
  type ConnectedApp,
  type CreatedPat,
  type ManagementClient,
  PERMISSION_SCOPES,
  type PersonalAccessToken,
} from '../lib/management';
import { useInvalidate, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

/** Plain-language scope names; falls back to the raw scope for anything new. */
const SCOPE_LABEL = new Map<string, string>(
  PERMISSION_SCOPES.map((s) => [s.value, s.label] as const),
);
const scopeText = (scopes: readonly string[]) =>
  scopes.map((s) => SCOPE_LABEL.get(s) ?? s).join(', ');

/**
 * Who and what can reach this space through OAuth, plus the personal access
 * tokens issued in it. Two sibling cards rather than one nested surface —
 * connections are granted by a human clicking approve in another application,
 * tokens are minted here, and they are revoked differently.
 */
export function ConnectedApps(props: { client: ManagementClient }) {
  return (
    <div className="space-y-4">
      <Connections client={props.client} />
      <PersonalAccessTokens client={props.client} />
    </div>
  );
}

function Connections(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const invalidate = useInvalidate();

  const apps = useScopedQuery(['oauth-connections'], () => client.listConnectedApps()).data ?? [];

  const disconnect = async (app: ConnectedApp) => {
    try {
      const { revokedTokens } = await client.revokeConnectedApp(app.clientId, app.subject);
      await invalidate(['oauth-connections']);
      toast.success(
        `${app.clientName} disconnected (${revokedTokens} ${
          revokedTokens === 1 ? 'token' : 'tokens'
        } revoked)`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <h2 className="font-heading text-base font-medium">Connected applications</h2>
        <p className="text-sm text-muted-foreground">
          Applications a person approved through OAuth — MCP clients, assistants, editors.
          Disconnecting revokes their tokens and the grants behind them, so they can&rsquo;t refresh
          back in.
        </p>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Application</TableHead>
              <TableHead>Authorized by</TableHead>
              <TableHead>Access</TableHead>
              <TableHead className="w-40">Last used</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {apps.map((app) => (
              <TableRow key={`${app.clientId}:${app.subject}`}>
                <TableCell>
                  <div className="font-medium">{app.clientName}</div>
                  {app.tokenCount > 1 && (
                    <div className="text-xs text-muted-foreground">
                      {app.tokenCount} active tokens
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{app.subject}</TableCell>
                <TableCell className="text-muted-foreground">
                  <div className="max-w-[320px] truncate" title={app.scopes.join(', ')}>
                    {scopeText(app.scopes)}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  <Ago at={app.lastUsedAt} />
                </TableCell>
                <TableCell className="text-right">
                  <DisconnectButton name={app.clientName} onConfirm={() => disconnect(app)} />
                </TableCell>
              </TableRow>
            ))}
            {apps.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  No applications are connected.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function DisconnectButton(props: { name: string; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="text-destructive">
          Disconnect
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect “{props.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            It loses access immediately and can&rsquo;t refresh back in. Anyone using it will need
            to authorize again. This can&rsquo;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={props.onConfirm}>Disconnect</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const DEFAULT_PAT_SCOPES = ['delivery:read', 'search:read'];

function PersonalAccessTokens(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const invalidate = useInvalidate();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(DEFAULT_PAT_SCOPES);
  const [expiresInDays, setExpiresInDays] = useState('');
  const [busy, setBusy] = useState(false);
  // The raw token is shown exactly once, right after minting.
  const [minted, setMinted] = useState<CreatedPat>();

  const tokens =
    useScopedQuery(['personal-access-tokens'], () => client.listPersonalAccessTokens()).data ?? [];

  const toggle = (scope: string) =>
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || scopes.length === 0) return;
    setBusy(true);
    try {
      const days = Number(expiresInDays);
      const created = await client.createPersonalAccessToken({
        name: name.trim(),
        scopes,
        expiresInDays: Number.isFinite(days) && days > 0 ? days : undefined,
      });
      setMinted(created);
      setName('');
      setExpiresInDays('');
      setScopes(DEFAULT_PAT_SCOPES);
      await invalidate(['personal-access-tokens']);
      toast.success('Personal access token created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await client.revokePersonalAccessToken(id);
      await invalidate(['personal-access-tokens']);
      toast.success('Token revoked');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <h2 className="font-heading text-base font-medium">Personal access tokens</h2>
        <p className="text-sm text-muted-foreground">
          For CLI and CI clients that can&rsquo;t run a browser sign-in. A token can only carry
          permissions you hold yourself.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {minted && (
          <Alert>
            <KeyRound />
            <AlertTitle>New token — copy it now, it won&rsquo;t be shown again.</AlertTitle>
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

        <form className="space-y-3" onSubmit={create}>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-56"
              placeholder="What is it for? e.g. release CI"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              className="w-44"
              type="number"
              min={1}
              max={365}
              placeholder="Expires in days"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
            />
            <Button type="submit" disabled={busy || !name.trim() || scopes.length === 0}>
              {busy ? 'Creating…' : 'Create token'}
            </Button>
          </div>
          <div className="flex flex-wrap gap-4">
            {PERMISSION_SCOPES.map((s) => (
              <Label key={s.value} className="flex items-center gap-2 font-normal">
                {/* Radix renders a <button role="checkbox">, which an *implicit*
                    (wrapping) label does not name — verified in Chrome's
                    accessibility tree. An explicit htmlFor/id pair does work;
                    aria-label is what the rest of the admin uses. Without it a
                    screen reader announces an unnamed checkbox, which on a
                    permission grant is unusable. */}
                <Checkbox
                  aria-label={s.label}
                  checked={scopes.includes(s.value)}
                  onCheckedChange={() => toggle(s.value)}
                />
                <span>{s.label}</span>
              </Label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Leave the expiry blank for a token that never expires. Scopes you don&rsquo;t hold are
            dropped.
          </p>
        </form>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Access</TableHead>
              <TableHead className="w-40">Expires</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.map((t) => (
              <TableRow key={t.id}>
                <TableCell>{t.name ?? <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell className="text-muted-foreground">{t.subject ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground">
                  <div className="max-w-[280px] truncate" title={t.scopes.join(', ')}>
                    {scopeText(t.scopes)}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {t.expiresAt ? <When at={t.expiresAt} /> : 'Never'}
                </TableCell>
                <TableCell>
                  <StatusBadge status={tokenStatus(t)} />
                </TableCell>
                <TableCell className="text-right">
                  {!t.revoked && (
                    <RevokeTokenButton
                      name={t.name ?? 'this token'}
                      onConfirm={() => revoke(t.id)}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
            {tokens.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-muted-foreground">
                  No personal access tokens yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/**
 * A token that lapsed on its own reads differently from one somebody revoked,
 * so the two are never collapsed into a single "inactive".
 */
function tokenStatus(token: PersonalAccessToken): string {
  if (token.revoked) return 'revoked';
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'active';
}

function RevokeTokenButton(props: { name: string; onConfirm: () => void }) {
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
            Anything using this token stops working immediately. This can&rsquo;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={props.onConfirm}>Revoke token</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
