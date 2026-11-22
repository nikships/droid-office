/** Whether a model is hidden individually or by the office's Hide native Factory models setting. */
export function isModelHidden(model: { id: string; custom?: boolean }, hidden: readonly string[], hideNative = false): boolean {
  return (hideNative && !model.custom) || hidden.includes(model.id);
}

/** Hidden choices stay in the catalogue for names and existing selections, never in picker results. */
export function visibleModels<T extends { id: string; custom?: boolean }>(models: T[], hidden: readonly string[], hideNative = false): T[] {
  const ids = new Set(hidden);
  return models.filter((model) => (!hideNative || model.custom === true) && !ids.has(model.id));
}

/**
 * The models a settings allowlist offers: the visible ones, plus one already picked that has
 * since been hidden, so it stays on the list to be unticked instead of being kept silently.
 */
export function offeredModels<T extends { id: string; custom?: boolean }>(models: T[], hidden: readonly string[], picked: ReadonlySet<string>, hideNative = false): T[] {
  const ids = new Set(hidden);
  return models.filter((model) => ((!hideNative || model.custom === true) && !ids.has(model.id)) || picked.has(model.id));
}

/** How many models currently in the catalogue are hidden, ignoring stale ids that no longer exist. */
export function countHiddenModels(models: readonly { id: string; custom?: boolean }[], hidden: readonly string[], hideNative = false): number {
  const ids = new Set(hidden);
  let count = 0;
  for (const model of models) if ((hideNative && !model.custom) || ids.has(model.id)) count++;
  return count;
}
