import { emptyWakeFilterTelemetry, FLOOR_MOOD_LIGHTING, GEMINI_AI_STUDIO_KEYS_URL, GEMINI_DECISIONS_MODEL } from '../../shared/gemini-vibes';
import { AIRGAPPED_REASON } from '../../shared/setup';
import type { Net } from '../net';
import { store } from '../state';
import { h, timeAgo } from './dom';
import { toggle } from './kit';

/**
 * ⚙️ Settings → Connections → "Gemini Decisions API": connects a Google AI Studio key (kept in mode
 * 0600 `.droid-office/gemini.json`), toggles Living 3D Reactions & Mood Lighting, and displays live
 * view-aware cost-gating telemetry (`$0.00` whenever no 3D floor is open and visible).
 */
export function geminiSettings(net: Net): { card: { desc: Node; below: Node[] }; dispose: () => void } {
  const keyInput = h('input.input', {
    type: 'password',
    placeholder: 'AIza…',
    'aria-label': 'Gemini API key',
    spellcheck: 'false',
    autocomplete: 'new-password',
  }) as HTMLInputElement;
  const connect = h('button.btn.primary', { type: 'button' }, 'Connect') as HTMLButtonElement;
  const cancel = h('button.btn.ghost', { type: 'button' }, 'Cancel');
  const form = h('div.row.wrap', {}, h('div.input-group.grow', {}, keyInput, connect), cancel);

  const intro = h(
    'small.factory-intro',
    {},
    'Powers Living 3D worker postures, micro-reactions, monitor spill and room mood lighting (strictly paused whenever no 3D floor is visible), plus the inter-agent noise gate that decides when subagent news wakes a lead, with ',
    h('code', {}, GEMINI_DECISIONS_MODEL),
    ' (zero output tokens). Get a key at ',
    h('a', { href: GEMINI_AI_STUDIO_KEYS_URL, target: '_blank', rel: 'noopener noreferrer' }, 'aistudio.google.com/apikey'),
    '; it stays on this machine.',
  );

  const who = h('span.factory-who');
  const facts = h('span.setting-meta');
  const summary = h('small.stack.tight', {}, who, facts);

  const vibesToggle = toggle({
    label: 'Living 3D reactions & mood lighting',
    description:
      "Gemini reads what each desk's output means for its task (on track or in trouble, stuck or in flow, how much is riding on it, how close it is to done, corners cut, rabbit holes, desks at cross purposes) and the room answers with glowing desk rings and progress arcs, emoji pops, room-wide flashes, breathing mood light and lively postures. Hires, finished tasks, pull requests, send-offs and shots play their own effects. Graded in one shared forward pass only while a 3D floor is open and uncovered; the pedestal button beneath each floor’s ceiling glyph flips it too.",
    checked: true,
    onChange: (on) => {
      failure = '';
      net.send({ t: 'gemini.vibes', on });
    },
  });

  const wakeToggle = toggle({
    label: 'Inter-agent noise gate & smart wakeup filter',
    description:
      'Holds clean completions until a batch of running teammates settles, records routine updates without waking the lead, and skips sibling notes that do not concern them. Questions, blockers, failures and new pull requests wake the lead at once, and every report stays readable in team status.',
    checked: true,
    onChange: (on) => {
      failure = '';
      net.send({ t: 'gemini.wakeFilter', on });
    },
  });
  const wakeStats = h('p.setting-note.info');

  const liveGate = h('p.setting-note.info');
  const rejected = h('p.note.bad');
  const error = h('p.note.bad', { role: 'alert' });

  const check = h('button.btn.sm', { type: 'button' }, 'Check again') as HTMLButtonElement;
  const replace = h('button.btn.sm', { type: 'button' }, 'Replace key');
  const remove = h('button.btn.sm.danger', { type: 'button' }, 'Disconnect');
  const actions = h('div.row.wrap', {}, check, replace, remove);
  const modeNote = h('p.note.info', {}, AIRGAPPED_REASON, ' Existing credentials are kept.');

  let busy = false;
  let replacing = false;
  let failure = '';

  const paint = () => {
    modeNote.classList.toggle('hidden', !store.setup.airgapped);
    if (store.setup.airgapped) {
      for (const el of [intro, summary, form, vibesToggle, wakeToggle, wakeStats, liveGate, error, rejected, actions]) el.classList.add('hidden');
      return;
    }

    const g = store.gemini;
    const editing = !g.connected || replacing;
    for (const el of [summary, vibesToggle, wakeToggle, wakeStats, liveGate, rejected, actions]) el.classList.toggle('hidden', !g.connected || replacing);
    form.classList.toggle('hidden', !editing);
    intro.classList.toggle('hidden', !editing);
    cancel.classList.toggle('hidden', !g.connected);
    connect.disabled = busy;
    if (busy) connect.textContent = 'Checking…';
    else if (g.connected) connect.textContent = 'Use this key';
    else connect.textContent = 'Connect';
    keyInput.disabled = busy;
    error.classList.toggle('hidden', !failure);
    error.textContent = failure;
    if (!g.connected) return;

    who.textContent = `Connected to ${GEMINI_DECISIONS_MODEL}`;
    facts.textContent = [g.fingerprint ? `Key ${g.fingerprint}` : '', g.at ? `connected ${timeAgo(g.at)}` : '', g.checking ? 'checking now…' : g.checkedAt ? `checked ${timeAgo(g.checkedAt)}` : ''].filter(Boolean).join(' · ');

    vibesToggle.input.checked = g.vibesOn;
    wakeToggle.input.checked = g.wakeFilterOn;
    const w = g.wakeFilter ?? emptyWakeFilterTelemetry();
    const routed = w.held + w.silent + w.blocked;
    const saved = w.evaluated ? Math.round((routed / w.evaluated) * 100) : 0;
    const gating = Boolean(g.wakeFilterOn && !g.rejected);
    wakeStats.classList.toggle('good', gating);
    wakeStats.classList.toggle('info', !gating);
    if (!g.wakeFilterOn) {
      wakeStats.textContent = 'Noise gate off: every report, note and update wakes its lead at once, as before.';
    } else if (w.evaluated > 0) {
      const failed = w.failedOpen ? ` · ${w.failedOpen} delivered as before after a failed call` : '';
      const latency = w.lastLatencyMs !== undefined ? ` · ${w.lastLatencyMs} ms` : '';
      wakeStats.textContent = `Noise gate routed ${w.evaluated.toLocaleString()} ${w.evaluated === 1 ? 'message' : 'messages'} · ${w.woken} woke · ${w.held} held for batch · ${w.silent} recorded silently · ${w.blocked} coached · ${w.siblingFiltered} sibling interrupts skipped · ${saved}% wakeups saved · ${(w.inputTokens ?? 0).toLocaleString()} input tokens, 0 output tokens${failed}${latency}`;
    } else {
      wakeStats.textContent = 'Noise gate on: waiting for the first team report, note or update.';
    }
    rejected.classList.toggle('hidden', !g.rejected);
    rejected.textContent = g.rejected ? `Key rejected: Google AI Studio turned it down (${g.rejected}). Living 3D pulses are paused until you check again or replace the key.` : '';

    const moodLabel = store.vibes ? FLOOR_MOOD_LIGHTING[store.vibes.mood]?.label : undefined;
    const usageTail = `${g.calls.toLocaleString()} ${g.calls === 1 ? 'call' : 'calls'} · ${g.inputTokens.toLocaleString()} input tokens · 0 output tokens${g.lastLatencyMs !== undefined ? ` · ${g.lastLatencyMs} ms` : ''}`;
    const live = g.vibesOn && g.watching3d > 0;
    liveGate.classList.toggle('good', live);
    liveGate.classList.toggle('info', !live);
    if (!g.vibesOn) {
      liveGate.textContent = `Off: the 3D office stays neutral, with no rings, flashes or reactions ($0.00 active spend) · ${usageTail}`;
    } else if (live) {
      liveGate.textContent = `On: live on ${g.watching3d} visible 3D ${g.watching3d === 1 ? 'view' : 'views'}${moodLabel ? ` (${moodLabel})` : ''} · ${usageTail}`;
    } else {
      liveGate.textContent = `On, view-gated pause ($0.00): no 3D floor is open and visible right now · ${usageTail}`;
    }
    if (g.lastError && !g.rejected && !failure) {
      liveGate.textContent += ` · Last note: ${g.lastError}`;
    }

    const locked = busy || Boolean(g.checking);
    check.disabled = locked;
    replace.disabled = locked;
    remove.disabled = locked;
    check.textContent = g.checking ? 'Checking…' : 'Check again';
  };

  const send = () => {
    const key = keyInput.value.trim();
    if (!key) return keyInput.focus();
    busy = true;
    failure = '';
    net.send({ t: 'gemini.connect', key });
    paint();
  };

  connect.addEventListener('click', send);
  keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
  cancel.addEventListener('click', () => {
    replacing = false;
    failure = '';
    keyInput.value = '';
    paint();
  });
  replace.addEventListener('click', () => {
    replacing = true;
    failure = '';
    paint();
    keyInput.focus();
  });
  check.addEventListener('click', () => {
    failure = '';
    net.send({ t: 'gemini.check' });
  });
  remove.addEventListener('click', () => {
    if (confirm('Disconnect Gemini Decisions? The office forgets the key and resets 3D worker postures and room mood lighting to neutral.')) {
      net.send({ t: 'gemini.disconnect' });
    }
  });

  const offSetup = net.onMessage((msg) => {
    if (msg.t !== 'gemini.setup') return;
    busy = false;
    failure = msg.error ?? '';
    if (msg.ok) {
      replacing = false;
      keyInput.value = '';
    }
    paint();
  });
  const offGemini = store.on('gemini', paint);
  const offVibes = store.on('vibes', paint);
  const offSetupMode = store.on('setup', paint);
  const timer = setInterval(paint, 30_000);
  paint();

  return {
    card: { desc: h('span.stack.tight', {}, intro, summary), below: [modeNote, form, error, rejected, vibesToggle, liveGate, wakeToggle, wakeStats, actions] },
    dispose: () => {
      offSetup();
      offGemini();
      offVibes();
      offSetupMode();
      clearInterval(timer);
    },
  };
}
