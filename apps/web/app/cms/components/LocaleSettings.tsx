import { Alert, AlertDescription, AlertTitle } from '@contentworker/ui/alert';
import { Badge } from '@contentworker/ui/badge';
import { Button } from '@contentworker/ui/button';
import { Segmented, SegmentedItem } from '@contentworker/ui/segmented';
import { SkeletonPill, SkeletonText } from '@contentworker/ui/skeleton';
import { Switch } from '@contentworker/ui/switch';
import {
  Table,
  TableBody,
  Td as TableCell,
  Th as TableHead,
  TableHead as TableHeader,
  Tr as TableRow,
} from '@contentworker/ui/table';
import { useQueryClient } from '@tanstack/react-query';
import { Fragment, useId, useState } from 'react';
import { InlineConfirm } from '~/cms/components/InlineConfirm';
import { LoadingStatus } from '~/cms/components/loading';
import { Section } from '~/cms/components/page';
import { useClient } from '../lib/client-context';
import {
  apiErrorMessage,
  type ManagementClient,
  type SpaceConfig,
  type TextDirection,
} from '../lib/management';
import { useScopedQuery, useSpaceConfigQuery } from '../lib/queries';
import { useToast } from '../lib/toast';

/** The scope that changes locale settings, as `PUT …/locale-settings` checks it. */
const SPACE_ADMIN = 'space:admin';

type LocaleChange = { readonly delivered?: boolean; readonly direction?: TextDirection };

const DIRECTION_LABEL: Record<TextDirection, string> = {
  ltr: 'Left to right',
  rtl: 'Right to left',
};

/**
 * Settings → Locales: per locale, whether Delivery serves it and which way its text runs. One row
 * per locale (cards on a phone): its code (the default one badged), what it falls back to, a
 * Delivered switch and a Direction choice. A change saves at once, except turning Delivered off,
 * which asks first in place: Delivery stops serving that locale everywhere at once. The default
 * locale is always delivered (every fallback ends there), so its switch is off-limits and says
 * why. Changing any of it needs space:admin; anyone else reads the settings and is told so.
 */
export function LocaleSettings(props: { client: ManagementClient }) {
  const { client } = props;
  const { conn } = useClient();
  const toast = useToast();
  const queryClient = useQueryClient();
  const id = useId();
  const config = useSpaceConfigQuery();
  const access = useScopedQuery(['space-access'], () => client.getSpaceAccess(), {
    silent: true,
  });
  // Unknown while access loads; if it can't be read, the controls stay usable and the api decides.
  const canEdit = access.data
    ? access.data.scopes.includes(SPACE_ADMIN)
    : access.isError
      ? true
      : undefined;
  const [saving, setSaving] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const save = async (locale: string, change: LocaleChange) => {
    setSaving(locale);
    try {
      const next = await client.setLocaleSettings({ [locale]: change });
      // The settings are the space's, so every environment's cached config is stale now.
      queryClient.setQueryData([conn.space, conn.environment, 'space-config'], next);
      await queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] === conn.space && q.queryKey[2] === 'space-config',
      });
      toast.success(
        change.delivered === false
          ? `Delivery no longer serves ${locale}`
          : change.delivered === true
            ? `Delivery serves ${locale}`
            : `${locale} runs ${DIRECTION_LABEL[change.direction ?? 'ltr'].toLowerCase()}`,
      );
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setSaving(null);
    }
  };

  const cfg = config.data;
  return (
    <Section
      title="Locales"
      description="Which locales Delivery serves, and which way each one’s text runs. Every environment of the space shares them."
      flush
    >
      {cfg === undefined && config.isError ? (
        <div className="px-5 pb-5">
          {/* A failed load is said as one, never as locales that look turned off. */}
          <Alert variant="destructive">
            <AlertTitle>The locale settings didn’t load</AlertTitle>
            <AlertDescription>
              <p>{apiErrorMessage(config.error)}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void config.refetch()}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      ) : (
        <>
          {canEdit === false && (
            <div className="px-5">
              <Alert variant="warning">
                <AlertTitle>Read only</AlertTitle>
                <AlertDescription>
                  Changing locale settings is part of administering the space, so it takes the
                  space:admin permission. Ask a space administrator.
                </AlertDescription>
              </Alert>
            </div>
          )}
          <div aria-busy={cfg === undefined || undefined}>
            {cfg === undefined && <LoadingStatus>Loading the locale settings…</LoadingStatus>}
            <Table edge="card" stack="cards" caption="Locales">
              <TableHeader>
                <TableRow>
                  <TableHead>Locale</TableHead>
                  <TableHead className="w-32">Falls back to</TableHead>
                  <TableHead className="w-48">Delivered</TableHead>
                  <TableHead className="w-60">Direction</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cfg === undefined
                  ? [0, 1].map((i) => (
                      <TableRow key={i}>
                        <TableCell>
                          <SkeletonText width="4rem" />
                        </TableCell>
                        <TableCell label="Falls back to">
                          <SkeletonText width="3rem" />
                        </TableCell>
                        <TableCell label="Delivered">
                          <SkeletonPill className="h-5 w-11" />
                        </TableCell>
                        <TableCell label="Direction">
                          <SkeletonPill className="h-9 w-52" />
                        </TableCell>
                      </TableRow>
                    ))
                  : cfg.locales.map((locale) => (
                      <LocaleRow
                        key={locale}
                        id={`${id}-${locale}`}
                        cfg={cfg}
                        locale={locale}
                        disabled={canEdit !== true || saving !== null}
                        confirming={confirming === locale}
                        onAskOff={() => setConfirming(locale)}
                        onCancelOff={() => setConfirming(null)}
                        onSave={(change) => {
                          setConfirming(null);
                          void save(locale, change);
                        }}
                      />
                    ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </Section>
  );
}

function LocaleRow(props: {
  id: string;
  cfg: SpaceConfig;
  locale: string;
  disabled: boolean;
  confirming: boolean;
  onAskOff: () => void;
  onCancelOff: () => void;
  onSave: (change: LocaleChange) => void;
}) {
  const { cfg, locale, id } = props;
  const isDefault = locale === cfg.defaultLocale;
  const settings = cfg.localeSettings?.[locale];
  const delivered = isDefault || settings?.delivered !== false;
  const direction = settings?.direction ?? 'ltr';
  // A missing fallback ends the chain at the default locale; the default itself falls back to none.
  const fallback = isDefault ? null : (cfg.fallbacks?.[locale] ?? cfg.defaultLocale);
  return (
    <Fragment>
      <TableRow>
        <TableCell>
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="font-medium font-mono">{locale}</span>
            {isDefault && <Badge variant="outline">Default</Badge>}
          </span>
        </TableCell>
        <TableCell label="Falls back to" className="font-mono text-xs">
          {fallback ?? <span className="font-sans text-muted-foreground">None</span>}
        </TableCell>
        <TableCell label="Delivered">
          <span className="flex flex-col gap-1">
            <Switch
              checked={delivered}
              disabled={props.disabled || isDefault}
              aria-label={`Deliver ${locale}`}
              aria-describedby={isDefault ? `${id}-default` : undefined}
              onCheckedChange={(on) => (on ? props.onSave({ delivered: true }) : props.onAskOff())}
            />
            {isDefault && (
              <span id={`${id}-default`} className="text-2xs text-muted-foreground">
                Always delivered: every fallback ends here.
              </span>
            )}
          </span>
        </TableCell>
        <TableCell label="Direction">
          <Segmented
            aria-label={`Text direction of ${locale}`}
            value={direction}
            disabled={props.disabled}
            onValueChange={(v) => {
              if (v !== direction) props.onSave({ direction: v as TextDirection });
            }}
          >
            <SegmentedItem value="ltr">{DIRECTION_LABEL.ltr}</SegmentedItem>
            <SegmentedItem value="rtl">{DIRECTION_LABEL.rtl}</SegmentedItem>
          </Segmented>
        </TableCell>
      </TableRow>
      {props.confirming && (
        <TableRow>
          <TableCell colSpan={4}>
            <InlineConfirm
              message={`Stop delivering ${locale}?`}
              note="Delivery stops serving it in every environment at once: a request naming it is not found, fallbacks skip it and the sitemap leaves it out. Editors still write and preview it."
              cancelLabel="Keep delivering"
              onCancel={props.onCancelOff}
            >
              <Button type="button" size="sm" onClick={() => props.onSave({ delivered: false })}>
                Stop delivering
              </Button>
            </InlineConfirm>
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  );
}
