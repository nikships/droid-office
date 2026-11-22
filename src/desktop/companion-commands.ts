import type { Input, MenuItemConstructorOptions } from 'electron';

export type CompanionCommand = 'close-pane' | 'send-home';

interface CommandTarget {
  isDestroyed(): boolean;
  getURL(): string;
  executeJavaScript(source: string): Promise<unknown>;
}

export function companionCommand(input: Pick<Input, 'type' | 'key' | 'meta' | 'control' | 'alt' | 'shift'>): CompanionCommand | undefined {
  if (input.type !== 'keyDown' || !input.meta || input.control || input.alt || input.key.toLowerCase() !== 'w') return;
  return input.shift ? 'send-home' : 'close-pane';
}

export function sendCompanionCommand(target: CommandTarget | undefined, officeUrl: string | undefined, command: CompanionCommand): boolean {
  if (!target || target.isDestroyed() || !officeUrl) return false;
  try {
    const url = new URL(target.getURL());
    if (url.origin !== new URL(officeUrl).origin || url.pathname !== '/dashboard') return false;
    void target.executeJavaScript(`window.dispatchEvent(new Event('droid-office:${command}'))`).catch(() => {});
    return true;
  } catch {
    // Navigation or closing can destroy the page between the menu click and delivery.
    return false;
  }
}

interface CompanionWindowMenuActions {
  isCompanionFocused(): boolean;
  run(command: CompanionCommand): boolean;
  closeCompanion(): void;
  closeSecondary(): void;
}

export function companionWindowMenu({ isCompanionFocused, run, closeCompanion, closeSecondary }: CompanionWindowMenuActions): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Close Pane',
      accelerator: 'Cmd+W',
      click: () => {
        if (!isCompanionFocused()) return closeSecondary();
        if (!run('close-pane')) closeCompanion();
      },
    },
    {
      label: 'Send Home…',
      accelerator: 'Shift+Cmd+W',
      click: () => {
        if (isCompanionFocused()) run('send-home');
      },
    },
    { label: 'Close Window', click: closeCompanion },
  ];
}
