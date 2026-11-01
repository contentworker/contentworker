import { redirect } from 'react-router';
import { requireUser } from '~/lib/auth.server';
import type { Route } from './+types/home';

/** Signed in, `/` is the overview; signed out, `requireUser` sends the browser to sign in. */
export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  throw redirect('/dashboard');
}

export default function Home() {
  return null;
}
