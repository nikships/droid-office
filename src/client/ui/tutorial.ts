import { Vector3, type Camera } from 'three';
import { Tutorial, TUTORIAL_KEY, parseTutorial, tutorialActionDone, type TutorialObservation, type TutorialStep } from '../tutorial';
import { TUTORIAL_SECTIONS } from '../tutorial-sections';
import { closeAllModals, h, modalOpen, openModal, toast, type Modal } from './dom';
import { groupRow, toggle, windowHeader } from './kit';

export interface TutorialTarget {
  x: number;
  y: number;
  z: number;
  label: string;
  near: boolean;
}
export interface TutorialHost {
  camera: Camera;
  ready(): boolean;
  offerReady(): boolean;
  observe(): TutorialObservation;
  target(name: string): TutorialTarget | null;
}

let current: TutorialView | undefined;

export function mountTutorial(host: TutorialHost) {
  current = new TutorialView(host);
}

/** Called only after the real action succeeds, never by the tutorial's own buttons. */
export function tutorialEvent(event: string) {
  current?.event(event);
}

export function openTutorial() {
  current?.choose();
}

export function tutorialSettings(): HTMLElement {
  const view = current;
  const group = h('div.group');
  if (!view) return group;
  for (const section of TUTORIAL_SECTIONS) {
    const p = view.model.progress.sections[section.id];
    const status = { 'not-started': 'Not started', 'in-progress': 'In progress', done: 'Done', skipped: 'Skipped' }[p.status];
    group.append(
      groupRow(
        section.title,
        `${status}${p.skipped.length ? ` · ${p.skipped.length} skipped steps` : ''}`,
        h(
          'button.btn.sm',
          {
            type: 'button',
            'aria-label': `Replay ${section.title}`,
            onclick: () => {
              closeAllModals();
              view.model.replay(section.id);
              view.render();
            },
          },
          'Replay',
        ),
      ),
    );
  }
  const restart = h('button.btn', { type: 'button', onclick: () => view.choose() }, 'Restart the whole tutorial');
  return h('section.settings-group', {}, h('h4.group-title', {}, 'Tutorial'), h('p.field-hint', {}, 'Learn by doing. Every step is skippable. Progress stays in this browser, including across office restarts.'), group, restart);
}

function visible(selector: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>(selector)].find((el) => el.checkVisibility() && el.getBoundingClientRect().width > 0) ?? null;
}

class TutorialView {
  readonly model: Tutorial;
  private readonly panel = h('aside.tutorial-panel.stack.tight', { 'aria-label': 'Tutorial', hidden: true });
  private readonly pin = h('div.tutorial-pin', { 'aria-hidden': 'true', hidden: true });
  private readonly arrow = h('span.tutorial-arrow', {}, '➤');
  private readonly label = h('span.tutorial-pin-label');
  private readonly feedback = h('p.field-hint.tutorial-feedback');
  private readonly cam = new Vector3();
  private readonly ndc = new Vector3();
  private chooser: Modal | null = null;
  private before: TutorialObservation | null = null;
  private shown = '';
  private highlighted: HTMLElement | null = null;
  private entered = 0;
  private actionDone = false;
  private storageFailed = false;

  constructor(private readonly host: TutorialHost) {
    let json: string | null = null;
    try {
      json = localStorage.getItem(TUTORIAL_KEY);
    } catch {
      this.storageFailed = true;
    }
    this.model = new Tutorial(TUTORIAL_SECTIONS, parseTutorial(json, TUTORIAL_SECTIONS), (progress) => {
      try {
        localStorage.setItem(TUTORIAL_KEY, JSON.stringify(progress));
      } catch {
        this.storageFailed = true;
      }
    });
    this.pin.append(this.arrow, this.label);
    document.body.append(this.panel, this.pin);
    // This is a HUD, not a modal: movement and the windows' existing Esc handling stay intact.
    this.panel.addEventListener('click', (event) => {
      (event.target as HTMLElement).closest('button')?.blur();
    });
    window.setInterval(() => this.tick(), 100);
  }

  choose() {
    if (this.chooser) return;
    this.clearHighlight();
    this.panel.hidden = true;
    this.pin.hidden = true;
    const choices = TUTORIAL_SECTIONS.map((section) => ({
      id: section.id,
      el: toggle({ label: section.title, description: `${section.steps.length} short steps`, checked: true }),
    }));
    const start = h('button.btn.accent', { type: 'button' }, 'Start tutorial');
    const decline = h('button.btn.ghost', { type: 'button' }, 'Not now');
    const el = h(
      'div.modal.tutorial-chooser',
      { role: 'dialog', 'aria-label': 'Choose your tutorial' },
      windowHeader('Make yourself at home', 'Learn the office by doing. Choose your sections; skip any step, section or the whole tour.'),
      h(
        'div.body.stack',
        {},
        h('p.note.info', {}, 'The tour uses your real office. It never hires, publishes or deletes anything for you. Credit-spending actions are optional; destructive actions are explained, not practised.'),
        h('div.stack.tight', {}, ...choices.map((choice) => choice.el)),
        h('p.field-hint', {}, 'All sections can be replayed from Settings → You → Tutorial. Progress is saved in this browser.'),
      ),
      h('footer', {}, h('span.grow', {}, 'Your office, your pace'), decline, start),
    );
    let picked = false;
    const modal = openModal(el, {
      onClose: () => {
        this.chooser = null;
        if (!picked) this.model.end();
        this.shown = '';
        this.render();
      },
    });
    this.chooser = modal;
    decline.addEventListener('click', () => modal.close());
    start.addEventListener('click', () => {
      picked = true;
      this.model.start(choices.filter((c) => c.el.input.checked).map((c) => c.id));
      modal.close();
      // Starting from Settings must not leave it over the first exercise.
      closeAllModals();
    });
    start.focus();
  }

  event(event: string) {
    if (!this.chooser && this.model.step?.event === event) this.advance();
  }

  private advance(skip = false) {
    const wasActive = this.model.progress.active;
    this.model.advance(skip);
    this.render();
    if (wasActive && !this.model.progress.active) toast('Tutorial finished. Replay any section in Settings → You → Tutorial.');
  }

  render() {
    const step = this.model.step;
    const section = this.model.section;
    this.clearHighlight();
    this.pin.hidden = true;
    if (!step || !section || this.chooser) {
      this.panel.hidden = true;
      this.shown = '';
      return;
    }
    this.shown = `${section.id}/${step.id}`;
    this.before = this.host.observe();
    this.entered = performance.now();
    this.actionDone = false;
    const button = (label: string, action: () => void, primary = false) => h(`button.btn.sm.${primary ? 'accent' : 'ghost'}`, { type: 'button', onclick: action }, label);
    const title = h(
      'div.stack.tight',
      { 'aria-live': 'polite', 'aria-atomic': 'true' },
      h('span.eyebrow', {}, `${section.title} · ${section.steps.indexOf(step) + 1}/${section.steps.length}`),
      h('h3', {}, step.title),
      h('p', {}, step.text),
    );
    this.panel.dataset.step = this.shown;
    this.panel.replaceChildren(
      h(
        'div.stack.tight',
        {},
        title,
        step.warning ? h('p.note.warn', {}, step.warning) : null,
        this.feedback,
        this.storageFailed ? h('p.note.warn', {}, 'Browser storage is blocked. Progress cannot survive a reload.') : null,
        h(
          'div.row.wrap',
          {},
          this.model.explanation ? button('Next', () => this.advance(), true) : h('span.tutorial-do', {}, 'Do the action to continue'),
          button('Skip step', () => this.advance(true)),
        ),
        h(
          'div.row.wrap',
          {},
          button('Skip section', () => {
            this.model.skipSection();
            this.render();
          }),
          button('End tutorial', () => {
            this.model.end();
            this.render();
          }),
          button('Move guide', () => this.panel.classList.toggle('right')),
        ),
      ),
    );
    this.panel.hidden = false;
    this.feedback.textContent = 'Esc frees the mouse or closes the top window. Nothing here takes your game keys.';
  }

  private tick() {
    if (this.chooser || document.visibilityState === 'hidden') return;
    if (!this.model.progress.offered && this.host.ready() && this.host.offerReady() && !modalOpen()) return this.choose();
    const step = this.model.step;
    if (!step || !this.host.ready()) return;
    if (this.shown !== `${this.model.section!.id}/${step.id}`) this.render();
    const target = step.target ? this.host.target(step.target) : null;
    const now = this.host.observe();
    now.near = target?.near ?? false;
    const ui = step.highlight ? visible(step.highlight) : step.selector ? visible(step.selector) : null;
    if (this.highlighted !== ui) {
      this.clearHighlight();
      ui?.classList.add('tutorial-highlight');
      this.highlighted = ui;
    }
    this.mark(target, step, !!ui);
    const feedback =
      step.target && !target && !ui
        ? 'No matching target on this floor. Use the floor menu to return to a project, or skip this step. Replay is always available.'
        : modalOpen() && target && !ui
          ? 'Close the top window with Esc (Shift+Esc in a terminal) to return to the room.'
          : 'Esc frees the mouse or closes the top window. Skip never changes your work.';
    if (this.feedback.textContent !== feedback) this.feedback.textContent = feedback;
    this.actionDone ||= !!((step.selector && visible(step.selector)) || (step.check && this.before && tutorialActionDone(step.check, now, this.before)));
    // Keep each goal readable and avoid one already-open window racing through several steps.
    if (performance.now() - this.entered < 900) return;
    if (this.actionDone) this.advance();
  }

  private clearHighlight() {
    this.highlighted?.classList.remove('tutorial-highlight');
    this.highlighted = null;
  }

  private mark(target: TutorialTarget | null, step: TutorialStep, hasUi: boolean) {
    this.pin.hidden = !target || hasUi || modalOpen();
    if (!target || this.pin.hidden) return;
    const point = this.ndc.set(target.x, target.y, target.z);
    const cam = this.cam.copy(point).applyMatrix4(this.host.camera.matrixWorldInverse);
    point.project(this.host.camera);
    const cx = innerWidth / 2;
    const cy = innerHeight / 2;
    const inView = cam.z < 0 && Math.abs(point.x) < 0.8 && Math.abs(point.y) < 0.75;
    let dx = cam.z < -0.01 ? point.x * cx : cam.x;
    let dy = cam.z < -0.01 ? -point.y * cy : -cam.y;
    if (Math.abs(dx) + Math.abs(dy) < 0.01) dy = 1;
    if (!inView) {
      const scale = Math.min((cx - 100) / Math.max(Math.abs(dx), 0.001), (cy - 100) / Math.max(Math.abs(dy), 0.001));
      dx *= scale;
      dy *= scale;
    }
    this.pin.style.transform = `translate(${Math.round(cx + dx)}px, ${Math.round(cy + dy)}px)`;
    this.arrow.style.transform = `rotate(${inView ? Math.PI / 2 : Math.atan2(dy, dx)}rad)`;
    this.pin.classList.toggle('in-view', inView);
    const label = `${target.label}${step.check === 'near' && target.near ? ' · here' : ''}`;
    if (this.label.textContent !== label) this.label.textContent = label;
  }
}
