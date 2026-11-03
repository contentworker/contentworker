import { FIELD_GUIDANCE_LIMITS } from '@contentworker/domain';
import { z } from 'zod';

/**
 * A field definition. Recursive (a component's nested fields are field
 * definitions too), so the nested shapes are described as open objects rather
 * than repeating this one: `z.lazy` would emit a `$ref` cycle the reference
 * renderer does not draw well, and the domain validates the deep shape anyway.
 */
const nestedFields = z
  .array(z.object({}).loose())
  .describe('Nested field definitions (this same shape), for a component');

const option = z
  .union([
    z.string().min(1),
    z.number(),
    z.object({
      value: z
        .union([z.string().min(1), z.number()])
        .describe('What an entry stores and is checked against'),
      label: z
        .string()
        .max(FIELD_GUIDANCE_LIMITS.optionLabel)
        .describe('What an editor picks it by'),
    }),
  ])
  .describe('An allowed value, bare or labelled, listed once');

const range = z.object({ min: z.number().optional(), max: z.number().optional() });

/** A field's validation rules. Every rule is optional; an absent rule is not enforced. */
export const fieldValidations = z
  .object({
    in: z
      .array(option)
      .optional()
      .describe(
        'Allowed values (Symbol, Text, Integer, Number). A labelled option stores its `value`',
      ),
    regexp: z
      .object({ pattern: z.string(), flags: z.string().optional() })
      .optional()
      .describe('A pattern a Symbol or Text value must match'),
    range: range.optional().describe('Inclusive bounds of an Integer or Number'),
    size: range
      .optional()
      .describe('Inclusive length of a Symbol, Text or Slug, or item count of an Array'),
    linkContentTypes: z
      .array(z.string())
      .optional()
      .describe('The content types a Link may point at'),
    messages: z
      .object({
        in: z.string().optional(),
        regexp: z.string().optional(),
        range: z.string().optional(),
        size: z.string().optional(),
      })
      .optional()
      .describe(
        `Error text a broken rule reports instead of the default, keyed by rule (at most ${FIELD_GUIDANCE_LIMITS.message} characters). Only for a rule the field declares`,
      ),
  })
  .loose();

export const field = z.object({
  apiId: z.string(),
  name: z.string(),
  help: z
    .string()
    .max(FIELD_GUIDANCE_LIMITS.help)
    .optional()
    .describe('How to fill the field: shown under the input in the editor and given to a model'),
  placeholder: z
    .string()
    .max(FIELD_GUIDANCE_LIMITS.placeholder)
    .optional()
    .describe('An example shown in the empty input; never stored'),
  description: z
    .string()
    .max(FIELD_GUIDANCE_LIMITS.description)
    .optional()
    .describe('What the field means, for agents and API readers'),
  type: z
    .string()
    .describe(
      'Field type: Symbol, Slug, Text, RichText, Integer, Number, Boolean, Date, Location, JSON, Link, Component or Array. RichText values are a document tree (`nodeType`/`content`), never HTML; external media is an `embed` node holding structured data',
    ),
  localized: z.boolean(),
  required: z.boolean(),
  position: z.int(),
  unique: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  validations: fieldValidations.optional(),
  linkType: z.enum(['Entry', 'Asset']).optional(),
  fields: nestedFields.optional().describe('Component: the nested field definitions'),
  items: z
    .object({
      type: z.enum(['Symbol', 'Link', 'Component']),
      linkType: z.enum(['Entry', 'Asset']).optional(),
      validations: fieldValidations.optional(),
      fields: nestedFields.optional().describe('Array of Component: the shape of every element'),
      variants: z
        .array(
          z.object({
            apiId: z.string().describe('Stored on each element as `_type`'),
            name: z.string(),
            fields: nestedFields,
          }),
        )
        .optional()
        .describe(
          'Array of Component: a blocks field. Each element is one of these shapes, stored as ' +
            '`{ "_type": <variant apiId>, "_key": <stable id, assigned on write>, ...values }`. ' +
            'Declared instead of `fields`, never with it.',
        ),
    })
    .optional()
    .describe('Array: the element definition'),
});

export const contentType = z.object({
  apiId: z.string(),
  name: z.string(),
  displayField: z.string(),
  fields: z.array(field),
  urlPattern: z
    .string()
    .optional()
    .describe('Where its entries live on the site, e.g. /blog/{slug}'),
  version: z.int(),
  status: z.enum(['draft', 'published']),
});

/** A published content type's place on the site, as Delivery serves it (`GET …/routes`). */
export const deliveredRoute = z.object({
  contentType: z.string().describe('Content type apiId'),
  urlPattern: z
    .string()
    .describe('Where its entries live, e.g. /blog/{slug}: {id}, {locale} or a Slug field apiId'),
});

export const deliveredRouteList = z.object({
  items: z.array(deliveredRoute),
  total: z.int(),
});

export const contentTypeEntryCounts = z.object({
  items: z.array(
    z.object({
      contentType: z.string().describe('Content type apiId'),
      total: z.int().describe('Live entries: draft, changed and published (not the trash)'),
      draft: z.int(),
      changed: z.int().describe('Published, with unpublished edits'),
      published: z.int(),
      archived: z.int().describe('In the trash'),
    }),
  ),
});
