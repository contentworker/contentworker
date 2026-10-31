import { Badge } from '@contentworker/ui/badge';
import { Button } from '@contentworker/ui/button';
import { Card, CardContent, CardHeader } from '@contentworker/ui/card';
import { Input } from '@contentworker/ui/input';
import { Label } from '@contentworker/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentworker/ui/select';
import {
  Table,
  TableBody,
  Td as TableCell,
  Th as TableHead,
  TableHead as TableHeader,
  Tr as TableRow,
} from '@contentworker/ui/table';
import { PanelRight, Puzzle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ConfirmButton } from '~/cms/components/InlineConfirm';
import type { AppExtension, ManagementClient } from '../lib/management';
import { useToast } from '../lib/toast';

/** Manage admin UI extensions: custom field editors and sidebar widgets rendered in sandboxed iframes. */
export function AppExtensions(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const [apps, setApps] = useState<AppExtension[]>([]);
  const [name, setName] = useState('');
  const [target, setTarget] = useState<AppExtension['target']>('sidebar');
  const [entryUrl, setEntryUrl] = useState('');
  const [fieldTypes, setFieldTypes] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setApps(await client.listAppExtensions());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [client, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await client.createAppExtension({
        name: name.trim(),
        target,
        entryUrl: entryUrl.trim(),
        fieldTypes:
          target === 'field-editor' && fieldTypes.trim()
            ? fieldTypes
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined,
      });
      setName('');
      setEntryUrl('');
      setFieldTypes('');
      await load();
      toast.success('Extension installed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await client.deleteAppExtension(id);
      await load();
      toast.success('Removed');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <h2 className="font-heading font-medium text-base">Install extension</h2>
          <p className="text-muted-foreground text-sm">
            An external page rendered in a sandboxed iframe. A <strong>sidebar</strong> widget shows
            on the entry editor; a <strong>field editor</strong> replaces the built-in input for the
            given field types. The host posts the editing context over <code>postMessage</code>.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="ext-name">Name</Label>
              <Input
                id="ext-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="color-picker"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ext-target">Target</Label>
              <Select value={target} onValueChange={(v) => setTarget(v as AppExtension['target'])}>
                <SelectTrigger id="ext-target" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sidebar">Sidebar widget</SelectItem>
                  <SelectItem value="field-editor">Field editor</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {target === 'field-editor' && (
              <div className="space-y-1.5">
                <Label htmlFor="ext-fieldtypes">Field types</Label>
                <Input
                  id="ext-fieldtypes"
                  value={fieldTypes}
                  onChange={(e) => setFieldTypes(e.target.value)}
                  placeholder="Symbol, JSON"
                  className="w-40"
                />
              </div>
            )}
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="ext-url">URL</Label>
              <Input
                id="ext-url"
                value={entryUrl}
                onChange={(e) => setEntryUrl(e.target.value)}
                placeholder="https://example.com/extension"
              />
            </div>
            <Button type="submit" disabled={!name.trim() || !entryUrl.trim() || busy}>
              {busy ? 'Saving…' : 'Install'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {apps.length === 0 ? (
        <p className="text-muted-foreground text-sm">No extensions installed.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>URL</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {apps.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium">
                  <span className="flex items-center gap-1.5">
                    {a.target === 'sidebar' ? (
                      <PanelRight className="size-3.5 text-primary" />
                    ) : (
                      <Puzzle className="size-3.5 text-primary" />
                    )}
                    {a.name}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">
                    {a.target === 'sidebar'
                      ? 'Sidebar'
                      : `Field: ${a.fieldTypes?.join(', ') || 'any'}`}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-64 truncate font-mono text-muted-foreground text-xs">
                  {a.entryUrl}
                </TableCell>
                <TableCell>
                  <ConfirmButton
                    message={`Remove “${a.name}”?`}
                    note="Editors stop seeing it. This can’t be undone."
                    confirmLabel="Remove extension"
                    onConfirm={() => void remove(a.id)}
                  >
                    {(ask) => (
                      <Button type="button" variant="ghost" size="sm" onClick={ask}>
                        Remove
                      </Button>
                    )}
                  </ConfirmButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
