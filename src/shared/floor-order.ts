/** Move one floor in the current numbered order, without replacing concurrent changes to other floors. */
export function moveFloor<T extends { id: string }>(floors: readonly T[], floor: string, before: string | null): T[] | undefined {
  const moving = floors.find((f) => f.id === floor);
  if (!moving || (before !== null && !floors.some((f) => f.id === before))) return undefined;
  if (floor === before) return [...floors];
  const rest = floors.filter((f) => f.id !== floor);
  rest.splice(before === null ? rest.length : rest.findIndex((f) => f.id === before), 0, moving);
  return rest;
}
