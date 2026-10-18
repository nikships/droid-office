// What each row of the 02 PIPELINES board says (world/boards.ts draws it): kept apart from the
// canvas so tests can read it without a DOM.

import { ago, clock, eventLabel, pipelineGroups, runTime, STATE_WORD, stateWord, waitTime, type PipelineRun, type PipelinesState, type RunState } from '../../shared/pipelines';

/** One run as the Pipelines board draws it. */
export interface RunRow {
  id: number;
  state: RunState;
  workflow: string;
  number: string;
  title: string;
  sub: string;
  /** The right-hand column: what it's at, and under it how long ago or which job. */
  side: string;
  sideSub: string;
  /** Running: how far along its jobs are, 0–1; undefined when it's not known. */
  progress?: number;
}

/** The rows the board draws from the floor's runs at `now`: running, waiting, then the latest finished. */
export function runRows(state: PipelinesState, now: number): RunRow[] {
  const { running, pending, recent } = pipelineGroups(state.runs);
  const row = (r: PipelineRun): RunRow => {
    const sub = [r.branch, eventLabel(r.event), r.actor && `@${r.actor}`].filter(Boolean).join('  \u00B7  ');
    const base = { id: r.id, state: r.state, workflow: r.workflow, number: `#${r.number}`, title: r.title || r.workflow, sub };
    if (r.state === 'running') {
      const j = r.jobs;
      const jobs = j?.total ? `${j.done}/${j.total} JOBS  \u00B7  ` : '';
      return { ...base, side: `${jobs}${clock(runTime(r, now))}`, sideSub: j?.failed ? `${j.failed} failed` : (j?.current ?? 'running'), progress: j?.total ? j.done / j.total : undefined };
    }
    if (r.state === 'pending') return { ...base, side: stateWord(r).toUpperCase(), sideSub: `for ${clock(waitTime(r, now))}` };
    const took = runTime(r, now);
    return { ...base, side: r.state === 'success' || r.state === 'failure' ? (took ? clock(took) : STATE_WORD[r.state]) : STATE_WORD[r.state], sideSub: `${ago(r.updatedAt, now)} ago` };
  };
  return [...running.map(row), ...pending.map(row), ...recent.map(row)];
}
