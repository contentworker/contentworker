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
import { useEffect, useState } from 'react';
import { EmptyState } from '~/cms/components/page';
import { StatusBadge } from '~/cms/components/status';
import { useClient } from '../lib/client-context';
import type { WebhookDeliveryRecord, WebhookSummary } from '../lib/management';

/** Recent delivery attempts for a webhook (status, code, attempts, error, when). */
export function WebhookDeliveriesSheet(props: {
  webhook: WebhookSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { client } = useClient();
  const [deliveries, setDeliveries] = useState<WebhookDeliveryRecord[] | null>(null);

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
  }, [client, props.open, props.webhook.id]);

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Deliveries</SheetTitle>
          <SheetDescription className="break-all font-mono text-xs">
            {props.webhook.url}
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
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
              description="Delivery attempts appear here after a matching event is published."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <StatusBadge status={d.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{d.statusCode ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{d.attempts}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(d.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="max-w-48 truncate text-muted-foreground" title={d.error}>
                      {d.error ?? '—'}
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
