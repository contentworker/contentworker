import { CmsPage } from '~/cms/providers';
import { Migrations } from '~/cms/routes/Migrations';

export default function MigrationsRoute() {
  return (
    <CmsPage title="Migrations">
      <Migrations />
    </CmsPage>
  );
}
