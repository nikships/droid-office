import type { HostComponent, ViewProps } from 'react-native';
import { codegenNativeComponent } from 'react-native';

/** The native raw terminal (rn/TerminalViewManager.kt): xterm in a sealed WebView, typed through the native keyboard. */
export interface NativeProps extends ViewProps {
  workerId: string;
  active: boolean;
  /** `phone` sizes the PTY to the view while it is active; `desktop` keeps the office's size. */
  fit?: string;
}

export default codegenNativeComponent<NativeProps>('DroidOfficeTerminal') as HostComponent<NativeProps>;
