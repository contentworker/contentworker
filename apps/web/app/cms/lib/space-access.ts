import { useClient } from './client-context';
import { useScopedQuery } from './queries';

/**
 * The scopes the person's role holds in the current space, as `GET /spaces/:space/auth/me` reports
 * them (stored as granted: read them with `holdsScope`, which knows what each implies), or
 * undefined until known. One cached read, shared with every screen that asks.
 */
export function useSpaceScopes(enabled = true): readonly string[] | undefined {
  const { client } = useClient();
  return useScopedQuery(['space-access'], () => client.getSpaceAccess(), { silent: true, enabled })
    .data?.scopes;
}
