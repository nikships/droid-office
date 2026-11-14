import type { WorkerInfo } from '../../shared/protocol';
import { intralineDiffSpans, threadDeliverable, type ThreadDiffLine, type ThreadDiffSpan, type ThreadFileChange } from '../../shared/thread-diff';
import {
  activityState,
  threadArgumentsText,
  threadOutputText,
  type ActionKind,
  type ActivityState,
  type ThreadBlock,
  type ThreadDelegationMeta,
  type ThreadModelAction,
  type ThreadToolGroup,
  type ThreadTurnChanges,
} from '../../shared/thread-presentation';
import type { ThreadEntry } from '../../shared/worker-thread';
import { attachCopyFeedback, highlightLine, MAX_HIGHLIGHT_CHARS, renderCodeFrame, resolveCodeLanguage, syncHorizontalScrollCue, tokenizeCode, type CodeToken } from './code-highlight';
import { h } from './dom';
import { icon } from './icons';
import type { WorkspacePathRef } from './thread-markdown';

// V3 Thread presentation builders and pure helpers for compact 1-level exploration disclosures,
// File Change cards (unified + intraline + Lezer syntax diffs), Command cards, and Delegation cards.
// Free of window/document globals at import time so Node unit tests import pure helpers directly.

export const DIFF_CLAMP_LINES = 80;

const HUNK_LINE_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

const EXPLORE_COUNTS: Record<ActionKind, [string, string]> = {
  read: ['Read a file', 'Read %d files'],
  list: ['Listed a folder', 'Listed %d folders'],
  search: ['Searched the code', 'Searched %d times'],
  command: ['Ran a command', 'Ran %d commands'],
  edit: ['Edited a file', 'Edited %d files'],
  create: ['Created a file', 'Created %d files'],
  web: ['Read a web page', 'Read %d web pages'],
  webSearch: ['Searched the web', 'Searched the web %d times'],
  delegate: ['Ran a subagent', 'Ran %d subagents'],
  skill: ['Used a skill', 'Used %d skills'],
  ask: ['Asked you a question', 'Asked you %d questions'],
  memory: ['Checked memory', 'Used memory %d times'],
  script: ['Ran a script', 'Ran %d scripts'],
  plan: ['Updated the plan', 'Updated the plan %d times'],
  taskStop: ['Stopped a background task', 'Stopped %d background tasks'],
  loopCreate: ['Scheduled a loop', 'Scheduled %d loops'],
  loopList: ['Checked scheduled loops', 'Checked scheduled loops %d times'],
  loopPause: ['Paused a loop', 'Paused %d loops'],
  loopResume: ['Resumed a loop', 'Resumed %d loops'],
  loopCancel: ['Cancelled a loop', 'Cancelled %d loops'],
  other: ['Used a tool', 'Used %d tools'],
};

export interface MergedDiffSegment {
  text: string;
  cls: string;
  changed: boolean;
}

export interface ThreadCardRenderContext {
  owner: WorkerInfo;
  floorDir?: string;
  userToggles: Map<string, boolean>;
  expandedDiffs: Set<string>;
  onOpenPath?: (ref: WorkspacePathRef) => void;
  team?: readonly WorkerInfo[];
  openWorker?: (id: string) => void;
  pictures: (entry: ThreadEntry | undefined, title: string, about?: string, owner?: WorkerInfo) => HTMLElement | null;
  onLayoutChange?: () => void;
  /** Opens the worker's Changes window. */
  openChanges?: () => void;
  /** Puts a workspace file on the floor's Whiteboard as a card. */
  sendToWhiteboard?: (path: string) => void;
}

/** Sets `details.open` while marking `data-expected-open` so programmatic renders never masquerade as user toggles. */
export function setDisclosureOpen<T extends HTMLDetailsElement>(details: T, open: boolean): T {
  details.dataset.expectedOpen = String(open);
  details.open = open;
  return details;
}

/** Converts a relative or worktree/floor-checkout path into a clean workspace-relative path for `/api/thread/file`, or `null` when outside the workspace. */
export function toWorkspaceRelPath(rawPath: string, floorDir?: string): string | null {
  const norm = rawPath.trim().replace(/\\/g, '/');
  if (!norm) return null;

  let candidate = norm;
  const wtMatch = /^.*?\/\.droid-office\/worktrees\/[^/]+\/(.+)$/.exec(norm);
  if (wtMatch) {
    candidate = wtMatch[1];
  } else if (norm.startsWith('/')) {
    const cleanFloor = floorDir?.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (cleanFloor && norm.startsWith(`${cleanFloor}/`)) {
      candidate = norm.slice(cleanFloor.length + 1);
    } else {
      return null;
    }
  }

  const rel = candidate.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!rel || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null;
  if (/(^|\/)\.\.(\/|$)/.test(rel) || /(^|\/)\.(git|droid-office)(\/|$)/.test(rel)) return null;
  return rel;
}

/** Finds the target line (`newLine ?? oldLine`) at the start of the first hunk in a `ThreadFileChange`. */
export function firstDiffTargetLine(change: ThreadFileChange): number | undefined {
  for (const line of change.lines) {
    if (line.newLine !== undefined) return line.newLine;
    if (line.oldLine !== undefined) return line.oldLine;
  }
  for (const line of change.lines) {
    if (line.kind !== 'hunk') continue;
    const m = HUNK_LINE_RE.exec(line.text);
    if (!m) continue;
    const newL = Number(m[2]);
    const oldL = Number(m[1]);
    if (newL > 0) return newL;
    if (oldL > 0) return oldL;
  }
  return undefined;
}

/** Pairs contiguous `del` + `add` runs within `lines` and computes `intralineDiffSpans` for changed line pairs. */
export function pairIntralineSpans(lines: readonly ThreadDiffLine[]): Map<number, ThreadDiffSpan[]> {
  const out = new Map<number, ThreadDiffSpan[]>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== 'del') {
      i++;
      continue;
    }
    let delEnd = i;
    while (delEnd < lines.length && lines[delEnd].kind === 'del') delEnd++;
    let addEnd = delEnd;
    while (addEnd < lines.length && lines[addEnd].kind === 'add') addEnd++;

    const pairs = Math.min(delEnd - i, addEnd - delEnd);
    for (let k = 0; k < pairs; k++) {
      const delLine = lines[i + k];
      const addLine = lines[delEnd + k];
      const { del, add } = intralineDiffSpans(delLine.text, addLine.text);
      if (del.some((s) => s.changed)) out.set(i + k, del);
      if (add.some((s) => s.changed)) out.set(delEnd + k, add);
    }
    i = Math.max(delEnd, addEnd);
  }
  return out;
}

/** Intersects Lezer syntax tokens and intraline diff spans over the same line string without losing characters. */
export function mergeSyntaxAndDiffSpans(tokens: readonly CodeToken[], spans: readonly ThreadDiffSpan[]): MergedDiffSegment[] {
  const spanText = spans.map((s) => s.text).join('');
  if (!spanText) return [];
  const tokText = tokens.map((t) => t.text).join('');
  if (!tokens.length || tokText !== spanText) {
    return spans.filter((s) => s.text.length > 0).map((s) => ({ text: s.text, cls: '', changed: Boolean(s.changed) }));
  }

  const out: MergedDiffSegment[] = [];
  let ti = 0;
  let toff = 0;
  let si = 0;
  let soff = 0;

  while (ti < tokens.length && si < spans.length) {
    const tok = tokens[ti];
    const sp = spans[si];
    const trem = tok.text.length - toff;
    const srem = sp.text.length - soff;
    if (trem <= 0) {
      ti++;
      toff = 0;
      continue;
    }
    if (srem <= 0) {
      si++;
      soff = 0;
      continue;
    }
    const step = Math.min(trem, srem);
    const slice = sp.text.slice(soff, soff + step);
    const cls = tok.cls.trim();
    const changed = Boolean(sp.changed);
    const prev = out[out.length - 1];
    if (prev && prev.cls === cls && prev.changed === changed) {
      prev.text += slice;
    } else if (slice) {
      out.push({ text: slice, cls, changed });
    }
    toff += step;
    soff += step;
  }

  return out;
}

/** Resolves a delegation card's subagent worker id against `team` by `workerId` or case-insensitive `workerName`. */
export function resolveDelegatedWorkerId(delegation: ThreadDelegationMeta | undefined, leadId: string, team: readonly WorkerInfo[] | undefined): string | undefined {
  if (!delegation || !team?.length) return undefined;
  if (delegation.workerId) {
    const exact = team.find((w) => w.id === delegation.workerId);
    if (exact) return exact.id;
    if (delegation.workerId.length >= 4) {
      const prefix = team.find((w) => w.id.startsWith(delegation.workerId!));
      if (prefix) return prefix.id;
    }
  }
  if (delegation.workerName) {
    const lower = delegation.workerName.trim().toLowerCase();
    if (lower) {
      const owned = team.find((w) => w.lead === leadId && w.name.toLowerCase() === lower);
      if (owned) return owned.id;
      const anyMatch = team.find((w) => w.name.toLowerCase() === lower);
      if (anyMatch) return anyMatch.id;
    }
  }
  return undefined;
}

function aggregateExploreActionsLabel(actions: readonly ThreadModelAction[]): string {
  const counted = actions.filter((a) => !a.causedBy && !(a.state === 'failed' && (a.category === 'plan' || a.category === 'skill')));
  if (!counted.length && actions.length) return (actions.find((a) => !a.causedBy) ?? actions[0]).title;

  const kinds = new Map<ActionKind, number>();
  for (const action of counted) {
    kinds.set(action.category, (kinds.get(action.category) ?? 0) + 1);
  }
  const entries = [...kinds.entries()];
  const parts = entries.slice(0, 3).map(([kind, count]) => {
    const pair = EXPLORE_COUNTS[kind] ?? EXPLORE_COUNTS.other;
    return count === 1 ? pair[0] : pair[1].replace('%d', String(count));
  });
  const folded = new Set(entries.slice(3).map(([kind]) => kind));
  const more = counted.filter((a) => folded.has(a.category)).length;
  if (more) parts.push(`${more} more`);
  return parts.join(' · ') || 'Thought';
}

/** Builds the combined summary metadata for a consecutive run of non-card `thought` and `tools` blocks. */
export function summarizeExplorationBlocks(blocks: readonly ThreadBlock[], rowLive: boolean): { label: string; state: ActivityState; live: boolean; status: string } {
  const live = rowLive && blocks.some((b) => b.live);
  const toolBlocks = blocks.filter((b): b is Extract<ThreadBlock, { kind: 'tools' }> => b.kind === 'tools');
  if (!toolBlocks.length) {
    const lastThought = blocks[blocks.length - 1] as Extract<ThreadBlock, { kind: 'thought' }>;
    return {
      label: `Thought · ${lastThought.preview}`,
      state: live ? 'working' : 'complete',
      live,
      status: '',
    };
  }

  const allActions = toolBlocks.flatMap((b) => b.actions);
  const label = toolBlocks.length === 1 ? toolBlocks[0].label : toolBlocks.every((b) => b.label === 'Earlier tools') ? 'Earlier tools' : aggregateExploreActionsLabel(allActions);

  const cancelled = allActions.filter((a) => a.state === 'cancelled' && !a.causedBy).length;
  const noResult = allActions.filter((a) => a.state === 'incomplete').length;
  const status = [cancelled ? `${cancelled} cancelled` : '', noResult ? `${noResult} no result` : ''].filter(Boolean).join(' · ');

  return {
    label,
    state: activityState(allActions, live),
    live,
    status,
  };
}

// ------------------------------------------------------------------------------------------------
// DOM Builders (called only inside browser / test DOM contexts, never at module load)

function chevronNode(): HTMLElement {
  return h('span.wt-chevron', { 'aria-hidden': true }, icon('chevron', 14));
}

function cardStatePill(state: ActivityState, includeDone = false): HTMLElement | null {
  if (state === 'working') return h('span.pill.working.wt-card-pill', {}, 'Running');
  if (state === 'failed') return h('span.pill.bad.wt-card-pill', {}, 'Failed');
  if (state === 'cancelled') return h('span.pill.wt-card-pill', {}, 'Cancelled');
  if (state === 'incomplete') return h('span.pill.wt-card-pill', {}, 'No result');
  if (includeDone && state === 'complete') return h('span.pill.done.wt-card-pill', {}, 'Done');
  return null;
}

export function renderToolCodeSection(code: string, opts: { lang?: string; copyLabel?: string; isOutput?: boolean }): HTMLElement {
  const frame = renderCodeFrame(code, { lang: opts.lang, copyLabel: opts.copyLabel });
  frame.classList.add('wt-tool-frame');
  if (opts.isOutput) {
    frame.querySelector('pre')?.classList.add('wt-output');
  }
  return frame;
}

/** Renders a single-click exploration tool disclosure (`details.wt-tool`). */
export function renderToolDisclosure(item: ThreadModelAction, entry: ThreadEntry | undefined, owner: WorkerInfo, pictures: ThreadCardRenderContext['pictures'], userToggles: ReadonlyMap<string, boolean>): HTMLDetailsElement {
  const images = entry ? pictures(entry, item.title, item.detail, owner) : null;
  const output = entry && images ? threadOutputText(entry) : entry?.output;
  const argText = entry && item.arguments ? threadArgumentsText(entry.input, item.arguments) : '';
  const argLang = item.arguments?.field === 'command' ? 'sh' : item.arguments?.field === 'patch' || item.arguments?.field === 'input' ? 'diff' : item.detail;

  const details = h(
    'details.wt-tool',
    {
      class: item.state === 'complete' || item.state === 'failed' ? 'done' : 'pending',
      'data-disclosure': item.id,
    },
    h('summary', {}, h('span.wt-tool-main', {}, h('span.wt-tool-title', {}, item.title), item.detail ? h('span.wt-tool-detail', { title: item.detail }, item.detail) : null), h('span.wt-tool-state', {}, item.status), chevronNode()),
    h(
      'div.wt-tool-body',
      {},
      ...(entry
        ? [
            item.arguments ? h('div.wt-detail-label', {}, item.arguments.label) : null,
            item.arguments ? renderToolCodeSection(argText, { lang: argLang, copyLabel: `Copy ${item.arguments.label.toLowerCase()}` }) : null,
            output || !images ? h('div.wt-detail-label', {}, item.result) : null,
            output ? renderToolCodeSection(output, { lang: 'txt', copyLabel: 'Copy output', isOutput: true }) : !images ? h('pre.wt-code.wt-output', {}, 'No result recorded in this session.') : null,
            images,
          ]
        : [h('p.wt-detail-missing', {}, 'Load earlier messages to see what this call was given and returned.')]),
    ),
  );
  return setDisclosureOpen(details, userToggles.get(item.id) ?? item.open);
}

function renderMergedSegments(segments: readonly MergedDiffSegment[], wordCls: 'wt-diff-word-add' | 'wt-diff-word-del'): (string | HTMLElement)[] {
  return segments.map((seg) => {
    if (!seg.changed && !seg.cls) return seg.text;
    const classes: string[] = [];
    if (seg.changed) classes.push('wt-diff-word', wordCls);
    if (seg.cls) classes.push(...seg.cls.split(/\s+/).filter(Boolean));
    return h(`span.${classes.join('.')}` as `span.${string}`, {}, seg.text);
  });
}

function renderDiffLineCode(line: ThreadDiffLine, filePath: string, intraline: readonly ThreadDiffSpan[] | undefined): DocumentFragment | HTMLElement | string {
  if (!line.text) return '\u200b';
  if (!intraline || (line.kind !== 'add' && line.kind !== 'del')) {
    return highlightLine(line.text, filePath);
  }

  const wordCls = line.kind === 'add' ? 'wt-diff-word-add' : 'wt-diff-word-del';
  const initial = renderMergedSegments(mergeSyntaxAndDiffSpans([], intraline), wordCls);
  const holder = h('span.wt-hl-line', {}, ...initial);

  if (line.text.length <= MAX_HIGHLIGHT_CHARS && resolveCodeLanguage(filePath)) {
    void tokenizeCode(line.text, filePath).then((tokens) => {
      if (!holder.isConnected || !tokens.some((t) => t.cls)) return;
      holder.replaceChildren(...renderMergedSegments(mergeSyntaxAndDiffSpans(tokens, intraline), wordCls));
    });
  }
  return holder;
}

function buildDiffRows(lines: readonly ThreadDiffLine[], limit: number, filePath: string, pairedMap: ReadonlyMap<number, ThreadDiffSpan[]>): HTMLElement[] {
  const rows: HTMLElement[] = [];
  const end = Math.min(lines.length, limit);
  for (let idx = 0; idx < end; idx++) {
    const line = lines[idx];
    if (line.kind === 'hunk') {
      rows.push(h('tr.wt-diff-row.is-hunk', {}, h('td.wt-diff-num.is-hunk-gutter', { colspan: 2, 'aria-hidden': 'true' }, '@@'), h('td.wt-diff-code.is-hunk-code', { colspan: 2 }, line.text)));
      continue;
    }
    if (line.kind === 'note') {
      rows.push(h('tr.wt-diff-row.is-note', {}, h('td.wt-diff-num', { colspan: 2, 'aria-hidden': 'true' }, ''), h('td.wt-diff-code.is-note-code', { colspan: 2 }, line.text)));
      continue;
    }
    const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
    const codeContent = renderDiffLineCode(line, filePath, pairedMap.get(idx));
    rows.push(
      h(
        `tr.wt-diff-row.is-${line.kind}` as `tr.${string}`,
        {},
        h('td.wt-diff-num.is-old', { 'aria-hidden': 'true' }, line.oldLine !== undefined ? String(line.oldLine) : ''),
        h('td.wt-diff-num.is-new', { 'aria-hidden': 'true' }, line.newLine !== undefined ? String(line.newLine) : ''),
        h('td.wt-diff-sign', { 'aria-hidden': 'true' }, sign),
        h('td.wt-diff-code', {}, codeContent),
      ),
    );
  }
  return rows;
}

/** Renders a first-class File Change card (`.wt-card.wt-change-card`). */
export function renderFileChangeCard(action: ThreadModelAction, entry: ThreadEntry | undefined, ctx: ThreadCardRenderContext): HTMLElement {
  if (!action.changes?.length) {
    return h('div.wt-card.wt-change-card', {}, renderToolDisclosure(action, entry, ctx.owner, ctx.pictures, ctx.userToggles));
  }

  const fileSections = action.changes.map((change) => {
    const disclosureKey = `change:${action.id}:${change.path}`;
    const diffKey = `${action.id}:${change.path}`;
    const defaultOpen = change.open ?? !change.generated;
    const isOpen = ctx.userToggles.get(disclosureKey) ?? defaultOpen;

    const relPath = ctx.onOpenPath ? toWorkspaceRelPath(change.path, ctx.floorDir) : null;
    const targetLine = firstDiffTargetLine(change);
    const pathEl =
      relPath && ctx.onOpenPath
        ? h(
            'button.wt-change-path.wt-file-link',
            {
              type: 'button',
              title: change.path,
              onclick: (event: Event) => {
                event.preventDefault();
                event.stopPropagation();
                ctx.onOpenPath?.({ path: relPath, ...(targetLine !== undefined ? { line: targetLine } : {}) });
              },
            },
            change.shortPath,
          )
        : h('span.wt-change-path', { title: change.path }, change.shortPath);

    const kindBadge = change.kind === 'added' ? h('span.wt-change-kind.is-added', {}, 'Added') : change.kind === 'deleted' ? h('span.wt-change-kind.is-deleted', {}, 'Deleted') : null;
    const genBadge = change.generated ? h('span.wt-change-gen', {}, 'Generated') : null;
    const stats = h('span.wt-diff-stats', { 'aria-label': `${change.additions} additions, ${change.deletions} deletions` }, h('span.wt-diff-add', {}, `+${change.additions}`), h('span.wt-diff-del', {}, `-${change.deletions}`));
    const statePill = action.changes!.length === 1 ? cardStatePill(action.state) : null;

    const summary = h('summary.wt-change-summary', {}, h('span.wt-change-head-main', {}, pathEl, kindBadge, genBadge), stats, statePill, chevronNode());

    const bodyChildren: HTMLElement[] = [];
    if (change.lines.length > 0) {
      const pairedMap = pairIntralineSpans(change.lines);
      const tbody = h('tbody');
      const renderRows = () => {
        const expanded = ctx.expandedDiffs.has(diffKey);
        const limit = expanded ? change.lines.length : DIFF_CLAMP_LINES;
        tbody.replaceChildren(...buildDiffRows(change.lines, limit, change.path, pairedMap));
      };
      renderRows();

      // Snippets that couldn't be placed in the file show no gutter rather than made-up numbers.
      const numbered = change.lines.some((l) => l.oldLine !== undefined || l.newLine !== undefined);
      const table = h('table.wt-diff-table', { class: numbered ? '' : 'is-unnumbered' }, tbody);
      const scroller = h('div.wt-diff-scroll.wt-horizontal-content', { tabindex: 0, 'aria-label': `Diff for ${change.shortPath}, scroll horizontally` }, table);
      const cue = h('span.wt-code-cue', { hidden: true }, 'Scroll horizontally ↔');
      const scrollWrap = h('div.wt-code-scroll', {}, scroller, cue);
      scroller.addEventListener('scroll', () => syncHorizontalScrollCue(scrollWrap));
      bodyChildren.push(scrollWrap);

      if (change.lines.length > DIFF_CLAMP_LINES) {
        const hiddenCount = change.lines.length - DIFF_CLAMP_LINES;
        const labelFor = (expanded: boolean) => (expanded ? 'Show less' : `Show full diff (${hiddenCount} more line${hiddenCount === 1 ? '' : 's'})`);
        const moreBtn = h(
          'button.btn.sm.ghost.wt-diff-more',
          {
            type: 'button',
            'aria-expanded': String(ctx.expandedDiffs.has(diffKey)),
            onclick: () => {
              const next = !ctx.expandedDiffs.has(diffKey);
              if (next) ctx.expandedDiffs.add(diffKey);
              else ctx.expandedDiffs.delete(diffKey);
              moreBtn.setAttribute('aria-expanded', String(next));
              moreBtn.textContent = labelFor(next);
              renderRows();
              syncHorizontalScrollCue(scrollWrap);
              ctx.onLayoutChange?.();
            },
          },
          labelFor(ctx.expandedDiffs.has(diffKey)),
        );
        bodyChildren.push(h('div.wt-diff-more-bar', {}, moreBtn));
      }
    } else {
      bodyChildren.push(h('div.wt-diff-note', {}, change.kind === 'added' ? 'Empty file created.' : change.kind === 'deleted' ? 'File deleted.' : 'No line changes recorded.'));
    }

    if (change.truncated) {
      bodyChildren.push(h('div.wt-diff-note', {}, 'Diff preview truncated. Open the file to inspect the rest.'));
    }

    const details = setDisclosureOpen(h('details.wt-change-file', { class: change.generated ? 'is-generated' : '', 'data-disclosure': disclosureKey }, summary, h('div.wt-diff-body', {}, ...bodyChildren)), isOpen);
    const actions = relPath && action.state === 'complete' && change.kind === 'added' && threadDeliverable(change.path) ? deliverableActions(relPath, ctx) : null;
    return actions ? h('div.wt-change-deliverable', {}, details, actions) : details;
  });

  const multiStatePill = action.changes.length > 1 ? cardStatePill(action.state) : null;
  const errorBox = action.state === 'failed' && entry?.output ? h('div.wt-card-error', {}, h('div.wt-detail-label', {}, 'Error'), renderToolCodeSection(entry.output, { lang: 'txt', copyLabel: 'Copy error', isOutput: true })) : null;

  return h('div.wt-card.wt-change-card', { class: `is-${action.state}` }, multiStatePill ? h('div.wt-change-multi-head', {}, h('span.wt-change-multi-title', {}, action.title), multiStatePill) : null, ...fileSections, errorBox);
}

/** Preview and Send to Whiteboard for a file the worker created that the owner may want to look at or share. */
function deliverableActions(relPath: string, ctx: ThreadCardRenderContext): HTMLElement {
  return h(
    'div.wt-change-actions',
    {},
    h('button.btn.sm.ghost.wt-change-preview', { type: 'button', onclick: () => ctx.onOpenPath?.({ path: relPath }) }, icon('file', 13), 'Preview'),
    ctx.sendToWhiteboard ? h('button.btn.sm.ghost.wt-change-board', { type: 'button', onclick: () => ctx.sendToWhiteboard?.(relPath) }, icon('board', 13), 'Send to Whiteboard') : null,
  );
}

/** Renders a first-class Command card (`.wt-card.wt-command-card`), auto-opening when `action.state === 'failed'`. */
export function renderCommandCard(action: ThreadModelAction, entry: ThreadEntry | undefined, ctx: ThreadCardRenderContext): HTMLElement {
  const cmdText = action.command?.command || action.detail || action.title;
  const subText = action.command?.summary;
  const showSub = Boolean(subText && subText !== cmdText);
  const defaultOpen = action.state === 'failed';
  const isOpen = ctx.userToggles.get(action.id) ?? defaultOpen;

  const copyBtn = h('button.btn.sm.ghost.wt-code-copy.wt-cmd-copy', { type: 'button', 'aria-label': 'Copy command' }, 'Copy');
  copyBtn.addEventListener('click', (event) => {
    event.stopPropagation();
  });
  attachCopyFeedback(copyBtn, () => cmdText, 'Copy');

  const images = entry ? ctx.pictures(entry, action.title, cmdText, ctx.owner) : null;
  const output = entry && images ? threadOutputText(entry) : entry?.output;

  const body = entry
    ? h(
        'div.wt-command-body',
        {},
        output ? renderToolCodeSection(output, { lang: 'txt', copyLabel: 'Copy output', isOutput: true }) : !images ? h('pre.wt-code.wt-output', {}, action.state === 'working' ? 'Running command…' : 'No output recorded.') : null,
        images,
      )
    : h('div.wt-command-body', {}, h('p.wt-detail-missing', {}, 'Load earlier messages to see what this command returned.'));

  const details = h(
    'details.wt-command',
    { class: `is-${action.state}`, 'data-disclosure': action.id },
    h(
      'summary.wt-command-summary',
      {},
      h(
        'span.wt-cmd-main',
        {},
        h('span.wt-cmd-line', { title: cmdText }, h('span.wt-cmd-prompt', { 'aria-hidden': 'true' }, '$'), h('span.wt-cmd-text', {}, highlightLine(cmdText, 'sh'))),
        showSub ? h('span.wt-cmd-summary', { title: subText }, subText) : null,
      ),
      copyBtn,
      cardStatePill(action.state),
      chevronNode(),
    ),
    body,
  );

  return h('div.wt-card.wt-command-card', { class: `is-${action.state}` }, setDisclosureOpen(details, isOpen));
}

/** Renders a first-class Subagent / Delegation card (`.wt-card.wt-delegate-card`) with one-click `Open thread` jump. */
export function renderDelegationCard(action: ThreadModelAction, entry: ThreadEntry | undefined, ctx: ThreadCardRenderContext): HTMLElement {
  const delegation = action.delegation ?? { agent: 'Subagent', summary: action.title };
  const matchedId = ctx.openWorker ? resolveDelegatedWorkerId(delegation, ctx.owner.id, ctx.team) : undefined;
  const openBtn =
    matchedId && ctx.openWorker
      ? h(
          'button.btn.sm.wt-delegate-open',
          {
            type: 'button',
            onclick: () => ctx.openWorker?.(matchedId),
          },
          'Open thread',
        )
      : null;

  const showRole = Boolean(delegation.role && delegation.role.toLowerCase() !== delegation.agent.toLowerCase());
  const head = h(
    'div.wt-delegate-head',
    {},
    h(
      'div.wt-delegate-title',
      {},
      h('span.wt-delegate-agent', { title: delegation.agent }, delegation.agent),
      showRole ? h('span.wt-delegate-pill', {}, delegation.role) : null,
      delegation.branch ? h('span.wt-delegate-pill.wt-delegate-branch', { title: delegation.branch }, delegation.branch) : null,
    ),
    h('div.wt-delegate-actions', {}, cardStatePill(action.state, true), openBtn),
  );

  const summaryEl = h('p.wt-delegate-summary', {}, delegation.summary);

  const defaultOpen = action.state === 'failed';
  const isOpen = ctx.userToggles.get(action.id) ?? defaultOpen;
  const images = entry ? ctx.pictures(entry, action.title, delegation.summary, ctx.owner) : null;
  const output = entry && images ? threadOutputText(entry) : entry?.output;
  const argText = entry && action.arguments ? threadArgumentsText(entry.input, action.arguments) : '';

  const detailsBody = entry
    ? h(
        'div.wt-delegate-body',
        {},
        action.arguments && argText ? h('div.wt-detail-label', {}, action.arguments.label) : null,
        action.arguments && argText ? renderToolCodeSection(argText, { lang: 'md', copyLabel: 'Copy prompt' }) : null,
        output || !images ? h('div.wt-detail-label', {}, action.result) : null,
        output
          ? renderToolCodeSection(output, { lang: 'md', copyLabel: 'Copy report', isOutput: true })
          : !images
            ? h('pre.wt-code.wt-output', {}, action.state === 'working' ? 'Waiting for subagent report…' : 'No report recorded in this session.')
            : null,
        images,
      )
    : h('div.wt-delegate-body', {}, h('p.wt-detail-missing', {}, 'Load earlier messages to see this subagent’s prompt and report.'));

  const details = h('details.wt-delegate-details', { 'data-disclosure': action.id }, h('summary.wt-delegate-details-summary', {}, h('span.wt-delegate-toggle-label', {}, 'Prompt & report'), chevronNode()), detailsBody);

  return h('div.wt-card.wt-delegate-card', { class: `is-${action.state}` }, head, summaryEl, setDisclosureOpen(details, isOpen));
}

function diffStats(additions: number, deletions: number): HTMLElement {
  return h('span.wt-diff-stats', { 'aria-label': `${additions} additions, ${deletions} deletions` }, h('span.wt-diff-add', {}, `+${additions}`), h('span.wt-diff-del', {}, `-${deletions}`));
}

const filesWord = (count: number) => (count === 1 ? '1 file' : `${count} files`);

/** A group of tool cards (`details.wt-card-group`): its summary, with `body` holding the cards it folds. */
export function renderToolGroup(group: ThreadToolGroup, body: HTMLElement, live: boolean, userToggles: ReadonlyMap<string, boolean>): HTMLDetailsElement {
  const state = live ? 'working' : group.state;
  const details = h(
    'details.wt-card-group',
    { class: state, 'data-disclosure': group.id },
    h(
      'summary',
      {},
      h('span.wt-activity-mark', { 'aria-hidden': true }),
      h('span.wt-activity-label', { title: group.label }, `${live ? 'Working · ' : ''}${group.label}`),
      group.files ? h('span.wt-group-files', {}, filesWord(group.files)) : null,
      group.files ? diffStats(group.additions, group.deletions) : null,
      live ? null : cardStatePill(group.state),
      chevronNode(),
    ),
    body,
  );
  body.classList.add('wt-group-body');
  return setDisclosureOpen(details, userToggles.get(group.id) ?? group.open);
}

/** What a finished turn changed (`.wt-card.wt-turn-changes`), each file opening in place and the whole in the Changes window. */
export function renderTurnChanges(changes: ThreadTurnChanges, ctx: Pick<ThreadCardRenderContext, 'floorDir' | 'onOpenPath' | 'openChanges'>): HTMLElement {
  const files = changes.files.map((file) => {
    const rel = ctx.onOpenPath ? toWorkspaceRelPath(file.path, ctx.floorDir) : null;
    const name = rel ? h('button.wt-change-path.wt-file-link', { type: 'button', title: file.path, onclick: () => ctx.onOpenPath?.({ path: rel }) }, file.shortPath) : h('span.wt-change-path', { title: file.path }, file.shortPath);
    return h('li.wt-turn-file', {}, name, diffStats(file.additions, file.deletions));
  });
  const more = changes.count - changes.files.length;
  return h(
    'section.wt-card.wt-turn-changes',
    { 'aria-label': 'Changes in this turn' },
    h(
      'div.wt-turn-head',
      {},
      h('span.wt-turn-title', {}, `Changed ${filesWord(changes.count)}`),
      diffStats(changes.additions, changes.deletions),
      ctx.openChanges ? h('button.btn.sm.wt-turn-review', { type: 'button', onclick: () => ctx.openChanges?.() }, 'Review changes') : null,
    ),
    h('ul.wt-turn-files', {}, ...files, more > 0 ? h('li.wt-turn-more', {}, `and ${more} more`) : null),
  );
}
