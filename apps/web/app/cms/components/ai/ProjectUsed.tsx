import type { AiProjectUse } from '@contentworker/domain';
import { leftOutWords, provenanceLine, useAiProjects } from '../../lib/ai-projects';
import { Task, TaskItem } from './Task';

const count = new Intl.NumberFormat('en-US');

/**
 * What a call that took an AI project used, from its answer's `project`: one quiet line ("Used
 * project: Brand voice · 2 references (1 left out: you can't read it)") that opens to each
 * reference, used and how much, or left out and why. A reference is named by its place in the
 * project only, never by title, so one the person can't read gives nothing away. Nothing when the
 * call took no project.
 */
export function ProjectUsed(props: { use: AiProjectUse | null | undefined; className?: string }) {
  const projects = useAiProjects(Boolean(props.use)).data;
  const { use } = props;
  if (!use) return null;
  const name = projects?.find((p) => p.id === use.id)?.name;
  return (
    <Task title={provenanceLine(use, name)} className={props.className}>
      <TaskItem>
        {name ? `“${name}”` : 'The project'}
        {use.version ? ` at version ${use.version}` : ''}: its instructions and personas, under the
        space’s own guidance
      </TaskItem>
      {use.references.map((r, i) => (
        <TaskItem key={`${r.assetId}:${i}`}>
          Reference {i + 1}
          {r.used
            ? r.ranges?.length
              ? `: used, ${count.format(
                  r.ranges.reduce((n, [a, b]) => n + (b - a), 0),
                )} characters of file version ${r.version}`
              : r.version
                ? `: used (file version ${r.version})`
                : ': used'
            : `: left out, ${leftOutWords(r.reason)}`}
        </TaskItem>
      ))}
    </Task>
  );
}
