import { MediaLibrary } from '~/cms/components/MediaLibrary';
import { useClient } from '~/cms/lib/client-context';
import { CmsPage } from '~/cms/providers';

function Media() {
  const { conn } = useClient();
  return <MediaLibrary locale={conn.locale} />;
}

export default function MediaRoute() {
  return (
    <CmsPage title="Media">
      <Media />
    </CmsPage>
  );
}
