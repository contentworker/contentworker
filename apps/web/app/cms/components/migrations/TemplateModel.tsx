import {
  blockVariants,
  type ContentTypeDraft,
  type FieldDefinition,
  MIGRATION_SOURCE_URL_FIELD,
} from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import { useState } from 'react';
import { TextView } from '~/cms/components/block-config/code-views';

/** What a template with no model yet starts from: the least the API takes. */
export const MODEL_SCAFFOLD = {
  apiId: 'page',
  name: 'Page',
  displayField: 'title',
  urlPattern: '/{slug}',
  fields: [
    {
      apiId: 'title',
      name: 'Title',
      type: 'Symbol',
      required: true,
      localized: false,
      position: 0,
    },
    { apiId: 'slug', name: 'Slug', type: 'Slug', required: true, localized: false, position: 1 },
    {
      apiId: 'body',
      name: 'Body',
      type: 'Array',
      required: false,
      localized: false,
      position: 2,
      items: {
        type: 'Component',
        variants: [
          {
            apiId: 'text',
            name: 'Text',
            fields: [
              {
                apiId: 'content',
                name: 'Content',
                type: 'RichText',
                required: false,
                localized: false,
                position: 0,
              },
            ],
          },
        ],
      },
    },
  ],
};

/** A field's type in words: what it links to, what its list holds. */
function typeOf(f: FieldDefinition): string {
  if (blockVariants(f)) return 'Blocks';
  if (f.type === 'Array') {
    const of = f.items?.linkType ? `${f.items.linkType} links` : (f.items?.type ?? 'anything');
    return `List of ${of}`;
  }
  return f.type === 'Link' && f.linkType ? `${f.linkType} link` : f.type;
}

/** A proposed content type as a list a person reads before approving it: every field, nested ones too. */
export function TemplateModel({ model }: { model: ContentTypeDraft }) {
  const [json, setJson] = useState(false);
  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <Fact label="Name">{model.name}</Fact>
        <Fact label="API ID" mono>
          {model.apiId}
        </Fact>
        <Fact label="Title field" mono>
          {model.displayField}
        </Fact>
        <Fact label="URL pattern" mono>
          {model.urlPattern ?? 'None'}
        </Fact>
      </dl>
      {model.description ? (
        <p className="max-w-measure text-muted-foreground text-sm wrap-anywhere">
          {model.description}
        </p>
      ) : null}
      <FieldList fields={model.fields} label="Fields" />
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-expanded={json}
        onClick={() => setJson((j) => !j)}
      >
        {json ? 'Hide JSON' : 'Show as JSON'}
      </Button>
      {json ? (
        <TextView text={JSON.stringify(model, null, 2)} label="Content model as JSON" />
      ) : null}
    </div>
  );
}

function Fact({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="caption">{label}</dt>
      <dd className={mono ? 'font-mono text-xs wrap-anywhere' : 'wrap-anywhere'}>{children}</dd>
    </div>
  );
}

function FieldList({ fields, label }: { fields: readonly FieldDefinition[]; label: string }) {
  if (fields.length === 0) return <p className="text-muted-foreground text-xs">No fields.</p>;
  return (
    <ul aria-label={label} className="space-y-2 text-sm">
      {fields.map((f) => {
        const variants = blockVariants(f);
        const nested = f.fields ?? f.items?.fields;
        return (
          <li key={f.apiId} className="space-y-2">
            <p className="flex flex-wrap items-baseline gap-x-2 wrap-anywhere">
              <span className="font-medium">{f.name}</span>
              <code className="font-mono text-muted-foreground text-xs">{f.apiId}</code>
              <span className="text-muted-foreground text-xs">
                {[
                  typeOf(f),
                  f.required ? 'Required' : undefined,
                  f.unique ? 'Unique' : undefined,
                  f.localized ? 'Localized' : undefined,
                  f.validations || f.items?.validations || f.rules?.length
                    ? 'Has rules: see the JSON'
                    : undefined,
                  f.apiId === MIGRATION_SOURCE_URL_FIELD
                    ? 'The page it came from, set by the load'
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </p>
            {nested ? (
              <div className="ml-4 border-l pl-3">
                <FieldList fields={nested} label={`Fields of ${f.name}`} />
              </div>
            ) : null}
            {variants ? (
              <ul aria-label={`Blocks of ${f.name}`} className="ml-4 space-y-3 border-l pl-3">
                {variants.map((v) => (
                  <li key={v.apiId} className="space-y-1">
                    <p className="flex flex-wrap items-baseline gap-x-2 wrap-anywhere">
                      <span className="font-medium">{v.name}</span>
                      <code className="font-mono text-muted-foreground text-xs">{v.apiId}</code>
                      <span className="text-muted-foreground text-xs">Block</span>
                    </p>
                    <div className="ml-4">
                      <FieldList fields={v.fields} label={`Fields of ${v.name}`} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
