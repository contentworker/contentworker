import { Button } from '@contentworker/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentworker/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@contentworker/ui/dropdown-menu';
import { Input } from '@contentworker/ui/input';
import { Label } from '@contentworker/ui/label';
import { cn } from '@contentworker/ui/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Layers, Plus, Settings } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useClient } from '../../lib/client-context';
import type { SpaceRef } from '../../lib/management';

/**
 * Space switcher: lists the spaces this person can reach (a deployment admin → all, a
 * member → their own), switches on select, and provisions new ones (admin only).
 * Switching resets the environment to "main" since branches are per-space.
 */
export function SpaceMenu() {
  const { conn, updateConn, spaces: reachable } = useClient();
  const spaces: readonly SpaceRef[] = reachable?.length
    ? reachable
    : [{ id: conn.space, name: conn.space }];
  const [createOpen, setCreateOpen] = useState(false);

  const switchSpace = (id: string) => {
    if (id !== conn.space) updateConn({ space: id, environment: 'main' });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5" title="Switch space">
            <Layers className="size-4 text-muted-foreground" />
            <span className="font-medium">{conn.space || 'no space'}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Spaces</DropdownMenuLabel>
          {spaces.map((s) => (
            <DropdownMenuItem
              key={s.id}
              onClick={() => switchSpace(s.id)}
              className="justify-between"
            >
              <span className="flex flex-col">
                <span>{s.name}</span>
                {s.name !== s.id && <span className="text-xs text-muted-foreground">{s.id}</span>}
              </span>
              <Check className={cn('size-4', s.id === conn.space ? 'opacity-100' : 'opacity-0')} />
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> New space…
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/settings/team">
              <Settings className="size-4" /> Space access
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateSpaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => updateConn({ space: id, environment: 'main' })}
      />
    </>
  );
}

function CreateSpaceDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const { client } = useClient();
  const queryClient = useQueryClient();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [defaultLocale, setDefaultLocale] = useState('en-US');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const spaceId = id.trim();
    if (!spaceId || !name.trim() || !defaultLocale.trim()) {
      setError('Space ID, name, and default locale are required.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await client.createSpace({ spaceId, name: name.trim(), defaultLocale: defaultLocale.trim() });
      await queryClient.invalidateQueries({ queryKey: ['spaces'] });
      props.onCreated(spaceId);
      props.onOpenChange(false);
      setId('');
      setName('');
    } catch (err) {
      // Creating a space is for deployment admins; say so on 403.
      const msg = err instanceof Error ? err.message : String(err);
      setError(/403/.test(msg) ? 'Only a deployment admin can create a space.' : msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New space</DialogTitle>
          <DialogDescription>
            Provision a new space with a main environment. Deployment admins only.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="space-id">Space ID</Label>
              <Input
                id="space-id"
                value={id}
                placeholder="blog"
                className="font-mono"
                onChange={(e) => setId(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="space-name">Name</Label>
              <Input
                id="space-name"
                value={name}
                placeholder="Blog"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="space-locale">Default locale</Label>
            <Input
              id="space-locale"
              value={defaultLocale}
              className="w-32 font-mono"
              onChange={(e) => setDefaultLocale(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create & switch'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
