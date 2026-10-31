import type { EntryFields, LocaleCode, LocalizedValue } from './types.js';

/**
 * Locale configuration for a space: the default locale plus an optional
 * fallback chain. When a value is missing in a requested locale, resolution
 * walks the fallback chain (and finally the default locale).
 */
export interface LocaleConfig {
  readonly defaultLocale: LocaleCode;
  readonly locales: readonly LocaleCode[];
  /** locale -> the locale to fall back to (null = no further fallback). */
  readonly fallbacks?: Readonly<Record<LocaleCode, LocaleCode | null>>;
}

/** Builds the ordered fallback chain for a requested locale (most specific first). */
export function fallbackChain(config: LocaleConfig, requested: LocaleCode): LocaleCode[] {
  const chain: LocaleCode[] = [];
  const seen = new Set<LocaleCode>();
  let current: LocaleCode | null = requested;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = config.fallbacks?.[current] ?? null;
  }
  if (!seen.has(config.defaultLocale)) chain.push(config.defaultLocale);
  return chain;
}

/** Resolves a single localized value following the fallback chain. */
export function resolveLocalizedValue(
  value: LocalizedValue,
  config: LocaleConfig,
  requested: LocaleCode,
): unknown {
  for (const locale of fallbackChain(config, requested)) {
    if (value[locale] !== undefined && value[locale] !== null) return value[locale];
  }
  return undefined;
}

/**
 * Flattens an entry's fields to a single requested locale, applying fallback.
 * Fields with no resolvable value are omitted. Used by Delivery/Preview when a
 * caller requests `?locale=`.
 */
export function resolveFieldsForLocale(
  fields: EntryFields,
  config: LocaleConfig,
  requested: LocaleCode,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [apiId, localized] of Object.entries(fields)) {
    const resolved = resolveLocalizedValue(localized, config, requested);
    if (resolved !== undefined) out[apiId] = resolved;
  }
  return out;
}
