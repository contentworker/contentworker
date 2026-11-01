import { isReservedSpaceId, isSpaceId, normalizeSlug } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@contentworker/ui/dialog';
import { Input } from '@contentworker/ui/input';
import { Label } from '@contentworker/ui/label';
import { cn } from '@contentworker/ui/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useClient } from '../../lib/client-context';
import type { SpaceStarter } from '../../lib/management';

const STARTER_CHOICES: readonly {
  value: SpaceStarter;
  title: string;
  description: string;
}[] = [
  {
    value: 'sample',
    title: 'Start with sample content',
    description:
      'A content model covering every field type, a few dozen entries in each state, ' +
      'taxonomy, sample media and one open release. Edit or delete any of it.',
  },
  {
    value: 'empty',
    title: 'Empty space',
    description: 'No content types and no entries: model your content from scratch.',
  },
];

/** The space id a name suggests: the API's id rule, from a slug of the name. */
export function spaceIdFrom(name: string): string {
  return normalizeSlug(name).slice(0, 64).replace(/-+$/, '');
}

/**
 * Creates a space, with or without the sample starter, and switches to it. Deployment admins only
 * (the api refuses anyone else); opened from the space menu and from the CMS's no-spaces notice.
 * The id follows the name until it's edited, and is checked the way the API checks it.
 */
export function CreateSpaceDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const { client, spaces } = useClient();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [defaultLocale, setDefaultLocale] = useState('en-US');
  const [starter, setStarter] = useState<SpaceStarter>('sample');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const uid = useId();

  const spaceId = idEdited ? id.trim() : spaceIdFrom(name);
  const idProblem = !spaceId
    ? undefined
    : !isSpaceId(spaceId)
      ? 'Use up to 64 letters, digits, “.”, “_” or “-”, starting with a letter or digit.'
      : isReservedSpaceId(spaceId)
        ? 'This id is reserved. Choose another.'
        : spaces?.some((s) => s.id === spaceId)
          ? 'A space with this id already exists.'
          : undefined;
  const locale = defaultLocale.trim();
  const localeProblem =
    locale && (locale.length < 2 || locale.length > 35)
      ? 'A locale code is 2 to 35 characters, like en-US.'
      : undefined;

  const reset = () => {
    setName('');
    setId('');
    setIdEdited(false);
    setStarter('sample');
    setError(undefined);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !spaceId || !locale) {
      setError('A name, a space id and a default locale are required.');
      return;
    }
    if (idProblem || localeProblem) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.createSpace({ spaceId, name: name.trim(), defaultLocale: locale, starter });
      // The new space must be on the list before switching to it, or the scope falls back to
      // the first space on the (stale) list.
      await queryClient.invalidateQueries({ queryKey: ['spaces'] });
      props.onCreated(spaceId);
      props.onOpenChange(false);
      reset();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(
        /→ 403/.test(msg)
          ? 'Only a deployment admin can create a space.'
          : starter === 'sample'
            ? `Couldn’t finish creating the space. Try again: what was installed is kept, and nothing is added twice. (${msg})`
            : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (busy) return;
        props.onOpenChange(open);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New space</DialogTitle>
          <DialogDescription>
            A space holds its own content model, entries, media and team, with a main environment to
            start.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-name`}>Name</Label>
            <Input
              id={`${uid}-name`}
              value={name}
              placeholder="Marketing site"
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-id`}>Space ID</Label>
              <Input
                id={`${uid}-id`}
                value={spaceId}
                placeholder="marketing-site"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={idProblem ? true : undefined}
                aria-describedby={`${uid}-id-hint`}
                onChange={(e) => {
                  setIdEdited(true);
                  setId(e.target.value);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${uid}-locale`}>Default locale</Label>
              <Input
                id={`${uid}-locale`}
                value={defaultLocale}
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={localeProblem ? true : undefined}
                onChange={(e) => setDefaultLocale(e.target.value)}
              />
            </div>
          </div>
          <p
            id={`${uid}-id-hint`}
            className={cn(
              'max-w-measure text-xs',
              idProblem || localeProblem ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {idProblem ??
              localeProblem ??
              'The id appears in API paths and can’t be changed later.'}
          </p>
          <fieldset className="space-y-2">
            <legend className="caption mb-2 text-muted-foreground">Start with</legend>
            {STARTER_CHOICES.map((choice) => (
              <label
                key={choice.value}
                className="flex cursor-pointer gap-3 rounded-xl bg-muted p-4 ring-foreground has-checked:ring-2 has-focus-visible:outline-2 has-focus-visible:outline-offset-2"
              >
                <input
                  type="radio"
                  name={`${uid}-starter`}
                  value={choice.value}
                  checked={starter === choice.value}
                  onChange={() => setStarter(choice.value)}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium text-sm">
                    {choice.title}
                    {choice.value === 'sample' && (
                      <span className="ml-2 text-muted-foreground text-xs font-normal">
                        Recommended
                      </span>
                    )}
                  </span>
                  <span className="max-w-measure text-muted-foreground text-xs">
                    {choice.description}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => props.onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy
                ? starter === 'sample'
                  ? 'Installing sample content…'
                  : 'Creating…'
                : 'Create space'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
