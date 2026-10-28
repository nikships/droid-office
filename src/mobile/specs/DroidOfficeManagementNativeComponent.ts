import type { CodegenTypes, HostComponent, ViewProps } from 'react-native';
import { codegenNativeComponent } from 'react-native';

/** The sealed local management host (rn/ManagementViewManager.kt): the office's own DOM tools, one at a time. */
export interface NativeProps extends ViewProps {
  tool: string;
  floor: string;
  /** JSON of the tool's ManagementParams. */
  params?: string;
  /** JSON of a ManagementEvent the page asked for. */
  onToolEvent?: CodegenTypes.DirectEventHandler<Readonly<{ data: string }>>;
}

export default codegenNativeComponent<NativeProps>('DroidOfficeManagement') as HostComponent<NativeProps>;
