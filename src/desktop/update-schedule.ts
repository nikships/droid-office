const INITIAL_DELAY_MS = 10_000;
const CHECK_EVERY_MS = 30 * 60_000;

type PowerEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen';

interface UpdatePowerMonitor {
  on(event: PowerEvent, listener: () => void): unknown;
  off(event: PowerEvent, listener: () => void): unknown;
  getSystemIdleState(threshold: number): string;
}

/** One due check, not a backlog of intervals, while the Mac is awake and unlocked. */
export class UpdateSchedule {
  private timer?: NodeJS.Timeout;
  private running = false;
  private suspended = false;
  private locked = false;
  private pending = 0;
  private dueAt?: number;
  private readonly listeners: Record<PowerEvent, () => void> = {
    suspend: () => this.powerChanged(true, this.locked),
    resume: () => this.powerChanged(false, this.power.getSystemIdleState(1) === 'locked'),
    'lock-screen': () => this.powerChanged(this.suspended, true),
    'unlock-screen': () => this.powerChanged(this.suspended, false),
  };

  constructor(
    private readonly power: UpdatePowerMonitor,
    private readonly automatic: () => Promise<void>,
  ) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.suspended = false;
    this.locked = this.power.getSystemIdleState(1) === 'locked';
    this.dueAt ??= Date.now() + INITIAL_DELAY_MS;
    for (const event of Object.keys(this.listeners) as PowerEvent[]) this.power.on(event, this.listeners[event]);
    this.arm();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const event of Object.keys(this.listeners) as PowerEvent[]) this.power.off(event, this.listeners[event]);
  }

  /** Observe actual checks, including remote checks and retries that bypass Updates.check(). */
  async track<T>(operation: () => Promise<T>): Promise<T> {
    ++this.pending;
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      return await operation();
    } finally {
      --this.pending;
      this.dueAt = Date.now() + CHECK_EVERY_MS;
      this.arm();
    }
  }

  private powerChanged(suspended: boolean, locked: boolean) {
    const wasBlocked = this.suspended || this.locked;
    this.suspended = suspended;
    this.locked = locked;
    // Give wake/unlock a moment to settle, then do at most one overdue check.
    if (wasBlocked && !suspended && !locked && this.dueAt !== undefined && this.dueAt <= Date.now()) this.dueAt = Date.now() + INITIAL_DELAY_MS;
    this.arm();
  }

  private arm() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.running || this.suspended || this.locked || this.pending || this.dueAt === undefined) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        // Also catch a screen already locked before the event was delivered.
        if (this.power.getSystemIdleState(1) === 'locked') {
          this.powerChanged(this.suspended, true);
          return;
        }
        // Track even a controller-skipped automatic check so it cannot become a tight retry loop.
        void this.track(this.automatic).catch(() => {});
      },
      Math.max(0, this.dueAt - Date.now()),
    );
  }
}
