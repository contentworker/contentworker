import { CmsPage } from '~/cms/providers';
import { Blocks } from '~/cms/routes/Blocks';

export default function BlocksRoute() {
  return (
    <CmsPage title="Blocks">
      <Blocks />
    </CmsPage>
  );
}
