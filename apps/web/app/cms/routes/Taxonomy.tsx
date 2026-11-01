import type { Concept } from '@contentworker/domain';
import { Badge } from '@contentworker/ui/badge';
import { Button } from '@contentworker/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@contentworker/ui/card';
import { Input } from '@contentworker/ui/input';
import { Label } from '@contentworker/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@contentworker/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@contentworker/ui/tabs';
import { Hash, Tags, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConfirmButton, InlineConfirm } from '~/cms/components/InlineConfirm';
import { EmptyState, PageHeader } from '~/cms/components/page';
import { useClient } from '../lib/client-context';
import { useInvalidate, useScopedQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

const NONE = '__none__';

/** Taxonomy admin: concept schemes + hierarchical concepts, and flat tags (P14). */
export function Taxonomy() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Taxonomy"
        subtitle="Controlled vocabulary: hierarchical concept schemes and flat tags."
      />
      <Tabs defaultValue="concepts">
        <TabsList>
          <TabsTrigger value="concepts">
            <Hash className="size-4" />
            Concepts
          </TabsTrigger>
          <TabsTrigger value="tags">
            <Tags className="size-4" />
            Tags
          </TabsTrigger>
        </TabsList>
        <TabsContent value="concepts" className="mt-4">
          <ConceptsTab />
        </TabsContent>
        <TabsContent value="tags" className="mt-4">
          <TagsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Consequence line for deleting a concept: names any narrower concepts under it. */
function narrowerNote(concepts: readonly Concept[], id: string): string {
  const narrower = concepts.filter((c) => c.broaderId === id).length;
  return narrower > 0
    ? `${narrower} narrower ${narrower === 1 ? 'concept sits' : 'concepts sit'} under it. This can’t be undone.`
    : 'This can’t be undone.';
}

/** Orders concepts as a depth-first tree and annotates each with its depth. */
function asTree(concepts: Concept[]): { concept: Concept; depth: number }[] {
  const byParent = new Map<string | null, Concept[]>();
  for (const c of concepts) {
    const key = c.broaderId ?? null;
    byParent.set(key, [...(byParent.get(key) ?? []), c]);
  }
  const out: { concept: Concept; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const c of byParent.get(parent) ?? []) {
      out.push({ concept: c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function ConceptsTab() {
  const { client, busy, run } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [pickedSchemeId, setPickedSchemeId] = useState('');
  const [newScheme, setNewScheme] = useState('');
  const [label, setLabel] = useState('');
  const [broaderId, setBroaderId] = useState<string>(NONE);
  // The scheme or concept whose delete is awaiting an inline "are you sure?".
  const [confirming, setConfirming] = useState<string | null>(null);

  const schemes = useScopedQuery(['schemes'], () => client.listSchemes()).data ?? [];
  // Default to the first scheme until the user picks one explicitly. The pick
  // must exist in the current list — after a delete or an environment switch a
  // stale pick would otherwise drive a concepts fetch for a missing scheme.
  const schemeId = schemes.some((s) => s.id === pickedSchemeId)
    ? pickedSchemeId
    : (schemes[0]?.id ?? '');
  const concepts =
    useScopedQuery(['concepts', schemeId], () => client.listConcepts(schemeId), {
      enabled: !!schemeId,
    }).data ?? [];

  const addScheme = () =>
    run(async () => {
      const created = await client.createScheme({ name: newScheme.trim() });
      setNewScheme('');
      toast.success('Scheme created');
      await invalidate(['schemes']);
      setPickedSchemeId(created.id);
    });

  const removeScheme = (id: string) =>
    run(async () => {
      await client.deleteScheme(id);
      toast.success('Scheme deleted');
      setPickedSchemeId('');
      // Refetch schemes first: once the deleted scheme is gone from the list,
      // its concepts query is inactive, so the concepts invalidation can't
      // fire a doomed listConcepts() against the deleted scheme.
      await invalidate(['schemes']);
      await invalidate(['concepts']);
    });

  const addConcept = () =>
    run(async () => {
      await client.createConcept({
        schemeId,
        prefLabel: label.trim(),
        broaderId: broaderId === NONE ? null : broaderId,
      });
      setLabel('');
      setBroaderId(NONE);
      await invalidate(['concepts', schemeId]);
    });

  const removeConcept = (id: string) =>
    run(async () => {
      await client.deleteConcept(id);
      await invalidate(['concepts', schemeId]);
    });

  const tree = asTree(concepts);

  return (
    <div className="grid gap-4 md:grid-cols-[260px_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Schemes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={newScheme}
              onChange={(e) => setNewScheme(e.target.value)}
              placeholder="New scheme"
            />
            <Button
              type="button"
              size="sm"
              disabled={!newScheme.trim() || busy}
              onClick={addScheme}
            >
              Add
            </Button>
          </div>
          {schemes.length === 0 ? (
            <p className="text-muted-foreground text-sm">No schemes yet.</p>
          ) : (
            <ul className="space-y-1">
              {schemes.map((s) => (
                <li key={s.id} className="group flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    className={`flex-1 truncate rounded-md px-2 py-1 text-left text-sm ${
                      s.id === schemeId ? 'bg-muted font-medium' : 'hover:bg-muted/60'
                    }`}
                    onClick={() => setPickedSchemeId(s.id)}
                  >
                    {s.name}
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
                    id={`scheme-delete-${s.id}`}
                    aria-label={`Delete “${s.name}”`}
                    aria-expanded={confirming === s.id}
                    onClick={() => setConfirming(confirming === s.id ? null : s.id)}
                    disabled={busy}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                  {confirming === s.id && (
                    <InlineConfirm
                      message={`Delete “${s.name}”?`}
                      note={
                        s.id === schemeId && concepts.length > 0
                          ? `It holds ${concepts.length} ${concepts.length === 1 ? 'concept' : 'concepts'}. This can’t be undone.`
                          : 'This can’t be undone.'
                      }
                      onCancel={() => setConfirming(null)}
                      returnFocus={() => document.getElementById(`scheme-delete-${s.id}`)}
                    >
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => {
                          setConfirming(null);
                          void removeScheme(s.id);
                        }}
                      >
                        Delete scheme
                      </Button>
                    </InlineConfirm>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Concepts</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!schemeId ? (
            <p className="text-muted-foreground text-sm">Select or create a scheme.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex-1 space-y-1.5">
                  <Label>Preferred label</Label>
                  <Input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. Cats"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Broader</Label>
                  <Select value={broaderId} onValueChange={setBroaderId}>
                    <SelectTrigger aria-label="Broader concept" className="w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>— top level —</SelectItem>
                      {concepts.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.prefLabel}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button type="button" disabled={!label.trim() || busy} onClick={addConcept}>
                  Add concept
                </Button>
              </div>

              {tree.length === 0 ? (
                <p className="text-muted-foreground text-sm">No concepts in this scheme yet.</p>
              ) : (
                <ul className="space-y-1">
                  {tree.map(({ concept, depth }) => (
                    <li
                      key={concept.id}
                      className="group flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
                      style={{ paddingLeft: `${depth * 1.5 + 0.5}rem` }}
                    >
                      <span className="text-sm">
                        {depth > 0 && <span className="text-muted-foreground">↳ </span>}
                        {concept.prefLabel}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
                        id={`concept-delete-${concept.id}`}
                        aria-label={`Delete “${concept.prefLabel}”`}
                        aria-expanded={confirming === concept.id}
                        onClick={() => setConfirming(confirming === concept.id ? null : concept.id)}
                        disabled={busy}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                      {confirming === concept.id && (
                        <InlineConfirm
                          message={`Delete “${concept.prefLabel}”?`}
                          note={narrowerNote(concepts, concept.id)}
                          onCancel={() => setConfirming(null)}
                          returnFocus={() =>
                            document.getElementById(`concept-delete-${concept.id}`)
                          }
                        >
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={busy}
                            onClick={() => {
                              setConfirming(null);
                              void removeConcept(concept.id);
                            }}
                          >
                            Delete concept
                          </Button>
                        </InlineConfirm>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TagsTab() {
  const { client, busy, run } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [name, setName] = useState('');

  const tags = useScopedQuery(['tags'], () => client.listTags()).data ?? [];

  const add = () =>
    run(async () => {
      await client.createTag({ name: name.trim() });
      setName('');
      await invalidate(['tags']);
    });

  const remove = (id: string) =>
    run(async () => {
      await client.deleteTag(id);
      toast.success('Tag deleted');
      await invalidate(['tags']);
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tags</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 sm:max-w-sm">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New tag" />
          <Button type="button" disabled={!name.trim() || busy} onClick={add}>
            Add tag
          </Button>
        </div>
        {tags.length === 0 ? (
          <EmptyState icon={Tags} title="No tags yet" description="Add a tag to label entries." />
        ) : (
          <div className="flex flex-wrap gap-2">
            {tags.map((t) => (
              <ConfirmButton
                key={t.id}
                message={`Delete the tag “${t.name}”?`}
                note="This can’t be undone."
                confirmLabel="Delete tag"
                busy={busy}
                onConfirm={() => void remove(t.id)}
              >
                {(ask) => (
                  <Badge variant="secondary" className="gap-1.5 py-1">
                    {t.name}
                    <button
                      type="button"
                      aria-label={`Delete ${t.name}`}
                      onClick={ask}
                      disabled={busy}
                      className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </Badge>
                )}
              </ConfirmButton>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
