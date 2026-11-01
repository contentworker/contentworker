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
3. **Publish it** with `model_publish_content_type`. An unpublished change is invisible to
   delivery.
4. **Type your code** with `model_typescript` instead of guessing field names: it returns the delivery
   (locale-flattened) and management (locale-keyed) shapes for the live model.

## Choosing field types

| Need                                   | Type                                            |
| -------------------------------------- | ----------------------------------------------- |
| Title, name, short label               | `Symbol`                                        |
| URL segment                            | `Slug` (usually `unique: true`)                 |
| Plain long text                        | `Text`                                          |
| Formatted body copy                    | `RichText`                                      |
| Whole / decimal number                 | `Integer` / `Number`                            |
| Flag                                   | `Boolean`                                       |
| Date or timestamp                      | `Date` (ISO-8601)                               |
| Coordinates                            | `Location` (`{ lat, lon }`)                     |
| Reference to another entry or an asset | `Link` with `linkType: 'Entry' \| 'Asset'`      |
| Reusable group of nested fields        | `Component`                                     |
| List of tags, references or components | `Array` with `items`                            |
| Anything else                          | `JSON` (last resort: no field-level validation) |

`unique` is allowed only on `Symbol`, `Slug`, `Text`, `Integer`, `Number` and `Date`, and never on a
field nested inside a `Component`.

## Rules worth knowing

- Mark a field `localized: true` only if its value really differs per locale. Non-localized fields
  still store `{ "<defaultLocale>": value }`, so the write shape is the same either way.
- Prefer `Link` over copying data between types: references stay correct when the target changes.
- For exact rules (validations, nesting limits), `docs_read` the `domain-model` page.
