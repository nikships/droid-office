/** Tutorial progress is local to this browser, like the owner's character and controls. */
export const TUTORIAL_KEY = 'droid-office.tutorial';

export type TutorialCheck = 'walk' | 'look' | 'jump' | 'near' | 'floor' | 'hire' | 'screen' | 'terminal' | 'carry' | 'wand' | 'holster' | 'lumos' | 'wheel' | 'hanging';
export interface TutorialStep {
  id: string;
  title: string;
  text: string;
  /** No check means an explanation, with a Next button. */
  check?: TutorialCheck;
  /** A visible UI state completes this action, not a keypress or a click on Next. */
  selector?: string;
  /** UI control to outline, even before the desired state is reached. */
  highlight?: string;
  target?: string;
  event?: string;
  warning?: string;
}
export interface TutorialSection {
  id: string;
  title: string;
  steps: TutorialStep[];
}

export type SectionStatus = 'not-started' | 'in-progress' | 'done' | 'skipped';
export interface SectionProgress {
  status: SectionStatus;
  step: string;
  skipped: string[];
}
export interface TutorialProgress {
  version: 1;
  offered: boolean;
  active: string | null;
  queue: string[];
  sections: Record<string, SectionProgress>;
}

export function freshTutorial(sections: TutorialSection[]): TutorialProgress {
  return {
    version: 1,
    offered: false,
    active: null,
    queue: [],
    sections: Object.fromEntries(sections.map((s) => [s.id, { status: 'not-started', step: s.steps[0].id, skipped: [] }])),
  };
}

/** Treat corrupt, obsolete or future saves as untrusted input, never as a step index. */
export function parseTutorial(json: string | null, sections: TutorialSection[]): TutorialProgress {
  const result = freshTutorial(sections);
  try {
    const saved = JSON.parse(json ?? 'null');
    if (saved?.version !== 1) return result;
    result.offered = saved.offered === true;
    for (const section of sections) {
      const p = saved.sections?.[section.id];
      if (!p || !['not-started', 'in-progress', 'done', 'skipped'].includes(p.status)) continue;
      result.sections[section.id] = {
        status: p.status,
        step: section.steps.some((s) => s.id === p.step) ? p.step : section.steps[0].id,
        skipped: section.steps.filter((s) => Array.isArray(p.skipped) && p.skipped.includes(s.id)).map((s) => s.id),
      };
    }
    result.queue = sections.filter((s) => Array.isArray(saved.queue) && saved.queue.includes(s.id)).map((s) => s.id);
    if (typeof saved.active === 'string' && result.sections[saved.active]?.status === 'in-progress') {
      result.active = saved.active;
      result.queue = result.queue.filter((id) => id !== saved.active);
    }
  } catch {
    // Broken or unavailable storage must not stop the office.
  }
  return result;
}

/** No DOM, network or worker actions: only the tutorial's own progress can change here. */
export class Tutorial {
  constructor(
    readonly sections: TutorialSection[],
    public progress: TutorialProgress,
    private readonly save: (progress: TutorialProgress) => void,
  ) {}

  get section() {
    return this.sections.find((s) => s.id === this.progress.active);
  }
  get step() {
    const section = this.section;
    return section?.steps.find((s) => s.id === this.progress.sections[section.id].step);
  }
  get explanation() {
    const step = this.step;
    return !!step && !step.check && !step.selector && !step.event;
  }
  changed() {
    this.save(this.progress);
  }
  start(ids: string[]) {
    this.progress = freshTutorial(this.sections);
    this.progress.offered = true;
    this.progress.queue = this.sections.filter((s) => ids.includes(s.id)).map((s) => s.id);
    for (const s of this.sections) if (!ids.includes(s.id)) this.progress.sections[s.id].status = 'skipped';
    this.nextSection();
  }
  replay(id: string) {
    const section = this.sections.find((s) => s.id === id);
    if (!section) return;
    this.progress.offered = true;
    this.progress.active = id;
    this.progress.queue = [];
    this.progress.sections[id] = { status: 'in-progress', step: section.steps[0].id, skipped: [] };
    this.changed();
  }
  end() {
    this.progress.offered = true;
    for (const id of [this.progress.active, ...this.progress.queue]) if (id) this.progress.sections[id].status = 'skipped';
    this.progress.active = null;
    this.progress.queue = [];
    this.changed();
  }
  advance(skip = false) {
    const section = this.section;
    const step = this.step;
    if (!section || !step) return;
    const p = this.progress.sections[section.id];
    if (skip && !p.skipped.includes(step.id)) p.skipped.push(step.id);
    const next = section.steps[section.steps.indexOf(step) + 1];
    if (next) {
      p.step = next.id;
      this.changed();
    } else {
      p.status = p.skipped.length ? 'skipped' : 'done';
      this.nextSection();
    }
  }
  skipSection() {
    if (!this.section) return;
    this.progress.sections[this.section.id].status = 'skipped';
    this.nextSection();
  }
  private nextSection() {
    this.progress.active = this.progress.queue.shift() ?? null;
    if (this.progress.active) this.progress.sections[this.progress.active].status = 'in-progress';
    this.changed();
  }
}

export interface TutorialObservation {
  x: number;
  y: number;
  z: number;
  facing: number;
  pitch: number;
  floor: string | null;
  grounded: boolean;
  controls: boolean;
  riding: boolean;
  near: boolean;
  workers: string[];
  screens: string[];
  terminal: boolean;
  carrying: boolean;
  wand: boolean;
  armed: boolean;
  lumos: boolean;
  wheel: boolean;
  hanging: boolean;
}

export function tutorialActionDone(check: TutorialCheck, now: TutorialObservation, before: TutorialObservation): boolean {
  switch (check) {
    case 'walk':
      return now.controls && now.floor === before.floor && Math.hypot(now.x - before.x, now.z - before.z) >= 1.5;
    case 'look':
      return now.controls && (Math.abs(Math.atan2(Math.sin(now.facing - before.facing), Math.cos(now.facing - before.facing))) > 0.3 || Math.abs(now.pitch - before.pitch) > 0.2);
    case 'jump':
      return now.controls && !now.grounded && now.y > before.y + 0.25;
    case 'near':
      return now.near;
    case 'floor':
      return !!now.floor && now.floor !== before.floor && !now.riding;
    case 'hire':
      return now.floor === before.floor && now.workers.some((id) => !before.workers.includes(id));
    case 'screen':
      return now.screens.length > 0;
    case 'terminal':
      return now.terminal;
    case 'carry':
      return now.carrying;
    case 'wand':
      return now.wand;
    case 'holster':
      return !now.armed;
    case 'lumos':
      return now.wand && now.lumos !== before.lumos;
    case 'wheel':
      return now.wand && now.wheel;
    case 'hanging':
      return now.hanging;
  }
}
