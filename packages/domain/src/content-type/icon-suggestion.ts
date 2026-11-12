/**
 * The icons the admin draws for a content type, each with the words (singular, lower case) that
 * suggest it. The keys are the names a type's `icon` holds; the admin maps them to drawings.
 */
export const CONTENT_TYPE_ICON_WORDS: Readonly<Record<string, readonly string[]>> = {
  newspaper: ['article', 'post', 'blog', 'news', 'story', 'insight', 'bulletin', 'press'],
  user: ['author', 'person', 'profile', 'contact', 'member', 'speaker'],
  users: ['team', 'people', 'staff', 'partner', 'customer', 'client'],
  calendar: ['event', 'webinar', 'conference', 'session', 'schedule'],
  'shopping-bag': ['product', 'shop', 'store', 'offer', 'order'],
  'book-open': ['recipe', 'guide', 'book', 'doc', 'series', 'study', 'course', 'lesson'],
  'file-text': ['page', 'document', 'policy', 'disclaimer', 'term', 'note'],
  'layout-template': ['landing', 'home', 'homepage', 'template', 'layout'],
  tag: ['category', 'tag', 'topic', 'label'],
  image: ['image', 'photo', 'gallery', 'banner'],
  video: ['video', 'podcast', 'episode', 'webcast'],
  'map-pin': ['office', 'location', 'place', 'venue', 'region'],
  briefcase: ['career', 'job', 'service', 'industry', 'role'],
  megaphone: ['announcement', 'campaign', 'cta', 'promo', 'promotion', 'release'],
  mail: ['email', 'newsletter', 'form', 'message'],
  star: ['review', 'testimonial', 'feature', 'award'],
  folder: ['collection', 'folder', 'project', 'portfolio'],
  box: ['setting', 'block', 'component', 'config', 'navigation', 'menu'],
};

const ICON_OF_WORD: ReadonlyMap<string, string> = new Map(
  Object.entries(CONTENT_TYPE_ICON_WORDS).flatMap(([icon, words]) =>
    words.map((word) => [word, icon] as const),
  ),
);

/** A name's words, lower case, each also in the singular: "Press releases", `pressRelease`. */
const wordsOf = (text: string): string[] =>
  text
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .flatMap((word) => [word, word.replace(/ies$/, 'y'), word.replace(/s$/, '')]);

/**
 * The icon a content type's name suggests, or undefined when it suggests none. The last word that
 * names one wins, since it is the noun ("Landing page" is a page, "Media contact" a contact); the
 * name is read before the API id, which decides only when the name says nothing.
 */
export function suggestContentTypeIcon(type: {
  readonly name?: string | undefined;
  readonly apiId?: string | undefined;
}): string | undefined {
  for (const text of [type.name, type.apiId]) {
    const word = wordsOf(text ?? '')
      .reverse()
      .find((w) => ICON_OF_WORD.has(w));
    if (word) return ICON_OF_WORD.get(word);
  }
  return undefined;
}
