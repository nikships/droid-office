/**
 * The management tools the native host serves (Byte's sealed DOM tools), by id, with the label the
 * rail shows. Spatial-only tools are not here. Which ones a floor offers is the host's call: a tool
 * the floor can't use explains why inside the tool itself.
 */
export const MANAGEMENT_TOOLS: readonly { id: string; label: string; plain?: false }[] = [
  { id: 'issues', label: 'Issues', plain: false },
  { id: 'pulls', label: 'Pull requests', plain: false },
  { id: 'jira', label: 'Jira' },
  { id: 'pipelines', label: 'Pipelines', plain: false },
  { id: 'ci', label: 'Factory CI', plain: false },
  { id: 'changes', label: 'Changes' },
  { id: 'docs', label: 'Docs' },
  { id: 'wiki', label: 'Wiki' },
  { id: 'computers', label: 'Computers' },
  { id: 'environments', label: 'Environments' },
  { id: 'cloud', label: 'Cloud workers' },
  { id: 'whiteboard', label: 'Whiteboard' },
  { id: 'search', label: 'Search' },
  { id: 'floors', label: 'Floors' },
  { id: 'settings', label: 'Settings' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'host-update', label: 'Host update' },
  { id: 'upgrade', label: 'Upgrade' },
  { id: 'welcome', label: 'Setup' },
];

/** Tools that need a git checkout of the floor's own: hidden on a plain folder. */
export function toolsFor(plainFloor: boolean): typeof MANAGEMENT_TOOLS {
  return MANAGEMENT_TOOLS.filter((t) => !(plainFloor && t.plain === false));
}
