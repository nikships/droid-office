// Rewrites the Thread presentation contract from the office's own engine: each case's `expected`
// rows, and the `paging` steps built from the captured cases. The cases' `entries` are captured
// sessions and are never changed here. `tests/thread-golden.test.ts` fails until the file matches.
//
//   node --import tsx tools/thread-fixture.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageRows, presentThread, THREAD_MODEL_VERSION } from '../src/shared/thread-presentation.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE = path.join(root, 'android/app/src/test/resources/thread-presentation-golden.json');

const ABOUT =
  "The Thread's presentation contract. Each case is the wire ThreadEntry list the office reads from a captured session (src/shared/worker-thread.ts) and the presentation rows the office sends for it (ThreadRow in src/shared/thread-presentation.ts, `presentation.rows` of thread.snapshot). The office builds the rows; the web companion and the Android app only decode and render them. `paging` replays captured cases as the pages a client receives, with the rows it must hold after each one. Regenerate with `node --import tsx tools/thread-fixture.mjs`; never edit `expected` by hand.";

const SCHEMA = {
  case: '{ name: string (unique), busy: boolean (the worker is in a turn), entries: ThreadEntry[] (wire shape, oldest first), expected: ThreadRow[] }',
  presentation: `{ version: ${THREAD_MODEL_VERSION}, rows: ThreadRow[] } on thread.snapshot. A client that gets a version it doesn't know, or none, says so and offers Raw TTY instead of guessing.`,
  message: "{ kind: 'message', id: entry id, from, to: its seq, role: 'user' | 'assistant', startsTurn: boolean (first assistant message after the owner's, or the first one: the only one that carries the worker's name) }",
  notice: "{ kind: 'notice', id: entry id, from, to: its seq, role, text: string (the copy shown), tone: 'quiet' | 'danger' | 'attachment' }",
  activity:
    "{ kind: 'activity', id: 'activity:' + first entry id, from, to: seqs of its first and last entry (hidden ones included), sourceIds: every entry it stands for, label: the closed line, state, live: newest while busy, open: false (the default disclosure), status?: '2 failed · 1 no result', running?: newest working action's title while live, failed: { id, title, preview }[] (shown even closed), blocks: Block[] }",
  thought: "{ kind: 'thought', id: entry id, preview: first non-blank line, asterisks stripped, clipped to 120, live: busy and the last entry, open: false }",
  tools: "{ kind: 'tools', id: 'tools:' + first entry id of the run, label, state, live, open: false, actions: Action[], plan?: { done, active, text }[] (the run's plan, only when it changed since the last one shown) }",
  action:
    "{ id: tool entry id, title: human, never a raw command, JSON or home path, detail?: short path, pattern or subagent type, category, state: 'complete' | 'working' | 'failed' | 'incomplete' | 'cancelled', status: the state in words or '', causedBy?: the child entry whose failure this wrapper repeats, arguments?: { label, field? } (field: key of the input JSON, '.' for a JSON string, absent for the whole input), result: 'Result' | 'Error' | 'Cancelled', open: false }",
  paging:
    '{ name, busy, steps: { snapshot: thread.snapshot fields (before?, entries, hasMore, presentation), expected: { entries: ids loaded, rows: ThreadRow[] held } }[] }. A latest page replaces the rows from its first row on; an earlier page adds only rows that end before the first row already held.',
  rules: [
    'Messages and shown notices are top-level rows. Everything between them is one Activity row holding, in order, its thoughts and its tool runs; a thought splits tool runs but not the Activity. An Activity with nothing to show leaves no row.',
    'Hidden when they succeed: TodoWrite, TodoRead, ToolSearch, Skill, WaitForScript, TaskOutput, and a Script followed by any tool call before the next Script or the end of the run. A failed one is always shown, with its exact failure title.',
    "A failed Script with the CLI's exact error envelope repeating an enclosed child's full failure stays available (causedBy) but is excluded from labels and failed counts. Independent, unmatched, truncated or incomplete wrapper failures remain counted.",
    "Turn ended · completed is hidden; Turn cancelled is a quiet notice. Only an exact CLI by-user result proves owner cancellation; a bare 'Tool execution was interrupted' stays failed.",
    "A call with no output is 'working' only in the live run; otherwise 'incomplete'. Never 'complete' without output.",
    "Labels: verb phrases per kind in first-seen order, then 'N more' past three kinds; edited and created files are unique; failed bookkeeping isn't counted. An Activity with only thoughts is 'Thought'.",
    "Every disclosure starts closed. Clients keep the owner's choices by id across polls, result updates and earlier pages, and drop them for a new session.",
  ],
};

/** The pages a client receives for a captured case, newest first, and the rows it must then hold. */
function paging(name, example, size) {
  const all = example.entries;
  const full = presentThread(all, example.busy);
  const steps = [];
  let first = all.length;
  while (first > 0) {
    const latest = first === all.length;
    const end = first;
    first = Math.max(0, first - size);
    const entries = all.slice(first, end);
    const before = latest ? undefined : all[end].seq;
    steps.push({
      snapshot: {
        ...(before !== undefined ? { before } : {}),
        sessionId: 'captured',
        entries,
        hasMore: first > 0,
        presentation: { version: THREAD_MODEL_VERSION, rows: pageRows(full, entries, before) },
      },
      expected: { entries: all.slice(first).map((e) => e.id), rows: full.filter((row) => row.to >= all[first].seq) },
    });
  }
  return { name, busy: example.busy, steps };
}

export function threadFixture(current) {
  const cases = current.cases.map(({ name, busy, entries }) => ({ name, busy, entries, expected: presentThread(entries, busy) }));
  const byName = (name) => cases.find((c) => c.name === name);
  return {
    version: 2,
    about: ABOUT,
    schema: SCHEMA,
    cases,
    paging: [
      paging('release_turn_in_pages_of_four', byName('reported_release_turn'), 4),
      paging('thinking_turn_in_pages_of_two', byName('chronology_with_thinking'), 2),
      paging('crash_and_stop_in_pages_of_three', byName('unit_real_crash_wrapper_flushed_by_a_later_stop'), 3),
    ],
  };
}

export const render = (fixture) => `${JSON.stringify(fixture, null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(FIXTURE, render(threadFixture(JSON.parse(readFileSync(FIXTURE, 'utf8')))));
}
