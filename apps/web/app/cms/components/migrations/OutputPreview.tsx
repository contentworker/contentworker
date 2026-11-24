import {
  blockVariants,
  type ContentTypeDraft,
  type FieldDefinition,
  isRichTextDocument,
} from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { useState } from 'react';
import { FieldValue } from '~/cms/components/EntryDiff';
import { ToneBadge } from '~/cms/components/status';
import { plural } from '~/cms/lib/format';
import type { MigrationTryPage } from '~/cms/lib/management';
import { RichTextPreview, safeText } from './RichTextPreview';
import { SourceLink } from './SourceLink';

/** Blocks drawn before Show all: each rich text in one is a renderer of its own. */
const BLOCKS_SHOWN = 10;
const URLS_SHOWN = 20;

/**
 * One sample page's try: how it scored, what's wrong, and the fields and blocks its entry would
 * have. Everything here is the page's content or the script's words, so all of it is text, except a
 * rich-text document the domain accepts, which the admin's own renderer draws.
 */
export function TryPage({
  result,
  threshold,
  model,
}: {
  result: MigrationTryPage;
  threshold: number | undefined;
  model: ContentTypeDraft | null;
}) {
  const [open, setOpen] = useState(false);
  const { score, output } = result;
  const passed = score !== undefined && threshold !== undefined && score.overall >= threshold;
  const problems = [...(result.error ? [result.error] : []), ...result.issues];
  return (
    <li className="tile space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1 basis-48">
          <SourceLink url={result.url} />
        </span>
        {!result.ok ? (
          <ToneBadge tone="bad" label="Doesn’t fit" />
        ) : (
          <ToneBadge
            tone={passed ? 'ok' : 'wait'}
            label={passed ? 'Passed' : 'Below the threshold'}
          />
        )}
        {score ? (
          <span className="text-xs tabular">
            {`Score ${score.overall.toFixed(2)} · ${Math.round(score.textCoverage * 100)}% of its text`}
          </span>
        ) : null}
      </div>
      <Words title="Problems" lines={problems} />
      <Words title="Score notes" lines={score?.issues ?? []} />
      {output || result.logs.length > 0 ? (
        <Button
          type="button"
          size="xs"
          variant="outline"
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} output of ${result.url}`}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Hide output' : 'Show output'}
        </Button>
      ) : null}
      {open ? <Output result={result} model={model} /> : null}
    </li>
  );
}

function Output({ result, model }: { result: MigrationTryPage; model: ContentTypeDraft | null }) {
  const [all, setAll] = useState(false);
  const { output } = result;
  const variants = model?.fields.map(blockVariants).find((v) => v !== undefined);
  const blocks = output ? (all ? output.blocks : output.blocks.slice(0, BLOCKS_SHOWN)) : [];
  return (
    <div className="space-y-4">
      {output ? (
        <>
          <Fields fields={output.fields} defs={model?.fields} pageUrl={result.url} />
          {blocks.length > 0 ? (
            <ol aria-label={`Blocks of ${result.url}`} className="divide-y">
              {blocks.map((b, i) => {
                const variant = variants?.find((v) => v.apiId === b.variant);
                return (
                  <li key={i} className="space-y-2 py-3">
                    <h3 className="font-medium text-sm wrap-anywhere">
                      {i + 1}. {variant?.name ?? b.variant}
                    </h3>
                    <Fields fields={b.fields} defs={variant?.fields} pageUrl={result.url} />
                  </li>
                );
              })}
            </ol>
          ) : null}
          {output.blocks.length > blocks.length ? (
            <Button type="button" size="xs" variant="ghost" onClick={() => setAll(true)}>
              Show all {plural(output.blocks.length, 'block')}
            </Button>
          ) : null}
          <Words title="Files it names" lines={output.assets.map((a) => a.url)} />
          <p className="text-muted-foreground text-xs">{plural(output.links.length, 'link')}</p>
        </>
      ) : null}
      <Words title="Script log" lines={result.logs} />
    </div>
  );
}

function Fields({
  fields,
  defs,
  pageUrl,
}: {
  fields: Readonly<Record<string, unknown>>;
  defs: readonly FieldDefinition[] | undefined;
  pageUrl: string;
}) {
  const entries = Object.entries(fields);
  if (entries.length === 0) return <p className="text-muted-foreground text-xs">No fields.</p>;
  return (
    <dl className="space-y-2 text-sm">
      {entries.map(([key, value]) => {
        const name = defs?.find((f) => f.apiId === key)?.name ?? key;
        return (
          <div key={key} className="space-y-0.5">
            <dt className="text-muted-foreground text-xs wrap-anywhere">{name}</dt>
            <dd className="min-w-0">
              {isRichTextDocument(value) ? (
                <RichTextPreview value={value} label={name} pageUrl={pageUrl} />
              ) : (
                <FieldValue value={safeText(value)} />
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** Lines of someone else's words (a script's log, a page's problems), as text. */
export function Words({ title, lines }: { title: string; lines: readonly string[] }) {
  if (lines.length === 0) return null;
  const more = lines.length - URLS_SHOWN;
  return (
    <div className="space-y-1">
      <h3 className="caption">{title}</h3>
      <ul aria-label={title} className="space-y-0.5 text-xs">
        {lines.slice(0, URLS_SHOWN).map((l, i) => (
          <li key={i} className="wrap-anywhere whitespace-pre-wrap text-muted-foreground">
            {l}
          </li>
        ))}
      </ul>
      {more > 0 ? <p className="text-muted-foreground text-xs">and {more} more</p> : null}
    </div>
  );
}
