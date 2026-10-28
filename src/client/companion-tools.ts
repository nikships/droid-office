// The office's management tools for a companion (the web companion's tool rail, the Android app's
// Management view): the same windows the 3D office opens, with what main.ts wires them to ported
// here without the scene, one tool at a time inside the companion's own `mount`. No three.js may be
// imported from here (tests/android-companion-tools.test.ts checks the built bundle).
//
// Lifecycle, so nothing outlives the floor or connection it was made on:
// - A floor tool or a worker tool closes when the floor changes (Net.onReady(false)), with every
//   dialog it opened. If the switch is refused and the old floor comes back, it opens again, fresh.
// - An office tool stays open across a floor change.
// - On an actual connection loss everything closes, unsent Whiteboard batches are discarded (never
//   resent), and only the descriptor is kept: the tool opens again, empty, once the office is ready.

import { AUTO_DESK } from '../shared/protocol';
import type { AgentEffort, ServerMsg, WorkerInfo } from '../shared/protocol';
import { TOOL_BY_ID, TOOLS, toolAvailability, workerActions as workerActionList, type ToolArgs, type ToolContext, type ToolGroup, type ToolId, type ToolScope, type WorkerAction, type WorkerActionId } from '../shared/companion-tools';
import { DESK_BY_ID, STATION_AGENT, nextFreeSeat } from '../shared/layout';
import { ciForFloor } from '../shared/factory-ci';
import { forgeOf, forgeWords, normalizeRepo, repoWebUrl } from '../shared/floors';
import { isLive } from '../shared/pipelines';
import { forgeVars } from '../shared/prompts';
import { resolveSettingsPane } from '../shared/settings-nav';
import { isAsleep, isBusy } from '../shared/status';
import { forkRefusal } from '../shared/worker-fork';
import { INCLUDE_FILE, SETUP_FILE, describeSetup } from '../shared/worktree-setup';
import { bindFactory } from './factory';
import type { Net } from './net';
import { connectWhiteboard, store, type Topic } from './state';
import { openAsk } from './ui/ask';
import { openBoard, type BoardActions } from './ui/boards';
import { openBookshelf, type ShelfTab } from './ui/bookshelf';
import { openChanges, routeChangesMessage } from './ui/changes';
import { openInline, toast, watchModals, type Modal } from './ui/dom';
import { openElevator, routeElevatorMessage } from './ui/elevator';
import { hireCloud, openCloudWindow, runsOnPicker, sendCloudHome } from './ui/factory-cloud';
import { openCiWindow } from './ui/factory-ci';
import { openComputers } from './ui/factory-computers';
import { routeFloorMenuMessage } from './ui/floormenu';
import { routeFolderMessage } from './ui/folder-browser';
import { openForkWorker } from './ui/fork-worker';
import { openHostUpdate } from './ui/host-update';
import { openTicket, routeJiraMessage } from './ui/jira';
import { openPipelines, routePipelinesMessage } from './ui/pipelines';
import { confirmDialog, lostWorktreeDialog, openPrompt, routeWorktreeMessage, sendHomeDialog } from './ui/prompt';
import { officePrompt, openPromptEditor } from './ui/prompts';
import { openIssue, openPull, routePullMessage } from './ui/pull';
import { openRepoPulls, workerRepos } from './ui/repos';
import { openSearch } from './ui/search';
import { openOfficeSettings } from './ui/settings';
import { STATION_INFO } from './ui/stations';
import { openSubscriptionsStatus } from './ui/subscriptions-status';
import { openUpgrade } from './ui/upgrade';
import { openWelcome } from './ui/welcome';
import { openWhiteboard, routeWhiteboardMessage, whiteboardChanged } from './ui/whiteboard';
import { officeFull, pressureNote } from './world/machine';

export type { ToolArgs, ToolId } from '../shared/companion-tools';

export interface ToolEntry {
  id: ToolId;
  icon: string;
  label: string;
  group: ToolGroup;
  scope: ToolScope;
  available: boolean;
  reason?: string;
  /** What's waiting in it: open issues, live runs, changed cards. */
  count?: number;
}

export type WorkerActionEntry = WorkerAction;
export type OpenResult = { ok: true } | { ok: false; reason: string };

export interface CompanionToolsDeps {
  net: Net;
  /** Where the open tool goes. */
  mount: HTMLElement;
  /** Go to another floor (the companion's own floor switch). */
  switchFloor(floorId: string): void;
  /** Show a worker in the companion's workspace. */
  openWorker(workerId: string, view: 'thread' | 'tty'): void;
  /** The list, its counts or the open tool changed. */
  onChange?(): void;
  /** A link out of the office; defaults to a new tab. */
  openExternal?(url: string): void;
}

export interface CompanionTools {
  /** Feed every server message through here, after store.apply. */
  route(msg: ServerMsg): void;
  list(): ToolEntry[];
  open(id: ToolId, args?: ToolArgs): OpenResult;
  close(): void;
  current(): { id: ToolId; args: ToolArgs } | null;
  workerActions(workerId: string): WorkerActionEntry[];
  runWorkerAction(workerId: string, id: WorkerActionId): Promise<OpenResult>;
  dispose(): void;
}

/** The Pipeline agent's kiosk. */
const PIPELINES_DESK = 'station-actions';
const CHANGE_TOPICS: Topic[] = ['workers', 'issues', 'pulls', 'pipelines', 'factory', 'floors', 'floor', 'project', 'jira', 'upgrade', 'whiteboard', 'machine'];

let bound: Net | null = null;

export function createCompanionTools(deps: CompanionToolsDeps): CompanionTools {
  const { net } = deps;
  const changed = () => deps.onChange?.();
  const external = (url: string) => (deps.openExternal ? deps.openExternal(url) : void window.open(url, '_blank', 'noopener'));

  // The Factory watches and the Whiteboard's batches go through this page's connection.
  if (bound !== net) {
    bound = net;
    bindFactory(net);
    connectWhiteboard((msg) => net.send(msg));
  }

  interface Open {
    id: ToolId;
    args: ToolArgs;
    floor: string | null;
    modal: Modal;
  }
  let shown: Open | null = null;
  /** What to open again once the office is ready: after a connection loss, or a floor switch that may be refused. */
  let resume: { id: ToolId; args: ToolArgs; floor: string | null; any: boolean } | null = null;
  /** Every dialog a tool or a worker action opened, closed with it when its floor or connection goes. */
  const owned = new Set<Modal>();
  /** Set while a click or key inside a tool is being handled: windows it opens belong to the tools. */
  let inTool = 0;

  const ownedTarget = (t: EventTarget | null) => t instanceof Node && (deps.mount.contains(t) || [...owned].some((m) => m.backdrop.contains(t)));
  const onInput = (e: Event) => {
    if (!ownedTarget(e.target)) return;
    inTool++;
    setTimeout(() => inTool--, 0);
  };
  for (const type of ['click', 'keydown', 'submit', 'change']) window.addEventListener(type, onInput, true);
  let capturing = 0;
  const offWatch = watchModals((m) => {
    if (!capturing && !inTool) return;
    for (const o of owned) if (!o.backdrop.isConnected) owned.delete(o);
    owned.add(m);
  });
  /** Runs `fn`, owning every window it opens. */
  const owning = <T>(fn: () => T): T => {
    capturing++;
    try {
      return fn();
    } finally {
      capturing--;
    }
  };
  const closeOwned = () => {
    for (const m of [...owned]) m.close();
    owned.clear();
  };

  const ctx = (args: ToolArgs = {}): ToolContext => {
    const w = args.workerId ? store.workers.get(args.workerId) : undefined;
    return {
      ready: net.ready,
      floor: store.floor,
      plainFloor: !!store.currentFloor()?.plain,
      factoryConnected: store.factory.connection.connected,
      jiraEpic: !!store.jira.epic,
      upgradeAvailable: store.upgrade.available,
      ...(w ? { worker: { kind: w.kind, cloud: !!w.cloud, guest: !!w.guest, lost: !!w.lost } } : {}),
    };
  };

  // ---- What main.ts does for the windows, without a scene -------------------------------------------

  const floorGithubRepo = () => {
    const repo = normalizeRepo(store.project?.remote);
    return repo && repo.split('/').length === 2 ? repo : undefined;
  };
  const blobBase = () => {
    const repo = normalizeRepo(store.project?.remote);
    if (!repo) return undefined;
    const forge = forgeOf(repo);
    return { url: `${repoWebUrl(repo)}${forge === 'gitlab' ? '/-' : ''}/blob/HEAD`, site: forgeWords(forge).site };
  };
  const repoChoices = () => store.floors.filter((f) => f.id !== store.floor && f.branch).map((f) => ({ id: f.id, name: f.name }));
  const freeSeat = () => nextFreeSeat((id) => !!store.workerAtDesk(id))?.id;
  const officeIsFull = (): boolean => {
    const m = store.machine;
    if (!officeFull(m)) return false;
    toast(`🚫 The office is at its limit of ${m.limit} worker${m.limit === 1 ? '' : 's'}. Send one home before hiring another.`, 'warn');
    return true;
  };
  /** A business action, confirmed by the office: undefined when done, else why not (shown in the box). */
  const confirmed = async (msg: Parameters<Net['request']>[0]): Promise<string | undefined> => {
    const r = await net.request(msg);
    return r.ok ? undefined : (r.error ?? 'The office did not confirm it. Check before trying again.');
  };
  const hire = (deskId: string, prompt: string | undefined, o: { worktree?: boolean; model?: string; effort?: AgentEffort; repos?: string[]; images?: string[] }, issue?: number) =>
    confirmed({
      t: 'worker.spawn',
      deskId,
      prompt,
      worktree: o.worktree,
      model: o.model,
      effort: o.effort,
      issue,
      repos: o.repos?.length ? o.repos : undefined,
      images: o.images?.length ? o.images : undefined,
    });

  const hireDialog = (args: ToolArgs, task?: { title: string; subtitle: string; initial: string; worktree?: boolean }) => {
    if (args.kind === 'station' && args.deskId) return askStation(args.deskId);
    if (officeIsFull()) return;
    const deskId = args.deskId ?? AUTO_DESK;
    const where = args.deskId ? ` at ${DESK_BY_ID.get(args.deskId)?.label ?? 'that desk'}` : '';
    if (args.kind === 'shell') {
      confirmDialog(`Open a shell${where}?`, 'A shared shell sits at a free desk on this floor, in the floor’s checkout.', 'Open shell', () => {
        void confirmed({ t: 'worker.spawn', deskId, kind: 'shell' }).then((error) => error && toast(error, 'warn'));
      });
      return;
    }
    // Cloud hires name their desk; the office picks the first free one for a local hire itself.
    const cloudDesk = args.deskId ?? freeSeat();
    openPrompt({
      title: task?.title ?? `✨ Hire a worker${where}`,
      subtitle: task?.subtitle ?? 'Pick its model. You can start with an empty prompt and send work later. It takes the first free desk.',
      warning: pressureNote(store.machine),
      placeholder: 'Optional first task…',
      initial: task?.initial,
      submitLabel: 'Hire & start',
      allowEmpty: !task,
      modelOption: true,
      worktreeOption: task?.worktree ?? (!store.currentFloor()?.home && !!store.project?.branch),
      worktreeChecked: task?.worktree,
      imagesOption: true,
      deskId: args.deskId,
      repoOptions: repoChoices(),
      runsOn: cloudDesk ? runsOnPicker() : null,
      onCloud: (text, o) => (cloudDesk ? hireCloud(cloudDesk, text, o) : Promise.resolve('Every desk is taken')),
      onSubmit: (text, o) => hire(deskId, text || undefined, o),
    });
  };

  const hireForWorktreeSetup = () => {
    const now = store.worktreeSetup ? describeSetup(store.worktreeSetup.resolved) : 'runs what the office detects from its lockfiles';
    close();
    owning(() =>
      hireDialog(
        {},
        {
          title: '🌿 Set up worktrees',
          subtitle: 'A worker writes this repository’s worktree setup, tests it, and opens a pull request with it.',
          initial: officePrompt('worktree.setup', { file: SETUP_FILE, include: INCLUDE_FILE, now, ...forgeVars(store.project?.forge) }),
          worktree: true,
        },
      ),
    );
  };

  /** A prompt from the boards: to a new worker, or to one already at a desk. */
  const sendToWorker = (title: string, text: { context?: string; initial?: string }, issue?: number) => {
    const desk = freeSeat();
    const awake = [...store.workers.values()].filter((w) => (w.kind === 'agent' || (w.kind === 'cloud' && !w.cloud?.error)) && !w.guest && !isAsleep(w.status));
    if (!desk && !awake.length) return toast('Every desk and bean bag is taken. Send a worker home first.', 'warn');
    openAsk({
      title,
      ...text,
      newDesk: desk ? 'the first free desk' : undefined,
      workers: awake.map((w) => ({ id: w.id, name: w.name, color: w.color, status: w.status })),
      worktreeOption: !store.currentFloor()?.home && !!store.project?.branch,
      modelOption: true,
      repoOptions: repoChoices(),
      onSubmit: (prompt, to, worktree, model, effort, repos, images) => {
        const done = to ? confirmed({ t: 'worker.prompt', workerId: to, prompt, issue, images: images?.length ? images : undefined }) : hire(AUTO_DESK, prompt, { worktree, model, effort, repos, images }, issue);
        void done.then((error) => error && toast(error, 'warn'));
      },
    });
  };
  const boardActions = (): BoardActions => ({
    assign: (prompt, title, issue) => sendToWorker(`🤖 ${title}`, { initial: prompt }, issue),
    ask: (context, title) => sendToWorker(`✍️ ${title}`, { context }),
    openWorker: (workerId) => deps.openWorker(workerId, 'thread'),
  });

  function askStation(deskId: string, initial?: string) {
    const kind = DESK_BY_ID.get(deskId)?.station;
    if (!kind) return;
    const w = store.workerAtDesk(deskId);
    const name = STATION_AGENT[kind].name;
    const info = STATION_INFO[kind];
    if (w?.status === 'needs_input') {
      toast(`The ${name} is waiting on an answer. Here it is.`, 'warn');
      return deps.openWorker(w.id, 'tty');
    }
    if (!w && officeIsFull()) return;
    openPrompt({
      title: `${info.icon} Ask the ${name}`,
      subtitle: !w
        ? `${info.does}, in a terminal of my own.`
        : isAsleep(w.status)
          ? `The ${name} is asleep: this wakes it up, and it carries on where it left off.`
          : isBusy(w.status)
            ? `The ${name} is busy. Your prompt waits in its input box until it's done.`
            : undefined,
      placeholder: `e.g. ${info.example}`,
      initial,
      submitLabel: 'Send ✨',
      warning: w ? undefined : pressureNote(store.machine),
      modelOption: !w,
      imagesOption: true,
      deskId,
      onSubmit: (text, o) => net.send({ t: 'station.prompt', deskId, prompt: text, model: o.model, effort: o.effort, images: o.images.length ? o.images : undefined }),
    });
  }

  const killWorker = (id: string) => {
    const w = store.workers.get(id);
    if (!w) return;
    if (w.cloud) return sendCloudHome(net, w);
    const where = DESK_BY_ID.get(w.deskId)?.label ?? 'the desk';
    const session = w.kind === 'shell' ? 'shared shell' : 'Droid session';
    const report = (error: string | undefined) => error && toast(error, 'warn');
    if (w.worktree) {
      return sendHomeDialog({
        workerId: id,
        name: w.name,
        where,
        worktree: w.worktree,
        repos: w.repos?.length ? [w.worktree.path.split(/[\\/]/).pop() ?? 'its own', ...w.repos.map((r) => r.name)] : undefined,
        ask: () => net.send({ t: 'worker.worktree', workerId: id }),
        onConfirm: (cleanup) => void confirmed({ t: 'worker.kill', workerId: id, cleanup }).then(report),
      });
    }
    const body = DESK_BY_ID.get(w.deskId)?.station
      ? `This stops its ${session} for everyone, and it forgets what it was asked. The next prompt to it starts a fresh one.`
      : `This stops the ${session} at ${where} for everyone and frees the desk.`;
    confirmDialog(`Send ${w.name} home?`, body, 'Send home', () => void confirmed({ t: 'worker.kill', workerId: id }).then(report));
  };

  const fixLostWorktree = (w: WorkerInfo) => {
    if (!w.lost || !w.worktree) return;
    const others = [...store.workers.values()].filter((o) => o.lost && o.id !== w.id);
    lostWorktreeDialog({
      name: w.name,
      worktree: w.worktree,
      lost: w.lost,
      workspace: w.repos?.length ? w.worktree.path.replace(/[\\/][^\\/]*$/, '') : undefined,
      others: others.map((o) => o.name),
      openTerminal: isAsleep(w.status) ? undefined : () => deps.openWorker(w.id, 'tty'),
      rebuild: (all) => {
        toast(all ? `Rebuilding ${others.length + 1} worktrees…` : `Rebuilding ${w.name}'s worktree…`);
        net.send({ t: 'worker.rebuild', workerId: w.id, all });
      },
      sendHome: () => killWorker(w.id),
    });
  };

  const openPullFor = (number: number, url: string) => {
    const it = store.pulls.items.find((p) => p.number === number);
    if (it) openPull(it, net, boardActions());
    else external(url);
  };
  const pullRequestFor = (w: WorkerInfo): string | undefined => {
    const push = () => {
      const now = store.workers.get(w.id);
      if (!now || now.prOpening) return;
      toast(`Pushing ${now.worktree?.branch ?? 'its branch'} and opening a pull request…`);
      void confirmed({ t: 'worker.pr', workerId: now.id }).then((error) => error && toast(error, 'warn'));
    };
    if (w.repos?.length && workerRepos(w).some((r) => r.pr)) {
      openRepoPulls(w.id, { openPull: openPullFor, openMissing: push, changes: (repo) => void open('changes', { workerId: w.id, repo }) });
      return undefined;
    }
    if (w.pr) return void openPullFor(w.pr.number, w.pr.url);
    push();
    return undefined;
  };

  const bringInGuest = (w: WorkerInfo) => {
    const g = w.guest;
    if (!g) return;
    const body = `Its droid on ${g.tty} quits, and that terminal goes back to the shell. ${w.name} then carries on the same session at this desk, as one of the office's workers: you type to it here.`;
    confirmDialog(`Bring ${w.name} into the office?`, body, 'Bring it in', () => {
      net.send({ t: 'guest.bringIn', workerId: w.id });
      const { deskId } = w;
      const off = store.on('workers', () => {
        const now = store.workerAtDesk(deskId);
        if (!now || now.guest) return;
        off();
        deps.openWorker(now.id, 'tty');
      });
      setTimeout(off, 15_000);
    });
  };

  // ---- Tools -------------------------------------------------------------------------------------------

  const settings = (pane?: string) => void open('settings', pane ? { pane } : {});
  const shelf = (tab: ShelfTab) => {
    if (!store.floor) return;
    openBookshelf({ floor: store.floor, project: store.project?.name, blob: blobBase(), onTurn: () => {}, tab, openFactorySettings: () => settings('connections') });
  };
  const OPENERS: Record<ToolId, (a: ToolArgs) => void> = {
    issues: (a) => {
      const it = a.number ? store.issues.items.find((i) => i.number === a.number) : undefined;
      if (it) openIssue(it, net, boardActions());
      else openBoard('issues', net, boardActions(), 'issues');
    },
    pulls: (a) => {
      const it = a.number ? store.pulls.items.find((p) => p.number === a.number) : undefined;
      if (it) openPull(it, net, boardActions());
      else openBoard('pulls', net, boardActions());
    },
    jira: (a) => {
      const t = a.card ? store.jiraBoard?.items.find((x) => x.key === a.card) : undefined;
      if (t) openTicket(t, { assign: (prompt, title) => sendToWorker(`🤖 ${title}`, { initial: prompt }) });
      else openBoard('issues', net, boardActions(), 'jira');
    },
    pipelines: (a) => openPipelines(net, { askAgent: (initial) => askStation(PIPELINES_DESK, initial) }, a.runId ? { runId: a.runId } : {}),
    ci: () => void openCiWindow({ floorRepo: floorGithubRepo() }),
    changes: (a) => a.workerId && openChanges(net, a.workerId, () => a.workerId && deps.openWorker(a.workerId, 'tty'), a.repo),
    docs: () => shelf('docs'),
    wiki: () => shelf('wiki'),
    computers: (a) => openComputers({ settings: () => settings('connections'), id: a.card }),
    environments: (a) => openComputers({ settings: () => settings('connections'), tab: 'environments', envId: a.card }),
    cloud: (a) => a.workerId && openCloudWindow(net, a.workerId),
    floors: () => openElevator({ net, ride: (id) => deps.switchFloor(id) }),
    settings: (a) => openOfficeSettings(net, { first: resolveSettingsPane(a.pane), hireForSetup: hireForWorktreeSetup }),
    prompts: (a) => (a.pane ? openPromptEditor(net, a.pane as Parameters<typeof openPromptEditor>[1]) : openPromptEditor(net)),
    subscriptions: () => openSubscriptionsStatus(),
    'host-update': () => openHostUpdate(),
    upgrade: () => openUpgrade(net),
    welcome: () => openWelcome(net),
    whiteboard: (a) => openWhiteboard(net, { card: a.card, queueOffline: false }),
    search: () => openSearch((workerId) => deps.openWorker(workerId, 'tty')),
    hire: (a) => hireDialog(a),
  };

  function open(id: ToolId, args: ToolArgs = {}): OpenResult {
    const def = TOOL_BY_ID.get(id);
    if (!def) return { ok: false, reason: 'There is no such tool.' };
    const a = toolAvailability(id, ctx(args), args);
    if (!a.available) return { ok: false, reason: a.reason };
    close();
    resume = null;
    let modal: Modal | undefined;
    owning(() => {
      modal = openInline(
        deps.mount,
        () => OPENERS[id](args),
        () => {
          if (shown?.modal !== modal) return;
          shown = null;
          changed();
        },
      );
    });
    if (!modal) {
      // It opened a dialog over the page instead (hire, ask), or said why not in a toast.
      changed();
      return owned.size ? { ok: true } : { ok: false, reason: 'It did not open. Check the message the office showed.' };
    }
    owned.delete(modal);
    shown = { id, args, floor: store.floor, modal };
    changed();
    return { ok: true };
  }

  function close() {
    const was = shown;
    shown = null;
    closeOwned();
    was?.modal.close();
    if (was) changed();
  }

  const offs: (() => void)[] = [];
  offs.push(
    net.onReady((ready) => {
      if (!ready) {
        const lost = !net.up;
        if (lost) store.whiteboard.discardUnsent();
        const was = shown;
        if (was && (lost || TOOL_BY_ID.get(was.id)?.scope !== 'office')) {
          // The descriptor only: drafts and pending forms go with the window.
          resume = { id: was.id, args: was.args, floor: was.floor, any: TOOL_BY_ID.get(was.id)?.scope === 'office' };
          close();
        } else closeOwned();
        changed();
        return;
      }
      const again = resume;
      resume = null;
      if (again && !shown && (again.any || again.floor === net.floor)) {
        // A worker tool needs its worker still here.
        if (!again.args.workerId || store.workers.has(again.args.workerId)) open(again.id, again.args);
      }
      changed();
    }),
  );
  for (const t of CHANGE_TOPICS) offs.push(store.on(t, changed));

  const counts: Partial<Record<ToolId, () => number>> = {
    issues: () => store.issues.items.filter((i) => i.state === 'OPEN').length,
    pulls: () => store.pulls.items.filter((p) => p.state === 'OPEN').length,
    pipelines: () => store.pipelines.runs.filter((r) => isLive(r.state)).length,
    ci: () => ciForFloor(store.factory.ci, floorGithubRepo()).workflows.length,
    whiteboard: whiteboardChanged,
    computers: () => store.factory.computers.items.length,
    environments: () => store.factory.environments.items.length,
    floors: () => store.floors.reduce((n, f) => n + (f.id === store.floor ? 0 : f.waiting), 0),
  };

  function actionsFor(workerId: string): WorkerActionEntry[] {
    const w = store.workers.get(workerId);
    if (!w || !net.ready) return [];
    return workerActionList({
      kind: w.kind,
      asleep: isAsleep(w.status),
      busy: isBusy(w.status),
      cloud: !!w.cloud,
      guest: !!w.guest,
      cantBringIn: w.guest?.cantBringIn,
      lost: !!w.lost,
      worktree: !!w.worktree,
      prOpen: !!w.pr || workerRepos(w).some((r) => r.pr),
      prOpening: !!w.prOpening,
      repos: !!w.repos?.length,
      station: !!DESK_BY_ID.get(w.deskId)?.station,
      forkRefusal: forkRefusal(w),
      plainFloor: !!store.currentFloor()?.plain,
    });
  }

  return {
    route(msg) {
      routeChangesMessage(msg);
      routePullMessage(msg);
      routePipelinesMessage(msg);
      routeJiraMessage(msg);
      routeElevatorMessage(msg);
      routeFolderMessage(msg);
      routeFloorMenuMessage(msg);
      routeWhiteboardMessage(msg);
      if (msg.t === 'worker.worktree') routeWorktreeMessage(msg);
    },
    list() {
      const c = ctx();
      return TOOLS.filter((t) => t.listed).map((t) => {
        const a = toolAvailability(t.id, c);
        const n = a.available ? counts[t.id]?.() : undefined;
        return { id: t.id, icon: t.icon, label: t.label, group: t.group, scope: t.scope, available: a.available, ...(a.available ? {} : { reason: a.reason }), ...(n ? { count: n } : {}) };
      });
    },
    open,
    close,
    current: () => (shown ? { id: shown.id, args: shown.args } : null),
    workerActions: actionsFor,
    async runWorkerAction(workerId, id) {
      const w = store.workers.get(workerId);
      if (!w) return { ok: false, reason: 'That worker is not on this floor any more.' };
      const action = actionsFor(workerId).find((a) => a.id === id);
      if (!action) return { ok: false, reason: 'That is not something this worker can do.' };
      if (!action.available) return { ok: false, reason: action.reason ?? 'Not now.' };
      switch (id) {
        case 'changes':
          return open('changes', { workerId });
        case 'cloud':
          return open('cloud', { workerId });
        case 'resume': {
          if (w.lost) {
            owning(() => fixLostWorktree(w));
            return { ok: true };
          }
          const error = await confirmed({ t: 'worker.resume', workerId });
          return error ? { ok: false, reason: error } : { ok: true };
        }
        case 'fork':
          owning(() => openForkWorker(net, workerId));
          return { ok: true };
        case 'rebuild':
          owning(() => fixLostWorktree(w));
          return { ok: true };
        case 'send-home':
          owning(() => killWorker(workerId));
          return { ok: true };
        case 'pr':
          owning(() => pullRequestFor(w));
          return { ok: true };
        case 'bring-in':
          owning(() => bringInGuest(w));
          return { ok: true };
        case 'station-ask':
          owning(() => askStation(w.deskId));
          return { ok: true };
      }
    },
    dispose() {
      close();
      resume = null;
      offWatch();
      for (const type of ['click', 'keydown', 'submit', 'change']) window.removeEventListener(type, onInput, true);
      for (const off of offs) off();
    },
  };
}
