/** Hidden choices stay in the catalogue for names and existing selections, never in picker results. */
export function visibleModels<T extends { id: string }>(models: T[], hidden: readonly string[]): T[] {
  const ids = new Set(hidden);
  return models.filter((model) => !ids.has(model.id));
}
