/**
 * Cards a column shows: any of the picked labels, and every word of the title query (any order, any case),
 * then at most `max`. A blank query matches every title.
 */
export function columnCards<T extends { title: string; labels: { name: string }[] }>(items: T[], picked: string[], query: string, max?: number): T[] {
  const labelled = picked.length ? items.filter((it) => it.labels.some((l) => picked.includes(l.name))) : items;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matching = words.length ? labelled.filter((it) => words.every((w) => it.title.toLowerCase().includes(w))) : labelled;
  return matching.slice(0, max);
}
