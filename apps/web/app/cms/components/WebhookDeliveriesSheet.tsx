import { Button } from '@contentworker/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@contentworker/ui/sheet';
import { Skeleton } from '@contentworker/ui/skeleton';
import {
  Table,
  TableBody,
  Td as TableCell,
  Th as TableHead,
  TableHead as TableHeader,
  Tr as TableRow,
} from '@contentworker/ui/table';
import { Send } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Ago } from '~/cms/components/ago';
import { EmptyState } from '~/cms/components/page';
import { StatusBadge } from '~/cms/components/status';
import { useClient } from '../lib/client-context';
import type { WebhookDeliveryRecord, WebhookSummary } from '../lib/management';
import { useToast } from '../lib/toast';

/**
 * Recent delivery attempts for a webhook (event, status, code, attempts, error, when), each of
 * which can be sent again. A resend is queued for the engine, so it shows up on the next refresh.
 */
export function WebhookDeliveriesSheet(props: {
  webhook: WebhookSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { client } = useClient();
  const toast = useToast();
  const [deliveries, setDeliveries] = useState<WebhookDeliveryRecord[] | null>(null);
  const [resending, setResending] = useState<number | null>(null);
  // Bumped to read the log again (after a resend has had time to go out); a dependency below.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!props.open) return;
    let live = true;
    setDeliveries(null);
    client
      .webhookDeliveries(props.webhook.id, 50)
      .then((d) => live && setDeliveries(d))
      .catch(() => live && setDeliveries([]));
    return () => {
      live = false;
    };
  }, [client, props.open, props.webhook.id, generation]);

  const refresh = useCallback(() => setGeneration((g) => g + 1), []);

  const resend = async (d: WebhookDeliveryRecord) => {
    setResending(d.id);
    try {
      await client.resendWebhookDelivery(props.webhook.id, d.id);
      toast.success('Resend queued. Refresh to see the new attempt.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setResending(null);
    }
  };

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>Deliveries</SheetTitle>
          <SheetDescription className="break-all font-mono text-xs">
            {props.webhook.url}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-2 px-4 pb-4">
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={refresh}>
              Refresh
            </Button>
          </div>
          {deliveries === null ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : deliveries.length === 0 ? (
            <EmptyState
              icon={Send}
              title="No deliveries yet"
              description="Delivery attempts appear here after a matching event is published, or a test is sent."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-mono text-xs">
                      {d.eventType ?? '—'}
                      {d.resendOf !== undefined && (
                        <span className="block text-muted-foreground">resend of #{d.resendOf}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={d.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{d.statusCode ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{d.attempts}</TableCell>
                    <TableCell className="text-muted-foreground">
                      <Ago at={d.createdAt} />
                    </TableCell>
                    <TableCell className="max-w-48 truncate text-muted-foreground" title={d.error}>
                      {d.error ?? '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={resending !== null}
                        aria-label={`Resend delivery #${d.id}`}
                        onClick={() => resend(d)}
                      >
                        {resending === d.id ? 'Resending…' : 'Resend'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
