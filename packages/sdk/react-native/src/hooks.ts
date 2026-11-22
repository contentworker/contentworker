import type { Fields } from '@contentworker/sdk-core';
import { useCallback, useEffect, useState } from 'react';
import type { OfflineDelivery } from './offline.js';

export interface SyncState<F extends Fields> {
  readonly entries: import('@contentworker/sdk-core').DeliveredEntry<F>[];
  readonly syncing: boolean;
  readonly error?: Error;
  readonly sync: () => Promise<void>;
}

/**
 * Loads cached entries immediately (offline) and delta-syncs in the background.
 * Call `sync()` again on reconnect / foreground / pull-to-refresh.
 */
export function useOfflineEntries<F extends Fields = Fields>(
  store: OfflineDelivery<F>,
): SyncState<F> {
  type View = Omit<SyncState<F>, 'sync'> & { store: OfflineDelivery<F> };
  const [view, setView] = useState<View>({ store, entries: [], syncing: false });
  if (view.store !== store) setView({ store, entries: [], syncing: false });

  const update = useCallback(
    (patch: Partial<Omit<View, 'store'>>) => {
      setView((current) => (current.store === store ? { ...current, ...patch } : current));
    },
    [store],
  );

  const sync = useCallback(async () => {
    update({ syncing: true, error: undefined });
    try {
      await store.sync();
      update({ entries: await store.list(), syncing: false });
    } catch (err) {
      update({ error: err as Error, syncing: false });
    }
  }, [store, update]);

  useEffect(() => {
    let active = true;
    store.list().then(
      (entries) => {
        if (active) update({ entries });
      },
      (err) => {
        if (active) update({ error: err as Error });
      },
    );
    void sync();
    return () => {
      active = false;
    };
  }, [store, sync, update]);

  return { entries: view.entries, syncing: view.syncing, error: view.error, sync };
}
