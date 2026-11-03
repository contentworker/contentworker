---

name: model-content
description: Design or change a contentworker content model — create content types, choose field types, publish them, and get TypeScript types for the live model. Use before creating entries against a type that does not exist yet.
---

# Model content

A content type is a schema for entries. Entries validate against it on every write, and the
Delivery API serves only entries whose content type is published.

## Steps

1. **Look before you create.** `model_list_content_types`, then `model_get_content_type` for any
   type that looks close. `model_create_content_type` creates _or updates_ by `apiId`, so reusing an
   existing `apiId` replaces that definition.
2. **Define the type** with `model_create_content_type`:
   - `apiId` — stable machine name (`blogPost`); it is what entries and code refer to.
   - `displayField` — the field `entries_suggest` matches on and admins see as the title. Point it
     at a short text field.
   - `fields` — each has `apiId`, `name`, `type`, `position`, and optionally `localized`,
     `required`, `unique`, `defaultValue`, `validations`.
   - `urlPattern` (optional) — where the type's entries live on the site, e.g. `/blog/{slug}`;
     placeholders are `{id}`, `{locale}` or the apiId of one of the type's own `Slug` fields
     (`null` clears it). When a publish changes a slug it names, contentworker writes a `301` from
     the old path to the new one, so you rarely need to create that redirect yourself.
3. **Publish it** with `model_publish_content_type`. An unpublished change is invisible to
   delivery.
4. **Type your code** with `model_typescript` instead of guessing field names: it returns the delivery
   (locale-flattened) and management (locale-keyed) shapes for the live model.

## Choosing field types

| Need                                                            | Type                                            |
| --------------------------------------------------------------- | ----------------------------------------------- |
| Title, name, short label                                        | `Symbol`                                        |
| URL segment                                                     | `Slug` (usually `unique: true`)                 |
| Plain long text                                                 | `Text`                                          |
| Formatted body copy                                             | `RichText`                                      |
| Whole / decimal number                                          | `Integer` / `Number`                            |
| Flag                                                            | `Boolean`                                       |
| Date or timestamp                                               | `Date` (ISO-8601)                               |
| Coordinates                                                     | `Location` (`{ lat, lon }`)                     |
| Reference to another entry or an asset                          | `Link` with `linkType: 'Entry' \| 'Asset'`      |
| Reusable group of nested fields                                 | `Component`                                     |
| Search title, description, canonical URL, noindex, social image | `Seo` (one per type, top level; fixed shape)    |
| List of tags, references or components                          | `Array` with `items`                            |
| Page of mixed sections (blocks)                                 | `Array` with `items.variants` (see below)       |
| Anything else                                                   | `JSON` (last resort: no field-level validation) |

A `Seo` field's value is `{ title?, description?, canonicalUrl?, noindex?, ogImage? }` (`ogImage` is
an asset link; `canonicalUrl` a site path or an absolute http(s) URL). With a `urlPattern`, the
type's published entries are listed in the sitemap (`sitemap_list`), except `noindex` ones and ones
canonical elsewhere.

`unique` is allowed only on `Symbol`, `Slug`, `Text`, `Integer`, `Number` and `Date`, and never on a
field nested inside a `Component`.

## Blocks: a list of mixed shapes

When editors assemble a page from sections of different kinds (a hero, then rich text, then a call
to action), declare one `Array` field whose `items` lists the shapes as `variants` instead of
`fields`:

```json
{
  "apiId": "body",
  "name": "Body",
  "type": "Array",
  "position": 2,
  "items": {
    "type": "Component",
    "variants": [
      {
        "apiId": "hero",
        "name": "Hero",
        "fields": [
          {
            "apiId": "heading",
            "name": "Heading",
            "type": "Symbol",
            "required": true,
            "position": 0
          },
          { "apiId": "image", "name": "Image", "type": "Link", "linkType": "Asset", "position": 1 }
        ]
      },
      {
        "apiId": "cta",
        "name": "Call to action",
        "fields": [
          { "apiId": "label", "name": "Label", "type": "Symbol", "required": true, "position": 0 },
          {
            "apiId": "target",
            "name": "Target",
            "type": "Link",
            "linkType": "Entry",
            "position": 1
          }
        ]
      }
    ]
  }
}
```

- Each value is `{ "_type": "<variant apiId>", ...fields }`. The server adds a stable `_key` to
  every block that lacks one; send existing blocks back with their `_key` so they keep it.
- A variant's fields follow the component rules: not `localized`, not `unique`, no `Slug`, and
  they count toward the nesting limit.
- One optional block slot is the same field with `validations: { size: { max: 1 } }`.
- Adding a variant or an optional field is always safe. Removing a variant is refused while any
  entry still has a block of it; the error lists those entries.

## Rules worth knowing

- Mark a field `localized: true` only if its value really differs per locale. Non-localized fields
  still store `{ "<defaultLocale>": value }`, so the write shape is the same either way.
- Prefer `Link` over copying data between types: references stay correct when the target changes.
- For exact rules (validations, nesting limits), `docs_read` the `domain-model` page.
- Redirects are delivery data a front end applies: `redirects_list`, `redirects_create`,
  `redirects_update`, `redirects_delete`, `redirects_import` (CSV or JSON; `dryRun` first),
  `redirects_resolve` to test a path, `redirects_analyze` for loops and chains and
  `redirects_collapse_chains`. A loop is refused; a chain is allowed. Use `docs_read` for details.
