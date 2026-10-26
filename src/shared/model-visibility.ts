/** Hidden choices stay in the catalogue for names and existing selections, never in picker results. */
export function visibleModels<T extends { id: string }>(models: T[], hidden: readonly string[]): T[] {
  const ids = new Set(hidden);
  return models.filter((model) => !ids.has(model.id));
}

/**
 * The models a settings allowlist offers: the visible ones, plus one already picked that has
 * since been hidden, so it stays on the list to be unticked instead of being kept silently.
 */
export function offeredModels<T extends { id: string }>(models: T[], hidden: readonly string[], picked: ReadonlySet<string>): T[] {
  const ids = new Set(hidden);
  return models.filter((model) => !ids.has(model.id) || picked.has(model.id));
}
