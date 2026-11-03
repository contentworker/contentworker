import type { ContentTypeGrant } from '@contentworker/domain';
import { Alert, AlertDescription } from '@contentworker/ui/alert';
import { Button } from '@contentworker/ui/button';
import { Checkbox } from '@contentworker/ui/checkbox';
import { Label } from '@contentworker/ui/label';
import { NativeSelect, NativeSelectOption } from '@contentworker/ui/native-select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@contentworker/ui/sheet';
import { useState } from 'react';
import type { RoleSummary } from '../lib/management';
import {
  actionAvailable,
  CONTENT_ACTION_LABELS,
  CONTENT_ACTIONS,
  heldActions,
  setAction,
} from '../lib/role-grants';

const typeName = (apiId: string, names: ReadonlyMap<string, string>) =>
  apiId === '*' ? 'Every type' : (names.get(apiId) ?? apiId);

/**
 * A role's content access, per content type: what it may do with each, as five actions. Write and
 * Publish bring Delete and Unpublish with them, and unticking either finer one withholds it, so a
 * role can write without deleting or publish without unpublishing. Field rules are kept as they are.
 */
export function RoleAccessSheet(props: {
  role: RoleSummary;
  contentTypes: readonly { readonly apiId: string; readonly name: string }[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (grants: readonly ContentTypeGrant[]) => Promise<void>;
}) {
  const [grants, setGrants] = useState<readonly ContentTypeGrant[]>(props.role.contentGrants);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = new Map(props.contentTypes.map((t) => [t.apiId, t.name]));
  const addable = ['*', ...props.contentTypes.map((t) => t.apiId)].filter(
    (id) => !grants.some((g) => g.contentTypeApiId === id),
  );

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await props.onSave(grants);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader className="gap-1 border-b pt-4 pr-14 pb-3">
          <SheetTitle className="font-semibold text-base tracking-title">
            Content access: {props.role.name}
          </SheetTitle>
          <SheetDescription className="text-xs">
            Write and Publish bring Delete and Unpublish with them; untick either to withhold it. An
            exact type wins over Every type.
          </SheetDescription>
        </SheetHeader>
        <form className="space-y-4 p-4" onSubmit={save}>
          {grants.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No content: someone with this role sees and changes no entries.
            </p>
          ) : null}
          {grants.map((grant, index) => {
            const held = heldActions(grant);
            const type = typeName(grant.contentTypeApiId, names);
            return (
              <fieldset key={grant.contentTypeApiId} className="space-y-2 rounded-md border p-3">
                <legend className="font-medium text-sm">{type}</legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {CONTENT_ACTIONS.map((action) => {
                    const available = actionAvailable(held, action);
                    const { label, hint } = CONTENT_ACTION_LABELS[action];
                    return (
                      <Label
                        key={action}
                        className="flex items-start gap-2 font-normal aria-disabled:opacity-60"
                        aria-disabled={!available}
                      >
                        <Checkbox
                          aria-label={`${label} ${type}`}
                          checked={held.has(action)}
                          disabled={!available}
                          onCheckedChange={(c) =>
                            setGrants(
                              grants.map((g, i) =>
                                i === index ? setAction(g, action, c === true) : g,
                              ),
                            )
                          }
                        />
                        <span className="grid gap-0.5">
                          <span className="text-sm">{label}</span>
                          <span className="text-muted-foreground text-xs">{hint}</span>
                        </span>
                      </Label>
                    );
                  })}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-muted-foreground text-xs">
                    {grant.deniedFields?.length || grant.readOnlyFields?.length
                      ? `Field rules kept: ${grant.deniedFields?.length ?? 0} hidden, ${grant.readOnlyFields?.length ?? 0} read-only. `
                      : null}
                    {/* A withhold the boxes can't show, kept as it is. */}
                    {grant.deniedActions?.includes('unpublish') && !held.has('publish')
                      ? 'Unpublish stays withheld: live entries can’t be trashed.'
                      : null}
                  </p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove access to ${type}`}
                    onClick={() => setGrants(grants.filter((_, i) => i !== index))}
                  >
                    Remove
                  </Button>
                </div>
              </fieldset>
            );
          })}
          {addable.length > 0 ? (
            <div className="flex items-center gap-2">
              <NativeSelect
                aria-label="Content type to add"
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
              >
                <NativeSelectOption value="">Add a content type…</NativeSelectOption>
                {addable.map((id) => (
                  <NativeSelectOption key={id} value={id}>
                    {typeName(id, names)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!adding}
                onClick={() => {
                  setGrants([...grants, { contentTypeApiId: adding, actions: ['read'] }]);
                  setAdding('');
                }}
              >
                Add
              </Button>
            </div>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Save access
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
