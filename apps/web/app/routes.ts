import { index, layout, type RouteConfig, route } from '@react-router/dev/routes';

export default [
  route('login', 'routes/login.tsx'),
  route('login/two-factor', 'routes/login-two-factor.tsx'),
  route('login/passkey', 'routes/login-passkey.ts'),
  // Single sign-on with the deployment's identity provider (lib/sso.server.ts).
  route('login/sso', 'routes/login-sso.ts'),
  route('login/sso/callback', 'routes/login-sso-callback.ts'),
  route('login/sso/link', 'routes/login-sso-link.tsx'),
  route('logout', 'routes/logout.tsx'),
  // A new deployment's first admin, from its one-time setup code (lib/setup.server.ts).
  route('setup', 'routes/setup.tsx'),
  layout('routes/shell.tsx', [
    // An error boundary inside the shell, so a refused or missing page keeps the app around it.
    layout('routes/in-app.tsx', [
      // Signed in, `/` is the dashboard.
      index('routes/home.tsx'),
      route('dashboard', 'routes/dashboard.tsx'),
      // The CMS screens (app/cms, ported from the Vite admin). Each runs on TanStack Query in the
      // browser, scoped to the space / environment / locale chosen in the header.
      route('content', 'routes/content.tsx', { id: 'content-layout' }, [
        index('routes/content-types.tsx', { id: 'content' }),
        route(':typeId', 'routes/content-entries.tsx', { id: 'content-type' }),
        route(':typeId/new', 'routes/content-entry.tsx', { id: 'content-new' }),
        route(':typeId/import', 'routes/content-import.tsx', { id: 'content-import' }),
        route(':typeId/:entryId', 'routes/content-entry.tsx', { id: 'content-entry' }),
      ]),
      route('approvals', 'routes/approvals.tsx', { id: 'approvals' }),
      route('releases', 'routes/releases.tsx', { id: 'releases' }),
      route('workflows', 'routes/workflows.tsx', { id: 'workflows' }),
      route('workflows/:id', 'routes/workflow.tsx', { id: 'workflow' }),
      route('taxonomy', 'routes/taxonomy.tsx', { id: 'taxonomy' }),
      route('assets', 'routes/assets.tsx', { id: 'assets' }),
      // The screen's old address: bookmarks and links keep working.
      route('media', 'routes/media-redirect.ts'),
      route('settings/:section?', 'routes/settings.tsx', { id: 'settings' }),
      // The deployment's people, single sign-on and SCIM (admins).
      route('team', 'routes/team.tsx'),
      route('audit', 'routes/audit.tsx'),
      route('account', 'routes/account.tsx'),
    ]),
  ]),
  route('account/passkeys', 'routes/account-passkeys.ts'),
] satisfies RouteConfig;
