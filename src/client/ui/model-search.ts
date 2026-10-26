// What the model picker shows and in which order: pure, so tests load it without a DOM.

import { availabilityWords, cannotRun, modelAvailability, type SubscriptionsState } from '../../shared/subscriptions';

/** One model in a picker, whatever list it came from. */
export interface PickerModel {
  id: string;
  /** Shown as is. A BYOK gateway prefix ("DroidProxy: ") is already dropped; a "Family: " prefix stays and is drawn muted. */
  name: string;
  /** The filter chip it sits under: "Yours", a provider ("Anthropic"), or "Legacy". */
  scope: string;
  /** The section it sits in. Your own models split by the gateway that serves them. */
  group: string;
  /** The word search also matches (the provider or gateway), shown after the name in a flat result. */
  provider?: string;
  /** Droid's credit multiplier. Missing for models on the owner's own key. */
  cost?: number;
  /** The gateway section uses the Factory pinwheel; model rows use their own brand. */
  glyph?: boolean;
  /** Small labels after the name: "20% off", "no images". */
  tags?: string[];
  /** One line in the footer while the row is under the cursor: the id, efforts it takes. */
  detail?: string;
  /** Marks a model that is listed but not offered: droid no longer lists it, or `reason` says it can't run. */
  unavailable?: boolean;
  /** Why an `unavailable` model can't run now ("Out of quota, back in 3 h (5-hour)"). Drawn dimmed beside it; with a reason, the picker won't pick it. */
  reason?: string;
  /** A quiet remark that doesn't stop anyone choosing it ("DroidProxy isn't running: the office starts it"). */
  note?: string;
}

/** Whether the picker may choose `m`: an unlisted model stays choosable (it may be the current pick); one with a reason doesn't. */
export function canPick(m: PickerModel | undefined): boolean {
  return !(m?.unavailable && m.reason);
}

/** What the office knows about whether `id` can run: a reason it can't, or a quiet note. Neither when it can, or nobody can tell. */
export function availabilityOf(id: string | undefined, s: SubscriptionsState, now: number): { reason?: string; note?: string } {
  const a = modelAvailability(s, id);
  const words = availabilityWords(a, now);
  if (!words) return {};
  return cannotRun(a) ? { reason: words } : { note: words };
}

/** `models` with the ones that can't run marked `unavailable` with their reason, and the quiet notes added. */
export function withAvailability(models: PickerModel[], s: SubscriptionsState, now: number): PickerModel[] {
  return models.map((m) => {
    const { reason, note } = availabilityOf(m.id, s, now);
    if (reason) return { ...m, unavailable: true, reason };
    return note ? { ...m, note } : m;
  });
}

/** The footer offers Subscriptions on a Mac that can have them when no provider has an account yet. */
export function offersSubscriptions(s: SubscriptionsState): boolean {
  return s.proxy.phase !== 'unsupported' && s.providers.every((p) => p.accounts.length === 0);
}

export interface Section {
  key: string;
  label: string;
  models: PickerModel[];
  /** Search results: each row names its section after the model. */
  flat?: boolean;
}

export interface Scope {
  key: string;
  count: number;
}

/** A credit multiplier as droid's picker says it: ×0.06, ×1.6, ×4. */
export function multiplierLabel(n: number): string {
  return `×${Number(n.toFixed(3))}`;
}

/** "GPT-6.1 Sol" and "gpt61sol" are the same word to a typist. */
export function squash(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** A hit at the start of the name beats one at the start of a later word, which beats one inside a word. */
function nameStartBonus(name: string, at: number): number {
  if (at === 0) return 6;
  return /[^\p{L}\p{N}]/u.test(name[at - 1]) ? 4 : 0;
}

/**
 * How well `m` answers `query`, or 0 when some word of it hits nothing. A word in the name beats one
 * in the id, provider or section; one that starts a word of the name beats one inside it.
 */
export function scoreModel(m: PickerModel, query: string): number {
  const want = words(query);
  if (!want.length) return 1;
  const name = m.name.toLowerCase();
  const squashed = squash(m.name);
  const elsewhere = `${m.id} ${m.provider ?? ''} ${m.group} ${m.scope}`.toLowerCase();
  let score = 0;
  for (const w of want) {
    const at = name.indexOf(w);
    if (at >= 0) score += 6 + nameStartBonus(name, at);
    else if (squash(w) && squashed.includes(squash(w))) score += 4;
    else if (elsewhere.includes(w)) score += 2;
    else if (squash(w) && squash(elsewhere).includes(squash(w))) score += 1;
    else return 0;
  }
  return score + (name === query.trim().toLowerCase() ? 20 : 0);
}

const SCOPE_RANK = new Map([
  ['Yours', -1],
  ['Other', 1],
  ['Legacy', 2],
  ['Not listed', 2],
]);

/** The filter chips: "Yours" first, then providers in the order the catalogue lists them, "Other" and "Legacy" last. */
export function scopesOf(models: PickerModel[]): Scope[] {
  const seen = new Map<string, number>();
  for (const m of models) seen.set(m.scope, (seen.get(m.scope) ?? 0) + 1);
  return [...seen].map(([key, count]) => ({ key, count })).sort((a, b) => (SCOPE_RANK.get(a.key) ?? 0) - (SCOPE_RANK.get(b.key) ?? 0));
}

/**
 * The rows to draw. With a query: every match in one flat list, best first. Without one: the last
 * models picked on top (when `recents` names any still listed), then the sections in catalogue order.
 */
export function sectionsFor(models: PickerModel[], opts: { query: string; scope: string; recents: string[] }): Section[] {
  const inScope = opts.scope ? models.filter((m) => m.scope === opts.scope) : models;
  if (opts.query.trim()) {
    const hits = inScope
      .map((m, i) => ({ m, i, score: scoreModel(m, opts.query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((x) => x.m);
    return hits.length ? [{ key: 'matches', label: `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`, models: hits, flat: true }] : [];
  }
  const out: Section[] = [];
  const recent = opts.scope ? [] : opts.recents.flatMap((id) => models.find((m) => m.id === id && !m.unavailable) ?? []);
  if (recent.length) out.push({ key: 'recent', label: 'Recent', models: recent });
  for (const m of inScope) {
    let s = out.find((x) => x.key === `g:${m.group}`);
    if (!s) out.push((s = { key: `g:${m.group}`, label: m.group, models: [] }));
    s.models.push(m);
  }
  // Your own gateways come first, the biggest on top: the one with most of your models is the one you reach for.
  const yours = (s: Section) => s.models[0]?.scope === 'Yours';
  const rest = out.filter((s) => s.key !== 'recent');
  return [...out.filter((s) => s.key === 'recent'), ...rest.filter(yours).sort((a, b) => b.models.length - a.models.length), ...rest.filter((s) => !yours(s))];
}

/** Where `query` sits in `text` (case-insensitive), for drawing a highlight; one range per word, merged. */
export function highlightRanges(text: string, query: string): [number, number][] {
  const lower = text.toLowerCase();
  const found: [number, number][] = [];
  for (const w of words(query)) {
    const at = lower.indexOf(w);
    if (at >= 0) found.push([at, at + w.length]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** Splits a "Family: Model" name at its first colon, so the family can be drawn muted. */
export function splitFamily(name: string): { family?: string; rest: string } {
  const at = name.indexOf(': ');
  return at > 0 && at < 24 ? { family: name.slice(0, at), rest: name.slice(at + 2) } : { rest: name };
}

/** The last picks, newest first, with `id` moved to the front and the list kept to `max`. */
export function pushRecent(recents: string[], id: string, max = 4): string[] {
  return [id, ...recents.filter((r) => r !== id)].slice(0, max);
}
