import type { Net } from '../net';
import { store } from '../state';
import { AIRGAPPED_FEATURES, AIRGAPPED_NETWORK_NOTE, droidUpdateAvailable } from '../../shared/setup';
import { h } from './dom';
import { toggle } from './kit';
import { openWelcome } from './welcome';
import { progressBar, signInPanel, waitLine } from './welcome-signin';

/** Droid's version and account in one line. */
function droidFacts(): string {
  const d = store.setup.droid;
  if (!d.path) return d.busy === 'checking' ? 'Looking for Droid…' : 'Not installed on the office’s computer.';
  const version = d.version ? `Version ${d.version}` : 'Installed';
  const who = store.setup.airgapped ? 'airgapped · no Factory account' : d.signedIn === true ? `signed in as ${d.account ?? 'your Factory account'}` : d.signedIn === false ? 'not signed in' : 'sign-in unknown';
  return `${version} · ${who}`;
}

/**
 * ⚙️ Settings → Connections → "Droid": the version and Update to …, who it's signed in as or Sign in
 * (with the welcome's code panel), and Check again. Without Droid it opens the welcome.
 */
export function droidSettings(net: Net): { parts: { desc: Node; control: Node; below: Node[] }; dispose: () => void } {
  const facts = h('small.subs-meta');
  const controls = h('div.row.wrap');
  const busyLine = h('div');
  const error = h('p.note.bad', { role: 'alert' });
  const signIn = signInPanel(net, { actions: true });
  const mode = toggle({ label: 'Airgapped mode', description: 'Use local or BYOK models without a Factory account. Existing credentials are kept.', onChange: (on) => net.send({ t: 'setup.airgapped', on }) });
  const modeNote = h('p.note.info', {}, AIRGAPPED_FEATURES, ' ', AIRGAPPED_NETWORK_NOTE);
  const modelsNote = h('p.note.warn', {}, 'Add a custom model to ~/.factory/settings.json (customModels), or connect DroidProxy below. Then choose it in Settings → Models and press Check again.');
  const button = (label: string, onclick: () => void, cls = '', disabled = false) => h('button.btn.sm', { type: 'button', class: cls, disabled, onclick }, label);

  const paint = () => {
    const d = store.setup.droid;
    mode.input.checked = !!store.setup.airgapped;
    modeNote.classList.toggle('hidden', !store.setup.airgapped);
    modelsNote.classList.toggle('hidden', !store.setup.airgapped || !!store.setup.customModels?.length);
    facts.textContent = droidFacts();
    facts.title = d.path ?? '';
    const buttons: HTMLElement[] = [];
    if (!d.path && d.busy !== 'installing') {
      if (d.busy !== 'checking') buttons.push(button('Set up Droid…', () => openWelcome(net), 'primary'));
    } else if (d.busy === 'installing') buttons.push(button('Installing…', () => {}, '', true));
    else {
      if (droidUpdateAvailable(d)) buttons.push(button(`Update to ${d.latest}`, () => net.send({ t: 'setup.droid.install' }), 'primary'));
      if (!store.setup.airgapped && d.signedIn !== true && d.busy !== 'signing-in') buttons.push(button('Sign in', () => net.send({ t: 'setup.droid.signIn' }), 'primary'));
    }
    if (d.busy !== 'signing-in' && d.busy !== 'installing') buttons.push(button(d.busy === 'checking' ? 'Checking…' : 'Check again', () => net.send({ t: 'setup.check' }), '', d.busy === 'checking'));
    controls.replaceChildren(...buttons);
    busyLine.replaceChildren(...(d.busy === 'installing' ? [progressBar('Installing Droid', d.progress), waitLine('Downloading and checking Droid…')] : []));
    error.textContent = d.error ?? '';
    signIn.paint();
  };
  paint();
  const off = store.on('setup', paint);
  return {
    parts: {
      desc: h('span.stack.tight', {}, h('small', {}, 'The coding agent every worker runs, with a Factory account or your own models.'), facts),
      control: controls,
      below: [mode, modeNote, modelsNote, signIn.element, busyLine, error],
    },
    dispose: off,
  };
}
