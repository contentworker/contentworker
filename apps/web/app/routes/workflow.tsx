import { CmsPage } from '~/cms/providers';
import { WorkflowEditor } from '~/cms/routes/WorkflowEditor';
import '@xyflow/react/dist/style.css';

/** One workflow's graph editor (React Flow loads with this route only). */
export default function WorkflowRoute() {
  return (
    <CmsPage title="Workflow">
      <WorkflowEditor />
    </CmsPage>
  );
}
