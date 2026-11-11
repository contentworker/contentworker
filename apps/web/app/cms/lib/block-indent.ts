/**
 * How far a block `depth` slots below its field's top level (0 for the field's own blocks) is
 * indented, in rem, wherever the admin draws a blocks tree (Layers, a drafted entry's blocks): a
 * full step (1rem) for each of the first two levels, then half a step, so a block six deep (the
 * deepest a slot goes) sits 3.5rem in and keeps its name readable in a phone's sheet.
 */
export function blockIndent(depth: number): number {
  const below = Math.max(0, depth);
  return Math.min(below, 2) + Math.max(0, below - 2) * 0.5;
}
