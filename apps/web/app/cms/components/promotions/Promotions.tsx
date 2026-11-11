import { useSearchParams } from 'react-router';
import type { Environment } from '../../lib/management';
import { PromotionList } from './PromotionList';
import { PromotionRequest } from './PromotionRequest';
import { PromotionSheet } from './PromotionSheet';

/** The search parameter that opens a promotion's record, so a link can point at one. */
const PARAM = 'promotion';

/**
 * Promotions, in Settings → Environments beside Compare & merge: request one, list them, and open
 * one's record (`?promotion=<id>`) to see why it waits and decide it. Everything goes through the
 * API's promotion routes; the screen only says what they answered.
 */
export function Promotions(props: { environments: readonly Environment[] }) {
  const [params, setParams] = useSearchParams();
  const openId = params.get(PARAM);
  const open = (id: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set(PARAM, id);
        else next.delete(PARAM);
        return next;
      },
      { preventScrollReset: true },
    );
  return (
    <>
      <PromotionRequest environments={props.environments} onOpen={open} />
      <PromotionList onOpen={open} />
      <PromotionSheet id={openId} onClose={() => open(null)} />
    </>
  );
}
