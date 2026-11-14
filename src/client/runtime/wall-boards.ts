import type * as THREE from 'three';
import { COMPUTE_WALL } from '../../shared/layout';
import { normalizeRepo } from '../../shared/floors';
import { isLive } from '../../shared/pipelines';
import type { CarriedIssue } from '../../shared/protocol';
import type { PlayerController } from '../player';
import type { store, Topic } from '../state';
import { watchFactory } from '../factory';
import { BoardTexture, PipelinesBoardTexture } from '../world/boards';
import { ComputeWallTextures, rackCubesOf } from '../world/factory-computers';
import { QuotaWallTexture } from '../world/droidproxy-wall';
import { setRackCubes } from '../world/factory-props';
import { CiBoardTexture } from '../world/factory-ci';
import { WhiteboardTexture, wallView } from '../world/whiteboard-wall';
import type { buildOffice } from '../world/office';

export interface WallBoardsHost {
  store: typeof store;
  office: ReturnType<typeof buildOffice>;
  readonly carrying: CarriedIssue | null;
  readonly upTop: boolean;
  readonly player: PlayerController;
}

/** Mount the room's state-backed wall textures and their age/clock refreshes. */
export function mountWallBoards(host: WallBoardsHost) {
  const { store, office } = host;
  /** How much of its light a wall board gives off in the dark room: dim, but its text stays easy to read. */
  const BOARD_GLOW = 0.62;
  function mountBoard(mesh: THREE.Mesh, texture: THREE.Texture, render: () => void, topics: Topic[]) {
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.map = texture;
    mat.color.setScalar(BOARD_GLOW);
    mat.needsUpdate = true;
    for (const topic of topics) store.on(topic, render);
    render();
  }
  const issuesTex = new BoardTexture('issues');
  const renderIssuesBoard = () => {
    // The card in your hands is missing from the board until you put it back.
    const held = host.carrying?.issue;
    issuesTex.setJira(store.jiraBoard);
    issuesTex.setLinear(store.linearBoard);
    issuesTex.render(held === undefined ? store.issues : { ...store.issues, items: store.issues.items.filter((i) => i.number !== held) });
  };
  mountBoard(office.boardMeshes.issues, issuesTex.texture, renderIssuesBoard, ['issues', 'jiraBoard', 'linearBoard']);
  const pullsTex = new BoardTexture('pulls');
  const renderPullsBoard = () => pullsTex.render(store.pulls, store.workers);
  mountBoard(office.boardMeshes.pulls, pullsTex.texture, renderPullsBoard, ['pulls']);
  // PR notes name the desk they came from. Redraw when that changes, not on every worker update.
  let deskLinks = '';
  store.on('workers', () => {
    const k = JSON.stringify([...store.workers.values()].filter((w) => w.worktree).map((w) => [w.worktree!.branch, w.pr?.number, w.name, w.color, w.deskId]));
    if (k === deskLinks) return;
    deskLinks = k;
    renderPullsBoard();
  });
  const pipelinesTex = new PipelinesBoardTexture();
  const renderPipelinesBoard = () => pipelinesTex.render(store.pipelines, store.project?.forge, Date.now());
  mountBoard(office.boardMeshes.actions, pipelinesTex.texture, renderPipelinesBoard, ['pipelines', 'project']);
  // Running runs' clocks and spinners move each second; the texture skips a redraw that would look the same.
  setInterval(() => {
    if (store.pipelines.runs.some((r) => isLive(r.state))) renderPipelinesBoard();
  }, 1000);
  // Ages on finished runs tick by the minute.
  setInterval(renderPipelinesBoard, 60_000);
  // The compute wall: this machine, Factory Droid Computers, and DroidProxy account quotas.
  const computeWall = new ComputeWallTextures();
  const quotaWall = new QuotaWallTexture();
  const renderQuotaBoard = (force = false) => quotaWall.render(store.subscriptions, Date.now(), force);
  const renderMachineBoard = () => {
    computeWall.render(store.machine, store.factory);
    setRackCubes(rackCubesOf(store.factory));
  };
  mountBoard(office.fleetScreen, computeWall.fleet, () => {}, []);
  mountBoard(office.machineScreen, computeWall.machine, renderMachineBoard, ['machine', 'factory']);
  mountBoard(office.proxyScreen, quotaWall.texture, () => renderQuotaBoard(), ['subscriptions']);
  setInterval(() => renderQuotaBoard(), 10_000);
  // Ages and asleep-ness move on by themselves; the wall paints only when what it says changed.
  setInterval(renderMachineBoard, 30_000);
  // Someone near the wall is watching it: Factory's computers are read more often meanwhile.
  let stopWatchingWall: (() => void) | undefined;
  setInterval(() => {
    const near = !host.upTop && !!store.floor && Math.hypot(host.player.pos.x - COMPUTE_WALL.x, host.player.pos.z - COMPUTE_WALL.z) < 12;
    if (near && !stopWatchingWall) stopWatchingWall = watchFactory('computers');
    else if (!near && stopWatchingWall) {
      stopWatchingWall();
      stopWatchingWall = undefined;
    }
  }, 1000);
  // Factory's CI automations on the north wall past the gong.
  /** This floor's GitHub repository (owner/repo), if its checkout has one. */
  const floorGithubRepo = () => {
    const repo = normalizeRepo(store.project?.remote);
    return repo && repo.split('/').length === 2 ? repo : undefined;
  };
  const ciTex = new CiBoardTexture();
  const renderCiBoard = (force = false) => ciTex.render({ connection: store.factory.connection, ci: store.factory.ci, floorRepo: floorGithubRepo(), now: Date.now() }, force);
  mountBoard(office.boardMeshes.ci, ciTex.texture, () => renderCiBoard(), ['factory', 'project']);
  // Its "5M" ages: redrawn only when one of them ticks over.
  setInterval(() => renderCiBoard(), 60_000);
  // The floor's Whiteboard on the east wall, following its persisted selection (world/whiteboard-wall.ts).
  const whiteboardTex = new WhiteboardTexture(() => renderWhiteboardWall());
  /** This floor's Whiteboard, as the window has it (null before its snapshot). */
  const floorWhiteboard = () => (store.floor ? store.whiteboard.board(store.floor) : null);
  /** The card the wall shows, or undefined when it shows the grid. */
  const wallCard = () => {
    const board = floorWhiteboard();
    const view = board && wallView(board);
    return view?.kind === 'card' ? view.card : undefined;
  };
  const renderWhiteboardWall = () => {
    const floor = store.floor;
    const f = floor ? store.whiteboard.floor(floor) : undefined;
    whiteboardTex.render({
      floor,
      board: floorWhiteboard(),
      renderer: f?.renderer ?? { available: false },
      renders: f?.renders ?? {},
      renderUrl: (card, opts) => (floor ? store.whiteboard.renderUrl(floor, card, opts) : undefined),
      now: Date.now(),
    });
  };
  mountBoard(office.boardMeshes.whiteboard, whiteboardTex.texture, renderWhiteboardWall, ['whiteboard', 'floor']);
  // Its "updated 2m ago" times: redrawn only when one of them ticks over.
  setInterval(renderWhiteboardWall, 30_000);

  function repaint() {
    renderIssuesBoard();
    renderPullsBoard();
    renderPipelinesBoard();
    computeWall.repaint();
    renderMachineBoard();
    renderQuotaBoard(true);
    renderCiBoard(true);
  }
  return { issuesTex, pipelinesTex, computeWall, renderIssuesBoard, floorGithubRepo, floorWhiteboard, wallCard, repaint };
}
