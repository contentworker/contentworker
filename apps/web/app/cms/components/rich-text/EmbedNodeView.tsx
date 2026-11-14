import { cn } from '@contentworker/ui/lib/utils';
import { SkeletonText } from '@contentworker/ui/skeleton';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper } from '@tiptap/react';
import { FileText, Image } from 'lucide-react';
import { createContext, useContext, useId } from 'react';
import { EntityPicker } from '~/cms/components/EntityPicker';
import type { Pickers } from '../EntryForm';
import { targetName, useLinkTarget } from './link-target';

/** Picker options reach embed NodeViews through context (they render in portals). */
export const RichTextPickersContext = createContext<Pickers>({ entries: [], assets: [] });

/** Card for an embedded entry/asset atom: icon, label, and a target picker. */
export function EmbedNodeView(props: NodeViewProps) {
  const pickers = useContext(RichTextPickersContext);
  const pickerId = useId();
  const isAsset = props.node.type.name === 'embeddedAssetBlock';
  const linkType = isAsset ? 'Asset' : 'Entry';
  const options = isAsset ? pickers.assets : pickers.entries;
  const targetId = (props.node.attrs.targetId as string) ?? '';
  const label = isAsset ? 'asset' : 'entry';
  const target = useLinkTarget(linkType, targetId, pickers);
  // A target looked up past the picker's first page is offered too, so the picker names it.
  const offered =
    target.status === 'found' && !options.includes(target.option)
      ? [target.option, ...options]
      : options;
  // A target that is gone (or can't be read now) isn't shown as picked: its id is all there is.
  const gone = target.status === 'missing' || target.status === 'failed';

  return (
    <NodeViewWrapper data-testid={`embed-${label}`} className="my-2">
      <div
        data-drag-handle
        className="flex items-center gap-2 rounded-md border bg-muted/40 p-2"
        contentEditable={false}
      >
        {isAsset ? (
          <Image className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <FileText className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="text-muted-foreground text-xs">Embedded {label}</span>
        {gone ? (
          <span data-slot="embed-status" className="shrink-0 text-muted-foreground text-xs">
            {missingText(linkType, target.status)}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          {target.status === 'loading' ? (
            <span className="block text-sm">
              <SkeletonText width="40%" />
              <span className="sr-only">Loading {label}</span>
            </span>
          ) : (
            <EntityPicker
              id={pickerId}
              ariaLabel={`Pick an ${label}`}
              options={offered}
              value={gone ? '' : targetId}
              placeholder={gone ? `Pick another ${label}…` : `Search for an ${label}…`}
              onChange={(v) => props.updateAttributes({ targetId: v ?? '' })}
            />
          )}
        </div>
      </div>
    </NodeViewWrapper>
  );
}

/** Said in place of a target's name when it can't be shown: never its bare id. */
function missingText(linkType: 'Entry' | 'Asset', status: 'missing' | 'failed'): string {
  const noun = linkType === 'Asset' ? 'Asset' : 'Entry';
  return status === 'missing' ? `${noun} not found` : `${noun} couldn't be loaded`;
}

/** Inline chip for an entry embedded mid-sentence (targetId picked on insert). */
export function InlineEmbedNodeView(props: NodeViewProps) {
  const pickers = useContext(RichTextPickersContext);
  const targetId = (props.node.attrs.targetId as string) ?? '';
  const target = useLinkTarget('Entry', targetId, pickers);
  const resolved = target.status === 'found';
  return (
    <NodeViewWrapper as="span" className="inline" contentEditable={false}>
      <span
        data-testid="embed-inline-entry"
        className={cn(
          'mx-0.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs',
          resolved || target.status === 'loading'
            ? 'bg-primary/10 text-primary'
            : 'bg-muted text-muted-foreground',
        )}
      >
        <FileText className="size-3" />
        {target.status === 'found' ? (
          targetName('Entry', target.option)
        ) : target.status === 'loading' ? (
          <>
            <SkeletonText width="5em" className="w-auto" />
            <span className="sr-only">Loading entry</span>
          </>
        ) : target.status === 'empty' ? (
          'No entry picked'
        ) : (
          missingText('Entry', target.status)
        )}
      </span>
    </NodeViewWrapper>
  );
}

/** Muted chip for a stored node the editor doesn't model (kept losslessly). */
export function UnknownNodeView(props: NodeViewProps) {
  const raw = props.node.attrs.raw as { nodeType?: string } | null;
  const inline = props.node.isInline;
  return (
    <NodeViewWrapper
      as={inline ? 'span' : 'div'}
      className={inline ? 'inline' : 'my-2'}
      contentEditable={false}
    >
      <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
        Unsupported {inline ? 'content' : 'block'}: {raw?.nodeType ?? 'unknown'}
      </span>
    </NodeViewWrapper>
  );
}
