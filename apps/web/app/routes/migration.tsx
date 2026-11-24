import { CmsPage } from '~/cms/providers';
import { MigrationRunPage } from '~/cms/routes/MigrationRun';

export default function MigrationRoute() {
  return (
    <CmsPage title="Migration run">
      <MigrationRunPage />
    </CmsPage>
  );
}
