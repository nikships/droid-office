/**
 * What Electron says the GPU is drawing with: `app.getGPUInfo('complete')` and `app.getGPUFeatureStatus()`, read
 * once the window is up and written to `gpu.log` beside the office log, so the backend in use is read rather than
 * assumed. Pure: main.ts does the asking and the writing.
 */

interface GpuDevice {
  active?: boolean;
  deviceString?: string;
  driverVersion?: string;
  vendorId?: number;
  deviceId?: number;
}

interface GpuInfo {
  auxAttributes?: Record<string, unknown>;
  gpuDevice?: GpuDevice[];
  machineModelName?: string;
  machineModelVersion?: string;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The GL implementation from `(gl=egl-angle,angle=metal)`: ANGLE's backend, or the GL in use without ANGLE. */
export function glBackend(parts: string | undefined): string | undefined {
  if (!parts) return undefined;
  const angle = /angle=([\w-]+)/.exec(parts)?.[1];
  if (angle && angle !== 'none') return `ANGLE on ${angle === 'metal' ? 'Metal' : angle}`;
  const gl = /gl=([\w-]+)/.exec(parts)?.[1];
  return gl && gl !== 'none' ? gl : undefined;
}

/** The report `gpu.log` holds, one fact a line. */
export function gpuReport(info: unknown, status: Record<string, string>, at: Date): string {
  const i = (info && typeof info === 'object' ? info : {}) as GpuInfo;
  const aux = i.auxAttributes ?? {};
  const active = i.gpuDevice?.find((d) => d.active) ?? i.gpuDevice?.[0];
  const parts = text(aux.glImplementationParts);
  const lines = [
    `Droid Office GPU report, ${at.toISOString()}`,
    `GPU: ${text(active?.deviceString) ?? text(aux.glRenderer) ?? 'unknown'}`,
    `WebGL backend: ${glBackend(parts) ?? 'unknown'}${parts ? ` ${parts}` : ''}${text(aux.displayType) ? `, display ${aux.displayType}` : ''}`,
    `Compositor: Skia ${text(aux.skiaBackendType) ?? 'unknown'}`,
    `GL: ${text(aux.glVersion) ?? 'unknown'}`,
  ];
  if (text(active?.driverVersion)) lines.push(`Driver: ${active?.driverVersion}`);
  if (typeof aux.maxMsaaSamples === 'string') lines.push(`Max MSAA samples: ${aux.maxMsaaSamples}`);
  if (typeof aux.inProcessGpu === 'boolean') lines.push(`GPU process: ${aux.inProcessGpu ? 'in the browser process' : 'its own'}${aux.sandboxed === true ? ', sandboxed' : ''}`);
  if (i.machineModelName) lines.push(`Machine: ${i.machineModelName}${i.machineModelVersion ? ` ${i.machineModelVersion}` : ''}`);
  const features = Object.entries(status)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `  ${k}: ${v}`);
  if (features.length) lines.push('Features:', ...features);
  return `${lines.join('\n')}\n`;
}
