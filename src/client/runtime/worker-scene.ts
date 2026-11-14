import * as THREE from 'three';
import { beanbagsOut, DESK_BY_ID, vacantSeats } from '../../shared/layout';
import { type DeskMoment, isMonitorSpillTone, MONITOR_SPILL_HEX, MONITOR_SPILL_POWER, type MonitorSpillTone } from '../../shared/gemini-vibes';
import type { WorkerInfo } from '../../shared/protocol';
import type { VisitKind } from '../../shared/visits';
import { workerActivity, workerPr } from '../../shared/status';
import { forkLinks } from '../../shared/worker-fork';
import { teamLinks } from '../../shared/team';
import { cloudBadge } from '../../shared/factory-cloud';
import { missionWorker } from '../mission';
import { missionBadge, missionLinks, missionTeamBadge, missionView } from '../mission-office';
import { waitingOnSomeone, type DesktopNotifier } from '../notify';
import { groundAt, type PlayerController } from '../player';
import type { OfficeSound } from '../sound';
import type { store, words } from '../state';
import type { modelBadge } from '../ui/models';

import { Worker, type PrBadge } from '../world/character';
import { Laptop } from '../world/laptop';
import { Departures } from '../world/leaving';
import { Visitors } from '../world/visitors';
import { Casualties } from '../world/casualties';
import type { MissionAgentView, MissionRoom } from '../world/mission-control';
import type { TeamLines, TeamLink } from '../world/team-lines';
import { focusTeamKit } from '../world/team-kit';
import { plainLabel } from '../world/toon';
import { sayFor, trimSay } from '../world/visit-path';
import type { buildOffice, Collider, Interactable } from '../world/office';
import type { ScreenGlow, Sky } from '../world/sky';
export interface WorkerView {
  model: Worker;
  /** Its name, still there for a send-off after the store has dropped it. */
  name: string;
  laptop: Laptop;
  deskId: string;
  status: string;
  acked: boolean;
  /** The action last painted, so a new run of failures dings once. */
  action?: string;
  /** False until the first sync, so a failure already on screen doesn't ding when the page opens. */
  heard: boolean;
  worldReady?: boolean;
  /** Current and target monitor bounce-light spill color and brightness from Gemini Decision 1. */
  spillTone: MonitorSpillTone;
  spillColor: THREE.Color;
  spillTarget: THREE.Color;
  spillPower: number;
  spillPowerTarget: number;
  /** The pull request number last seen, so a newly opened one plays once. */
  pr?: number;
}

export interface WorkerSceneHost {
  scene: THREE.Scene;
  office: ReturnType<typeof buildOffice>;
  store: typeof store;
  player: PlayerController;
  sound: OfficeSound;
  notifier: DesktopNotifier;
  reduceMotion: MediaQueryList;
  mission: MissionRoom;
  teamLines: TeamLines;
  screenGlows: ScreenGlow[];
  sky: Sky;
  readonly vibeFxMoving: boolean;
  readonly lastWandShip: Map<string, number>;
  wandOut(): boolean;
  noOutline(object: THREE.Object3D): void;
  liftOnto(appeared: Collider[]): void;
  burstOver(deskId: string, count: number): void;
  deskMomentFx(id: string, view: WorkerView, kind: DeskMoment): void;
  shippedFx(id: string, view: WorkerView): void;
  renderWorkers(): void;
  modelBadge: typeof modelBadge;
  renderWaiting(): void;
  renderTitle(): void;
  renderWake(): void;
  words: typeof words;
}

/** Owns desk occupants, visitors, departures and Mission Control's scene representation. */
export function createWorkerScene(host: WorkerSceneHost) {
  const { scene, office, store, player, sound, notifier, reduceMotion, mission, teamLines, screenGlows, sky, noOutline, words } = host;
  const workerViews = new Map<string, WorkerView>();
  /** Workers a `worker.remove` is taking out of the store right now. They walk out of the building; a worker that's gone because you changed floors just vanishes. */
  const sentHome = new Set<string>();
  const shotWorkers = new Set<string>();
  // Workers sent home, packing up and walking out with a box of their things.
  const departures = new Departures(
    scene,
    (x, z, y) => groundAt(office.colliders, x, z, y),
    () => arrangeSeats(),
    () => office.stack.state.index > 0,
  );
  // Workers away from their desks visiting others (see world/visitors.ts).
  const visitors = new Visitors(
    scene,
    (x, z, y) => groundAt(office.colliders, x, z, y),
    (id) => {
      const v = workerViews.get(id);
      const desk = v && office.desks.get(v.deskId);
      return v && desk ? { model: v.model, desk } : undefined;
    },
    () => store.officeNow(),
  );
  // Only fully charged shots dismiss workers, with a heavenly ascent.
  const casualties = new Casualties(scene, (x, z, y) => groundAt(office.colliders, x, z, y));
  function syncWorkers() {
    for (const w of store.workers.values()) {
      let v = workerViews.get(w.id);
      const desk = office.desks.get(w.deskId);
      if (!desk) continue;
      if (!v) {
        departures.vacate(w.deskId);
        const model = new Worker(w.name, w.color);
        model.setSeat(desk.def.beanbag ? 'beanbag' : 'chair');
        desk.seatAnchor.add(model.root);
        model.setPropSpot(model.root.worldToLocal(desk.group.localToWorld(desk.propSpot.clone())));
        const original = w.forkedFrom && workerViews.get(w.forkedFrom.workerId);
        if (original && Date.now() - w.createdAt < 5000 && !reduceMotion.matches) model.splitFrom(desk.seatAnchor.worldToLocal(original.model.root.getWorldPosition(new THREE.Vector3())));
        const laptop = new Laptop();
        desk.laptopAnchor.add(laptop.root);
        noOutline(desk.group);
        desk.chair.rotation.y = 0;
        const wVibe = store.vibes?.workers[w.id];
        const initialTone: MonitorSpillTone = wVibe && isMonitorSpillTone(wVibe.spill) ? wVibe.spill : 'neutral';
        v = {
          model,
          name: w.name,
          laptop,
          deskId: w.deskId,
          status: '',
          acked: true,
          heard: false,
          spillTone: initialTone,
          spillColor: new THREE.Color(MONITOR_SPILL_HEX[initialTone]),
          spillTarget: new THREE.Color(MONITOR_SPILL_HEX[initialTone]),
          spillPower: MONITOR_SPILL_POWER[initialTone],
          spillPowerTarget: MONITOR_SPILL_POWER[initialTone],
        };
        model.applyVibe(wVibe, store.officeNow());
        v.pr = w.pr?.number;
        workerViews.set(w.id, v);
        if (store.officeNow() - w.createdAt < 8000) host.deskMomentFx(w.id, v, 'hired');
      }
      if (v.status !== w.status || v.acked !== w.acked) {
        // It just finished or started waiting on you (not already so when this page first saw it): ding, and notify if you're away.
        if (waitingOnSomeone(w) && v.status !== '' && w.status !== v.status) {
          sound.ding(w.status);
          notifier.alert(w);
        }
        // Finished what it was on: a little spin and a puff of confetti.
        if (w.status === 'done' && (v.status === 'working' || v.status === 'needs_input')) {
          v.model.celebrate();
          host.burstOver(w.deskId, 40);
          host.deskMomentFx(w.id, v, 'finished');
        }
        v.status = w.status;
        v.acked = w.acked;
        v.model.setStatus(w.status, waitingOnSomeone(w));
        noOutline(v.model.root);
      }
      v.name = w.name;
      v.model.setAction(w.action);
      v.model.setTeam(missionTeamBadge(w));
      if (v.heard && w.action === 'failing' && v.action !== 'failing') sound.ding('error');
      v.action = w.action;
      v.heard = true;
      v.model.setPr(prBadge(w));
      if (w.pr && w.pr.number !== v.pr && v.heard) host.shippedFx(w.id, v);
      v.pr = w.pr?.number;
      v.model.setLost(!!w.lost);
      v.model.setTodos(w.kind === 'shell' ? undefined : w.todos);
      const engineBadge = engineOf(w);
      const deskDef = DESK_BY_ID.get(w.deskId);
      // A cloud worker's card says where it runs even before it has a task.
      const task = w.task ?? (w.cloud ? { name: 'Ready', summary: w.cloud.error ?? 'Waiting for a prompt' } : undefined);
      v.model.setTask(task && w.kind !== 'shell' ? { ...task, summary: workerActivity(w) ?? task.summary, name: engineBadge ? `${engineBadge} · ${task.name}` : task.name } : task);
      // Keys clack while it types, not while it reads, watches its tests or browses.
      if (deskDef) sound.setTyping(w.id, deskDef.x, deskDef.z, w.status === 'working' && (!w.action || w.action === 'edit'));
      const again = w.kind === 'shell' ? 'restart' : 'resume';
      const lost = `🌿 ${w.name}'s worktree was deleted — press E to fix it`;
      const outside = w.cloud && (w.cloud.error ? `☁ ${w.cloud.error}` : `☁ Running on ${w.cloud.computerName} · E to open`);
      v.laptop.setPlaceholder(outside ? outside : w.lost ? lost : w.status === 'offline' ? `💤 ${w.name} is asleep — press R to ${again}` : w.status === 'exited' ? `${w.name} exited` : 'booting…');
    }
    for (const [id, v] of workerViews) {
      if (store.workers.has(id)) continue;
      // Out on a visit: back in its seat first, where walking out (or the beam) starts from.
      visitors.release(id);
      const desk = office.desks.get(v.deskId);
      if (shotWorkers.has(id)) host.deskMomentFx(id, v, 'shot');
      else if (desk && sentHome.has(id)) host.deskMomentFx(id, v, 'sent_home');
      // A shot worker: the body ascends instead of the send-home walk-out.
      if (shotWorkers.has(id)) {
        casualties.ascend(id, v.model, v.laptop, host.wandOut() ? 'spell' : 'blood');
      } else if (desk && sentHome.has(id)) departures.add(v.model, v.laptop, desk);
      else {
        v.model.root.removeFromParent();
        v.laptop.root.removeFromParent();
        v.model.dispose();
        v.laptop.dispose();
      }
      sound.removeTypist(id);
      host.lastWandShip.delete(id);
      workerViews.delete(id);
    }
    arrangeSeats();
    visitors.sync(store.visits);
    host.renderWorkers();
    syncMissionControl();
  }

  /** Everything that also reads Mission Control: the room, the team dashes, and the waiting counts and notifications the Orchestrator is in. */
  function syncMissionControl() {
    syncMission();
    syncTeamLines();
    host.renderWaiting();
    notifier.sync(store.workers, (id) => missionWorker(store.missionControl, id));
    host.renderTitle();
  }

  /** A worker by id: one on this floor, or one of Mission Control's building agents (the Orchestrator before its first prompt included). */
  function anyWorker(id: string): WorkerInfo | undefined {
    return store.workers.get(id) ?? missionWorker(store.missionControl, id);
  }

  /** The engine on a card: a cloud worker's computer, an agent's model and effort. */
  function engineOf(w: WorkerInfo): string | undefined {
    return w.cloud ? cloudBadge(w.cloud) : w.kind === 'agent' ? host.modelBadge(w.activeModel ?? w.model, w.activeEffort ?? w.effort) : undefined;
  }

  /** Who's in Mission Control and what its screens say, the same on every floor. */
  function syncMission() {
    const floorWorkers = [...store.workers.values()];
    const view = missionView(store.missionControl, floorWorkers, { model: engineOf, activity: workerActivity });
    if (mission.sync(store.missionControl, floorWorkers, view, dressAgent)) noOutline(mission.group);
  }

  /** A building agent's status light, card and todos, as a worker at a desk wears them. A bot runs elsewhere, so it never dings. */
  function dressAgent(v: MissionAgentView, w: WorkerInfo) {
    const waiting = !w.remote && waitingOnSomeone(w);
    if (v.status !== w.status || v.acked !== w.acked) {
      if (waiting && v.status !== '' && w.status !== v.status) {
        sound.ding(w.status);
        notifier.alert(w);
      }
      if (w.status === 'done' && (v.status === 'working' || v.status === 'needs_input')) v.model.celebrate();
      v.status = w.status;
      v.acked = w.acked;
      v.model.setStatus(w.status, waiting);
    }
    v.model.setAction(w.action);
    v.model.setTodos(w.todos);
    const engine = w.remote ? 'External bot' : engineOf(w);
    const task = w.task;
    v.model.setTask(task ? { ...task, summary: workerActivity(w) ?? task.summary, name: engine ? `${engine} · ${task.name}` : task.name } : undefined);
  }

  /** The dashes on the floor from each lead to each of its subagents, whatever they're doing; a working subagent's march. */
  function syncTeamLines() {
    const seat = (deskId: string) => {
      const desk = office.desks.get(deskId);
      if (!desk) return undefined;
      const p = desk.seatAnchor.getWorldPosition(new THREE.Vector3());
      return { x: p.x, y: desk.group.position.y, z: p.z };
    };
    const links: TeamLink[] = [];
    for (const l of teamLinks(store.workers.values())) {
      const from = seat(l.lead.deskId);
      const to = seat(l.member.deskId);
      if (from && to) links.push({ from, to, color: l.accent, team: l.team, moving: l.moving });
    }
    for (const { source, twin } of forkLinks(store.workers.values())) {
      const from = seat(source.deskId);
      const to = seat(twin.deskId);
      if (from && to) links.push({ from, to, color: twin.color, team: `fork:${source.id}`, moving: twin.status === 'working' });
    }
    links.push(...missionLinks(store.missionControl, [...store.workers.values()], seat));
    teamLines.set(links);
  }

  /** The team of whoever you're aiming at (at a desk), whose links and markings light up. */
  let focusedTeam: string | null = null;
  function focusTeam(it: Interactable | null) {
    const agent = it?.agentId ? anyWorker(it.agentId) : undefined;
    const w = it?.deskId ? store.workerAtDesk(it.deskId) : undefined;
    const badge = agent ? missionBadge(agent, store.workers.values()) : w?.team;
    const id = badge?.id ?? (w ? `fork:${w.forkedFrom?.workerId ?? w.id}` : null);
    if (id === focusedTeam) return;
    focusedTeam = id;
    teamLines.focus(id);
    focusTeamKit(badge);
  }

  /**
   * A seat shows it's free (its '+') only while nobody's at
   * it, and once every desk is taken, bean bags come out for the workers who don't fit.
   */
  function arrangeSeats() {
    // Someone sent home still counts until they get up, so a bean bag stays out under them.
    const free = vacantSeats(store.workers.values(), (id) => departures.seated(id));
    for (const [id, desk] of office.desks) desk.vacancy.visible = free.has(id);
    host.liftOnto(office.setBeanbags(beanbagsOut((id) => !free.has(id))));
  }

  /** A worker's pull request for its bubble, named the way this floor's forge names it ("🎉 MR !12 merged"). */
  function prBadge(w: WorkerInfo): PrBadge | undefined {
    const pr = workerPr(w, store.pulls.items);
    if (!pr) return undefined;
    const { pr: kind, ref } = words();
    return { state: pr.state, label: `${pr.state === 'open' ? '🔀' : '🎉'} ${kind} ${ref(pr.number)} ${pr.state}` };
  }
  // A worker's bubble shows whether it has a pull request open (green) or merged (purple: send it home).
  const paintPrs = () => {
    for (const [id, v] of workerViews) {
      const w = store.workers.get(id);
      if (w) v.model.setPr(prBadge(w));
    }
  };

  /** What a visitor's speech card says it's doing. */
  const SAY_CHIP: Record<VisitKind, string> = { tell: 'TELLS', ask: 'ASKS', handoff: 'HANDS OFF' };
  function sayVisit() {
    const said = store.lastSay;
    const view = said && workerViews.get(said.worker);
    if (!said || !view) return;
    const text = trimSay(said.text);
    if (!text) return;
    const visit = store.visits.find((v) => v.id === said.visit);
    const how = !visit ? 'SAYS' : said.worker === visit.visitor ? SAY_CHIP[visit.kind] : 'REPLIES';
    const name = plainLabel(store.workers.get(said.worker)?.name ?? '').toUpperCase();
    const chip = name ? `${name} ${how}` : how;
    // One line at a time in a conversation: the other side's last line makes way for this one.
    const other = visit && (said.worker === visit.visitor ? visit.host : visit.visitor);
    if (other) workerViews.get(other)?.model.hush(said.visit);
    view.model.speak(text, chip, said.visit, sayFor(text));
    host.renderWake();
  }
  /** A worker walking, hopping, mid-turn, leaving, or being carried out, or room/desk mood lighting crossfading. */
  function workerMoving(): boolean {
    if (sky.moodAnimating || host.vibeFxMoving) return true;
    for (const v of workerViews.values()) {
      if (v.model.animating) return true;
      if (Math.abs(v.spillColor.r - v.spillTarget.r) + Math.abs(v.spillColor.g - v.spillTarget.g) + Math.abs(v.spillColor.b - v.spillTarget.b) > 1e-3) return true;
      if (Math.abs(v.spillPower - v.spillPowerTarget) > 1e-3 || (v.spillTone === 'crimson' && !reduceMotion.matches)) return true;
    }
    return departures.hasLeavers || casualties.active || visitors.moving || mission.animating;
  }

  const workerPos = new THREE.Vector3();
  function updateWorkers(dt: number, t: number, camPos: THREE.Vector3): number {
    let screens = 0;
    visitors.update(dt);
    for (const [id, v] of workerViews) {
      const desk = DESK_BY_ID.get(v.deskId)!;
      // A jumping worker holds still while you're near enough to read its card, and jumps again once you walk away.
      if (!v.worldReady || v.model.animating || visitors.moving) {
        v.model.root.getWorldPosition(workerPos);
        v.worldReady = true;
      } else {
        workerPos.setFromMatrixPosition(v.model.root.matrixWorld);
      }
      const d = workerPos.distanceTo(player.pos);
      v.model.held = d < (v.model.held ? HOLD_LEAVE : HOLD_NEAR);
      workerPos.y += WORKER_HEAD;
      v.model.seenFrom(workerPos.distanceTo(camPos));
      v.model.update(dt, t);
      v.laptop.update(dt, store.screens.get(id), Math.hypot(desk.x - camPos.x, desk.z - camPos.z));
      v.spillColor.lerp(v.spillTarget, 1 - Math.exp(-dt / 0.6));
      v.spillPower += (v.spillPowerTarget - v.spillPower) * (1 - Math.exp(-dt / 0.6));
      // A fresh failure makes the screen light stutter like an alarm.
      const stutter = v.spillTone === 'crimson' && !reduceMotion.matches ? 0.78 + 0.22 * Math.abs(Math.sin(t * 23) * Math.sin(t * 7.1)) : 1;
      const glow = (screenGlows[screens] ??= { pos: new THREE.Vector3(), dir: new THREE.Vector3(), power: 0 });
      glow.power = v.laptop.glow(glow.pos, glow.dir) * v.spillPower * stutter;
      glow.color = v.spillColor;
      if (glow.power > 0.01) screens++;
    }

    return screens;
  }
  function updateMission(dt: number, t: number, camPos: THREE.Vector3) {
    for (const v of mission.views.values()) {
      const d = v.model.root.getWorldPosition(workerPos).distanceTo(player.pos);
      v.model.held = d < (v.model.held ? HOLD_LEAVE : HOLD_NEAR);
      workerPos.y += WORKER_HEAD;
      v.model.seenFrom(workerPos.distanceTo(camPos));
      v.model.update(dt, t);
    }
    mission.update(reduceMotion.matches ? 0 : dt);
  }

  return { workerViews, sentHome, shotWorkers, departures, visitors, casualties, syncWorkers, syncMissionControl, anyWorker, engineOf, focusTeam, arrangeSeats, prBadge, paintPrs, sayVisit, workerMoving, updateWorkers, updateMission };
}
export const WORKER_HEAD = 1.6;
const HOLD_NEAR = 4;
const HOLD_LEAVE = 5;
