import { CmsPage } from '~/cms/providers';
import { MigrationTemplatePage } from '~/cms/routes/MigrationTemplate';

export default function MigrationTemplateRoute() {
  return (
    <CmsPage title="Migration template">
      <MigrationTemplatePage />
    </CmsPage>
  );
}
