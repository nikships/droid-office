import { DESKS } from '../../shared/layout';
import type { buildOffice } from '../world/office';
import type { Rooftop } from '../world/rooftop';
import { loadPropManifest, preloadProps, propManifest, propScene } from '../world/props';
import { installExecutiveDesk } from '../world/executive-desk';
import { installLoftCouch } from '../world/loft-couch';
import { installLoftStairs } from '../world/loft-stairs';
import { installTaskChairs } from '../world/task-chair';
import { installLedBarHousings } from '../world/led-bar';
import { installHighBayLamps } from '../world/high-bay-lamp';
import { installRoofPlanters } from '../world/rooftop-planter';
import { installSportsCars } from '../world/sports-cars';
import { installCityFacades } from '../world/city-facades';
import { installCableTrays } from '../world/cable-tray';
import { installBoardFrames } from '../world/board-frame';
import { installLoungeSofa } from '../world/lounge-sofa';
import { installLoungeTable } from '../world/lounge-table';
import { installFloorLadder } from '../world/floor-ladder';
import { installDroidRack } from '../world/droid-rack';
import { installElevatorPanels } from '../world/elevator-panels';
import { installExitDoor } from '../world/exit-door';
import { installExitStairs } from '../world/exit-stairs';
import { installBalconyStools } from '../world/balcony-stool';
import { installBalconyTable } from '../world/balcony-table';
import { installBalconyBench } from '../world/balcony-bench';
import { installLoungeBeanbags } from '../world/lounge-beanbag';
import { installConferenceTable } from '../world/conference-table';
import { installTelescope } from '../world/telescope';
import { setTeamKit, setWorkerModel } from '../world/character';
import { setMagnumModel } from '../world/gun';
import { setWandModel } from '../world/wand';
import { installWorkbenches } from '../world/workbench';

export interface PropModelsHost {
  office: ReturnType<typeof buildOffice>;
  readonly roof: Rooftop | null;
}

/** Load and install model replacements only after the office scene has been constructed. */
export function loadOfficeModels(host: PropModelsHost): Promise<void> {
  const { office } = host;
  return loadPropManifest()
    .then(() => preloadProps(Object.keys(propManifest())))
    .then(() => {
      const loungeSofa = propScene('lounge-sofa');
      if (loungeSofa) installLoungeSofa(loungeSofa, office.group);
      const workbench = propScene('workbench');
      if (workbench)
        installWorkbenches(
          workbench,
          DESKS.map(({ id }) => office.desks.get(id)!.group),
        );
      const mergeGong = propScene('merge-gong');
      if (mergeGong) office.gong.setModel(mergeGong);
      const executiveDesk = propScene('executive-desk');
      if (executiveDesk) installExecutiveDesk(executiveDesk, office.group);
      const loftCouch = propScene('loft-couch');
      if (loftCouch) installLoftCouch(loftCouch, office.group);
      const loftStairs = propScene('loft-stairs');
      if (loftStairs) installLoftStairs(loftStairs, office.group);
      const gun = propScene('magnum');
      if (gun) setMagnumModel(gun);
      const wand = propScene('wand');
      if (wand) setWandModel(wand);
      const bookshelf = propScene('bookshelf');
      if (bookshelf) office.setShelfModel(bookshelf);
      const conferenceTable = propScene('conference-table');
      if (conferenceTable) installConferenceTable(conferenceTable, office.group);
      const worker = propScene('droid-worker');
      if (worker) setWorkerModel(worker);
      const jukebox = propScene('jukebox');
      if (jukebox) office.jukebox.setModel(jukebox);
      const telescope = propScene('telescope');
      if (telescope) installTelescope(telescope, office.group);
      const loungeTable = propScene('lounge-table');
      if (loungeTable) installLoungeTable(loungeTable, office.group);
      const floorLadder = propScene('floor-ladder');
      if (floorLadder) installFloorLadder(floorLadder, office.group);
      const droidRack = propScene('droid-rack');
      if (droidRack) installDroidRack(droidRack, office.group);
      const elevatorPanels = propScene('elevator-panels');
      if (elevatorPanels) {
        installElevatorPanels(elevatorPanels, office.elevator.group);
        if (host.roof) installElevatorPanels(elevatorPanels, host.roof.elevator.group);
      }
      const exitDoor = propScene('exit-door');
      if (exitDoor) installExitDoor(exitDoor, office.group);
      const exitStairs = propScene('exit-stairs');
      if (exitStairs) installExitStairs(exitStairs, office.group);
      const ledBar = propScene('led-bar');
      if (ledBar) installLedBarHousings(ledBar, office.group);
      const highBayLamp = propScene('high-bay-lamp');
      if (highBayLamp) installHighBayLamps(highBayLamp, office.group);
      const sportsCars = propScene('sports-cars');
      if (sportsCars) installSportsCars(sportsCars, office.group);
      const rooftopPlanter = propScene('rooftop-planter');
      if (rooftopPlanter && host.roof) installRoofPlanters(rooftopPlanter, host.roof.group);
      const cityFacades = propScene('city-facades');
      if (cityFacades) installCityFacades(cityFacades, office.group, ...(host.roof ? [host.roof.group] : []));
      const ceilingDeck = propScene('ceiling-deck');
      if (ceilingDeck) office.stack.setCeilingModel(ceilingDeck);
      const cableTray = propScene('cable-tray');
      if (cableTray) installCableTrays(cableTray, office.group);
      const boardFrame = propScene('board-frame');
      if (boardFrame) installBoardFrames(boardFrame, office.group);
      const balconyStool = propScene('balcony-stool');
      if (balconyStool) installBalconyStools(balconyStool, office.group);
      const balconyTable = propScene('balcony-table');
      if (balconyTable) installBalconyTable(balconyTable, office.group);
      const balconyBench = propScene('balcony-bench');
      if (balconyBench) installBalconyBench(balconyBench, office.group);
      const loungeBeanbag = propScene('lounge-beanbag');
      if (loungeBeanbag) installLoungeBeanbags(loungeBeanbag, office.group);
      const teamKit = propScene('droid-team-kit');
      if (teamKit) setTeamKit(teamKit);
      const taskChair = propScene('task-chair');
      if (taskChair) installTaskChairs(taskChair, [...DESKS.map(({ id }) => office.desks.get(id)!.chair), office.bossChair]);
    })
    .catch((err) => console.warn('office: prop GLBs unavailable, keeping procedural props', err));
}
