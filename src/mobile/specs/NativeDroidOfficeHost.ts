import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * The app's native host (android/app/src/main/java/ai/factory/droidoffice/rn/HostModule.kt), read by
 * React Native's codegen. Every value crosses as JSON text: src/mobile/native.ts parses it.
 */
export interface Spec extends TurboModule {
  bootstrap(): Promise<string>;
  send(json: string): boolean;
  request(json: string): Promise<string>;
  hold(workerId: string): number;
  release(token: number): void;
  http(json: string): Promise<string>;
  pickImages(floor: string, max: number): Promise<string>;
  forgetImage(floor: string, id: string, office: string | null): void;
  layoutLoad(office: string): Promise<string | null>;
  layoutSave(office: string, json: string): void;
  openPairing(): void;
  openOffices(): void;
  openSettings(): void;
  selectOffice(officeId: string): void;
  haptic(kind: string): void;
  screen(workerId: string): string | null;
}

export default TurboModuleRegistry.getEnforcing<Spec>('DroidOfficeHost');
