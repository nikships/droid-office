import { createElement } from 'react';
import { DeviceEventEmitter } from 'react-native';
import { createHost } from './native';
import NativeDroidOfficeHost from './specs/NativeDroidOfficeHost';
import DroidOfficeManagement from './specs/DroidOfficeManagementNativeComponent';
import DroidOfficeTerminal from './specs/DroidOfficeTerminalNativeComponent';

/** The app's one host: the Android native module and views. */
export const host = createHost({
  module: NativeDroidOfficeHost,
  events: DeviceEventEmitter,
  views: { Terminal: DroidOfficeTerminal, Management: DroidOfficeManagement },
  createElement,
});
