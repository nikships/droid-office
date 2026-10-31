import type { Net } from '../net';
import { store } from '../state';
import { droidReady } from '../../shared/setup';
import { providerName, type SubscriptionProvider, type SubscriptionProviderKey } from '../../shared/subscriptions';
import { copyButton } from './clipboard';
import { h, openModal, toast, type Modal } from './dom';
import { field, windowHeader } from './kit';
import { modelPicker } from './model-picker';
import { providerLogo } from './model-logo';
import { droidCatalogue, officeChoice, pickerModel } from './models';
import { accountRow, connect, connectingBlock, connectLabel, placeholderProvider, UPDATES_FIRST_NOTE, updatesFirst } from './subscriptions-settings';
import { progressBar, signInPanel, waitLine } from './welcome-signin';
import {
  currentStep,
  defaultWorkerChange,
  droidPhase,
  FEATURED_PROVIDERS,
  factoryPhase,
  justConnected,
  PROVIDER_PLAN,
  providerConnected,
  readyModel,
  shouldAutoOpen,
  stepDone,
  stepMeta,
  stepPlan,
  stepTitle,
  subscriptionsPhase,
  type WelcomeAction,
  type WelcomeStepId,
  welcomeSteps,
} from './welcome-steps';

/** Droid's own one-line install, for a computer the office can't install it on by itself. */
const MANUAL_INSTALL = 'curl -fsSL https://app.factory.ai/cli | sh';

const STEP_ICON: Record<WelcomeStepId, string> = { droid: '🤖', factory: '🏭', subscriptions: '🔌', ready: '🚀' };

const LEDE: Record<WelcomeStepId, string> = {
  droid: 'Droid is the coding agent your workers are. The office installs it for you.',
  factory: 'Droid runs on a Factory account. Sign in, or create an account, in your browser.',
  subscriptions: 'Use the Claude or ChatGPT plan you already pay for. DroidProxy, a small menu-bar app, connects them.',
  ready: 'Pick the model new workers start on. You can change it any time in Settings → Models.',
};

const HIRE_HINT = 'Walk up to an empty desk and press E to hire your first worker.';

let current: Modal | null = null;
/** Closed with Esc or ✕ in this tab: it doesn't open by itself again here. */
let closedHere = false;
/** Steps the owner skipped in this tab. */
const skipped = new Set<WelcomeStepId>();
/** The providers whose Connect the owner pressed here, in order. */
const pressed: SubscriptionProviderKey[] = [];

export function welcomeOpen(): boolean {
  return !!current;
}

/**
 * Opens the welcome by itself once `loaded` settles, and again whenever the setup topic says the
 * office needs it, until the owner closes it in this tab.
 */
export function watchWelcome(net: Net, loaded: Promise<unknown>) {
  let ready = false;
  const maybe = () => {
    if (ready && shouldAutoOpen(store.setup, closedHere, !!current)) openWelcome(net);
  };
  const go = () => {
    ready = true;
    maybe();
  };
  void loaded.then(go, go);
  store.on('setup', maybe);
}

/** The welcome: Droid, the Factory account, Subscriptions and Ready down the side, the step picked on the right. */
export function openWelcome(net: Net, first?: WelcomeStepId) {
  if (current) return;
  /** The step the owner picked down the side; null follows the first one left to do. */
  let viewing: WelcomeStepId | null = first ?? null;
  let viewingWasDone = viewing ? stepDone(viewing, store.setup, store.subscriptions) : false;
  const shown = (): WelcomeStepId => {
    if (viewing && welcomeSteps(store.subscriptions).includes(viewing)) return viewing;
    return currentStep(store.setup, store.subscriptions, skipped);
  };
  const view = (id: WelcomeStepId | null) => {
    viewing = id;
    viewingWasDone = id ? stepDone(id, store.setup, store.subscriptions) : false;
    paint();
  };

  const nav = h('nav.welcome-steps', { 'aria-label': 'Steps' });
  const panes = new Map<WelcomeStepId, { el: HTMLElement; content: HTMLElement; no: HTMLElement }>();
  const pane = (id: WelcomeStepId, ...fixed: Node[]) => {
    const no = h('span.no');
    const content = h('div.welcome-content');
    const el = h(
      'section.welcome-pane',
      { 'aria-labelledby': `welcome-${id}-title` },
      h('div.welcome-head', {}, h('span.welcome-icon', { 'aria-hidden': 'true' }, STEP_ICON[id]), h('div.eyebrow', {}, 'Step', no)),
      h('h3.welcome-title', { id: `welcome-${id}-title` }, stepTitle(id)),
      h('p.welcome-lede', {}, LEDE[id]),
      ...fixed,
      content,
    );
    panes.set(id, { el, content, no });
    return el;
  };

  // Ready: the model picker stays put across repaints, so a pick isn't lost when the state moves.
  const picker = modelPicker({ id: 'welcome-model', label: 'Model for new workers', models: [], value: officeChoice().model, none: { label: 'Default', note: 'Droid’s own default' } });
  let picked = false;
  let modelIds: string[] = [];
  picker.element.addEventListener('change', () => (picked = true));
  const preselect = () => {
    if (picked) return;
    picker.set(readyModel(store.subscriptions, modelIds, officeChoice().model, justConnected(store.subscriptions, pressed)));
  };
  let loading = false;
  const loadModels = () => {
    if (loading) return;
    loading = true;
    void droidCatalogue()
      .then((c) => {
        modelIds = c.models.map((m) => m.id);
        picker.setModels(c.models.map(pickerModel), { label: 'Default', note: 'Droid’s own default' });
        preselect();
      })
      .catch(() => {})
      .finally(() => (loading = false));
  };

  const signIn = signInPanel(net);
  const body = h(
    'div.split.welcome-body',
    {},
    nav,
    h('div.welcome-panes', {}, pane('droid'), pane('factory', signIn.element), pane('subscriptions'), pane('ready', h('div.welcome-picker', {}, field('Model for new workers', picker.element)))),
  );
  const secondary = h('button.btn.ghost', { type: 'button' });
  const primarySlot = h('span.welcome-primary');
  const el = h(
    'div.modal.welcome',
    { role: 'dialog', 'aria-label': 'Welcome to Droid Office' },
    windowHeader('Welcome to Droid Office', 'A few steps, and your first worker can start.'),
    body,
    h('footer', {}, h('span.grow', {}, h('span.key', {}, 'Esc'), 'closes · ☰ Welcome brings it back'), secondary, primarySlot),
  );

  let navKey = '';
  let primaryKey = '';
  let subsKey = '';
  let moreOpen = false;

  const paintNav = (at: WelcomeStepId) => {
    const s = store.setup;
    const subs = store.subscriptions;
    const steps = welcomeSteps(subs);
    const rows = steps.map((id, i) => ({ id, i, done: stepDone(id, s, subs), meta: stepMeta(id, s, subs, skipped) }));
    const next = JSON.stringify([at, rows]);
    if (next === navKey) return;
    navKey = next;
    nav.replaceChildren(
      ...rows.map((r) =>
        h(
          'button.list-row.welcome-step',
          {
            type: 'button',
            class: [r.id === at && 'on', r.done && 'done'].filter(Boolean).join(' '),
            'aria-current': r.id === at ? 'step' : undefined,
            'aria-label': `${stepTitle(r.id)}${r.done ? ', done' : ''}: ${r.meta}`,
            onclick: () => view(r.id),
          },
          h('span.welcome-mark', { 'aria-hidden': 'true' }, r.done ? '✓' : String(r.i + 1)),
          h('span.list-main', {}, h('span.list-title', {}, stepTitle(r.id)), h('span.list-meta', { title: r.meta }, r.meta)),
        ),
      ),
    );
    steps.forEach((id, i) => {
      const p = panes.get(id);
      if (p) p.no.textContent = `${i + 1} of ${steps.length}`;
    });
  };

  const done = (text: string) => h('p.welcome-done', {}, h('span.welcome-check', { 'aria-hidden': 'true' }, '✓'), text);

  const paintDroid = (content: HTMLElement) => {
    const d = store.setup.droid;
    const phase = droidPhase(d);
    const parts: Node[] = [];
    if (phase === 'checking') parts.push(waitLine('Looking for Droid…'));
    if (phase === 'missing') parts.push(h('p.field-hint', {}, 'It goes in ~/.local/bin/droid, checked against Factory’s signature first.'));
    if (phase === 'installing') parts.push(progressBar('Installing Droid', d.progress), waitLine(typeof d.progress === 'number' ? `Downloading and checking Droid… ${Math.round(d.progress * 100)}%` : 'Downloading and checking Droid…'));
    if (phase === 'manual') {
      parts.push(
        h('p.field-hint', {}, 'The office can’t install Droid on this computer by itself. Run this in a terminal, then check again:'),
        h(
          'div.input-group.welcome-cmd',
          {},
          h('input.input', { type: 'text', readonly: true, value: MANUAL_INSTALL, 'aria-label': 'Install command', spellcheck: 'false' }),
          copyButton('Copy', () => MANUAL_INSTALL),
        ),
      );
    }
    if (phase === 'installed') parts.push(done(d.version ? `Droid ${d.version} is installed.` : 'Droid is installed.'));
    if (d.error && phase !== 'installing') parts.push(h('p.note.bad', { role: 'alert' }, d.error));
    content.replaceChildren(...parts);
  };

  const paintFactory = (content: HTMLElement) => {
    const d = store.setup.droid;
    const phase = factoryPhase(store.setup);
    const parts: Node[] = [];
    if (phase === 'needs-droid') parts.push(h('p.field-hint', {}, 'Install Droid first, in the step before this one.'));
    if (phase === 'signed-out') parts.push(h('p.field-hint', {}, 'The office starts Droid’s own sign-in and shows you its code here.'));
    if (phase === 'checking') parts.push(waitLine('Checking Droid’s sign-in…'));
    if (phase === 'unknown') parts.push(h('p.field-hint', {}, 'The office couldn’t tell whether Droid is signed in.'));
    if (phase === 'signed-in') parts.push(done(d.account ? `Signed in as ${d.account}.` : 'Signed in to Factory.'));
    if (d.error && phase !== 'code' && phase !== 'starting') parts.push(h('p.note.bad', { role: 'alert' }, d.error));
    content.replaceChildren(...parts);
    signIn.paint();
  };

  const providerOf = (key: SubscriptionProviderKey): SubscriptionProvider => store.subscriptions.providers.find((p) => p.key === key) ?? placeholderProvider(key);
  const pressConnect = (p: SubscriptionProvider) => {
    pressed.push(p.key);
    connect(net, p);
  };

  const featuredCard = (p: SubscriptionProvider): HTMLElement => {
    const name = providerName(p.key);
    const plan = PROVIDER_PLAN[p.key] ?? name;
    const live = providerConnected(p) || !!p.connecting;
    if (!live) {
      return h(
        'button.welcome-provider',
        { type: 'button', onclick: () => pressConnect(p), 'aria-label': `Connect ${name}` },
        h('span.welcome-provider-logo', {}, providerLogo(p.key)),
        h('b', {}, name),
        h('small', {}, plan),
        h('span.welcome-provider-go', {}, p.connect === 'app' || updatesFirst() ? connectLabel(p) : 'Connect →'),
      );
    }
    return h(
      'div.welcome-provider.live',
      { class: providerConnected(p) ? 'connected' : '' },
      h('span.welcome-provider-logo', {}, providerLogo(p.key)),
      h('b', {}, name, providerConnected(p) ? h('span.welcome-check', { 'aria-hidden': 'true' }, '✓') : null),
      h('small', {}, plan),
      p.accounts.length ? h('ul.subs-accounts', {}, ...p.accounts.map((a) => accountRow(a))) : null,
      connectingBlock(p, net),
      p.connecting?.error ? h('button.btn.sm', { type: 'button', onclick: () => pressConnect(p) }, 'Try again') : null,
    );
  };

  const paintSubscriptions = (content: HTMLElement) => {
    const subs = store.subscriptions;
    const next = JSON.stringify([subs.providers, subs.proxy, Math.floor(Date.now() / 60_000)]);
    if (next === subsKey) return;
    subsKey = next;
    const others = subs.providers.filter((p) => !FEATURED_PROVIDERS.includes(p.key));
    const more = others.length
      ? h(
          'details.welcome-more',
          { open: moreOpen, ontoggle: (e: Event) => (moreOpen = (e.currentTarget as HTMLDetailsElement).open) },
          h('summary', {}, `More: ${others.map((p) => providerName(p.key)).join(', ')}`),
          h(
            'ul.list.boxed',
            {},
            ...others.map((p) =>
              h(
                'li.welcome-other',
                {},
                h(
                  'div.row',
                  {},
                  providerLogo(p.key),
                  h('span.list-main', {}, h('span.list-title', {}, providerName(p.key)), h('span.list-meta', {}, p.accounts.length ? `${p.accounts.length} account${p.accounts.length === 1 ? '' : 's'}` : 'Not connected')),
                  p.connecting && !p.connecting.error ? null : h('button.btn.sm', { type: 'button', onclick: () => pressConnect(p) }, connectLabel(p)),
                ),
                p.accounts.length ? h('ul.subs-accounts', {}, ...p.accounts.map((a) => accountRow(a))) : null,
                connectingBlock(p, net),
              ),
            ),
          ),
        )
      : null;
    const setUp: HTMLElement[] = [];
    if (subscriptionsPhase(subs) === 'setting-up') {
      const installing = subs.proxy.phase === 'installing';
      if (installing) setUp.push(progressBar('Installing DroidProxy', subs.proxy.progress));
      setUp.push(waitLine(installing ? 'Installing DroidProxy…' : 'Starting DroidProxy…'));
    }
    content.replaceChildren(
      h('div.welcome-providers', {}, ...FEATURED_PROVIDERS.map((k) => featuredCard(providerOf(k)))),
      ...setUp,
      ...(updatesFirst() ? [h('p.note.warn', {}, UPDATES_FIRST_NOTE)] : []),
      ...(subs.proxy.error ? [h('p.note.bad', { role: 'alert' }, subs.proxy.error)] : []),
      ...(more ? [more] : []),
      h('p.field-hint', {}, 'Optional. You can connect plans later in Settings → Connections.'),
    );
  };

  const paintReady = (content: HTMLElement) => {
    loadModels();
    preselect();
    content.replaceChildren(
      droidReady(store.setup)
        ? h('p.welcome-next', {}, 'Then walk up to an empty desk and press ', h('span.key', {}, 'E'), ' to hire your first worker.')
        : h('p.note.info', {}, 'Droid needs to be installed and signed in first. The steps above do both.'),
    );
  };

  const start = () => {
    const change = defaultWorkerChange(picker.value(), officeChoice());
    if (change !== undefined) net.send({ t: 'prompts.agent', choice: change });
    modal.close();
    toast(HIRE_HINT);
  };

  const run = (a: WelcomeAction) => {
    switch (a.kind) {
      case 'install':
        return net.send({ t: 'setup.droid.install' });
      case 'check':
        return net.send({ t: 'setup.check' });
      case 'signIn':
        return net.send({ t: 'setup.droid.signIn' });
      case 'next':
        return view(null);
      case 'start':
        return start();
    }
  };

  const paintFooter = (at: WelcomeStepId) => {
    const plan = stepPlan(at, store.setup, store.subscriptions);
    secondary.classList.toggle('hidden', !plan.secondary);
    secondary.textContent = plan.secondary?.label ?? '';
    secondary.onclick = () => {
      if (plan.secondary?.kind === 'skip') {
        skipped.add(at);
        view(null);
      } else if (plan.secondary?.kind === 'cancelSignIn') net.send({ t: 'setup.droid.signInCancel' });
    };
    const a = plan.primary;
    const next = JSON.stringify(a);
    if (next === primaryKey) return;
    primaryKey = next;
    if (!a) return primarySlot.replaceChildren();
    if (a.kind === 'openSignIn') return primarySlot.replaceChildren(h('a.btn.accent', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, a.label));
    const busy = a.kind === 'busy';
    const btn = h('button.btn.accent', { type: 'button', disabled: busy || a.kind === 'blocked', title: a.kind === 'blocked' ? a.why : undefined, onclick: () => run(a) }, busy ? h('span.spinner', { 'aria-hidden': 'true' }) : null, a.label);
    primarySlot.replaceChildren(btn);
  };

  const paint = () => {
    if (viewing && !viewingWasDone && stepDone(viewing, store.setup, store.subscriptions)) viewing = null;
    const at = shown();
    paintNav(at);
    for (const [id, p] of panes) p.el.classList.toggle('hidden', id !== at || !welcomeSteps(store.subscriptions).includes(id));
    const content = panes.get(at)!.content;
    if (at === 'droid') paintDroid(content);
    else if (at === 'factory') paintFactory(content);
    else if (at === 'subscriptions') paintSubscriptions(content);
    else paintReady(content);
    if (at !== 'subscriptions') subsKey = '';
    paintFooter(at);
  };

  const offs = [store.on('setup', paint), store.on('subscriptions', paint), store.on('prompts', preselect)];
  // The "resets in" lines age while the window stays open.
  const timer = setInterval(paint, 30_000);
  const modal = openModal(el, {
    size: 'lg',
    doing: '👋 setting up the office',
    // A stray click shouldn't lose a sign-in in progress; ✕ and Esc still close it.
    backdropCloses: false,
    onClose: () => {
      current = null;
      closedHere = true;
      // Closed once Droid can run, with Start or not, the welcome is done: the steps left are optional.
      if (droidReady(store.setup) && !store.setup.onboarded) net.send({ t: 'setup.onboarded', done: true });
      picker.close();
      clearInterval(timer);
      for (const off of offs) off();
    },
  });
  current = modal;
  paint();
}
