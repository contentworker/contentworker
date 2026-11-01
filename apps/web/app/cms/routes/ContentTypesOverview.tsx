import type { ContentType, ContentTypeDraft } from '@contentworker/domain';
import { Button } from '@contentworker/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@contentworker/ui/card';
import { Plus, Shapes } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { ContentTypeDialog } from '~/cms/components/ContentTypeDialog';
import { Empty, PageHeader } from '~/cms/components/page';
import { StatusBadge } from '~/cms/components/status';
import { useClient } from '../lib/client-context';
import { useToast } from '../lib/toast';
import { useContentOutlet } from './content-context';

/** Content-types overview: a card per type with create / edit / publish, the
 * marquee surface for managing the space's schema from the UI. */
export function ContentTypesOverview() {
  const { client, run } = useClient();
  const { types, reload } = useContentOutlet();
  const toast = useToast();
  const [dialog, setDialog] = useState<{ open: boolean; initial?: ContentType }>({ open: false });

  const save = (draft: ContentTypeDraft) =>
    run(async () => {
      await client.saveContentType(draft);
      await client.publishContentType(draft.apiId);
      reload();
      toast.success(`Content type “${draft.name}” saved`);
    });

  const publish = (ct: ContentType) =>
    run(async () => {
      await client.publishContentType(ct.apiId);
      reload();
      toast.success(`Published “${ct.name}”`);
    });

  return (
    <div>
      <PageHeader
        title="Content"
        subtitle="Each content type is a schema; its entries are the content. Open one to browse and edit its entries."
        actions={
          <Button size="sm" onClick={() => setDialog({ open: true })}>
            <Plus aria-hidden="true" /> New content type
          </Button>
        }
      />
      {types.length === 0 ? (
        <Empty icon={<Shapes />} title="No content types yet" className="card">
          A content type defines the fields its entries have. Make one to start writing content.
        </Empty>
      ) : null}
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {types.map((ct) => (
          <li key={ct.apiId} className="flex">
            <Card className="w-full justify-between">
              <CardHeader>
                <CardTitle className="section-title">
                  <h2>{ct.name}</h2>
                </CardTitle>
                <CardDescription className="font-mono text-xs">{ct.apiId}</CardDescription>
                <CardAction>
                  <StatusBadge status={ct.status} />
                </CardAction>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground">
                {ct.fields.length} {ct.fields.length === 1 ? 'field' : 'fields'} · display:{' '}
                <span className="font-mono">{ct.displayField}</span>
              </CardContent>
              <CardFooter className="gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link to={`/content/${ct.apiId}`}>View entries</Link>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDialog({ open: true, initial: ct })}
                >
                  Edit
                </Button>
                {ct.status === 'draft' && (
                  <Button size="sm" onClick={() => publish(ct)}>
                    Publish
                  </Button>
                )}
              </CardFooter>
            </Card>
          </li>
        ))}
      </ul>

      {/* Key on the target so the form seeds fresh each time it opens. */}
      <ContentTypeDialog
        key={`${dialog.open}:${dialog.initial?.apiId ?? 'new'}`}
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        initial={dialog.initial}
        onSave={save}
      />
    </div>
  );
}
