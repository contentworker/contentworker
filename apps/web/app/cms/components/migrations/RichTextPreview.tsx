import { type RichTextNode, safeLinkUri, validateRichText } from '@contentworker/domain';
import { EditorContent, useEditor } from '@tiptap/react';
import { useMemo } from 'react';
import { FieldValue, valueText } from '~/cms/components/EntryDiff';
import { buildExtensions } from '~/cms/components/rich-text/extensions';
import { toTiptap } from '~/cms/lib/rich-text-mapper';

/** A value's words, or that there's too much of it: a script's output can nest without end. */
export function safeText(value: unknown): string {
  try {
    return valueText(value);
  } catch {
    return 'Too deeply nested to show.';
  }
}

/**
 * The document with its links as the page has them: a relative one resolved against the page (in
 * the admin it would open an admin address), and any that isn't http(s), mailto or tel left as
 * its words.
 */
function withPageLinks(nodes: readonly RichTextNode[], pageUrl: string): RichTextNode[] {
  return nodes.flatMap((node) => {
    const content = node.content ? withPageLinks(node.content, pageUrl) : undefined;
    if (node.nodeType !== 'hyperlink') return [content ? { ...node, content } : node];
    let href: string | undefined;
    try {
      href = safeLinkUri(new URL(String(node.data?.uri ?? ''), pageUrl).href);
    } catch {
      href = undefined;
    }
    return href ? [{ ...node, data: { uri: href }, content: content ?? [] }] : (content ?? []);
  });
}

/**
 * A rich-text document from an import script's output, drawn by the admin's own rich-text
 * renderer, read-only. The output is the source site's content: only a document the domain would
 * store (`validateRichText`: known nodes, safe links, embeds from known providers) is drawn, its
 * links made the page's own; anything else is its plain words.
 */
export function RichTextPreview({
  value,
  label,
  pageUrl,
}: {
  value: unknown;
  label: string;
  pageUrl: string;
}) {
  const valid = useMemo(() => {
    try {
      return validateRichText(value).length === 0;
    } catch {
      return false;
    }
  }, [value]);
  if (!valid) return <FieldValue value={safeText(value)} />;
  return <Drawn value={value} label={label} pageUrl={pageUrl} />;
}

function Drawn({ value, label, pageUrl }: { value: unknown; label: string; pageUrl: string }) {
  const extensions = useMemo(() => buildExtensions(), []);
  const content = useMemo(() => {
    const doc = value as { readonly content: readonly RichTextNode[] };
    return toTiptap({ ...doc, content: withPageLinks(doc.content, pageUrl) });
  }, [value, pageUrl]);
  const editor = useEditor(
    {
      extensions,
      content,
      editable: false,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: 'rich-text-editor py-1 text-sm',
        },
      },
    },
    [content],
  );
  return (
    <section
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard.
      tabIndex={0}
      className="max-h-96 overflow-auto rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      data-slot="rich-text"
    >
      <EditorContent editor={editor} />
    </section>
  );
}
