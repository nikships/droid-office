import { sameMenu, type Menu } from '../shared/asks';

/** Answer receipts belong to one occurrence, not every future question with the same text. */
export class DashboardQuestion {
  private menu?: Menu;
  private waitingSince?: number;
  revision = 0;
  answering = false;
  answered = false;

  sync(menu: Menu | undefined, waitingSince: number | undefined) {
    if (waitingSince === this.waitingSince && ((!menu && !this.menu) || sameMenu(menu, this.menu))) return;
    this.menu = menu;
    this.waitingSince = waitingSince;
    this.revision++;
    this.answering = false;
    this.answered = false;
  }
}
