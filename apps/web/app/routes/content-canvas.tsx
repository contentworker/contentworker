import { CmsPage } from '~/cms/providers';
import { CanvasSkeleton, EntryCanvas } from '~/cms/routes/EntryCanvas';

/** An entry's canvas: its page laid out on the customer's frontend, full-bleed. */
export default function ContentCanvasRoute() {
  return (
    <CmsPage title="Canvas" bare skeleton={<CanvasSkeleton />}>
      <EntryCanvas />
    </CmsPage>
  );
}
