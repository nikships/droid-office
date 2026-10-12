/**
 * Native HDR (EDR) for the WebGL office. Chromium can't show a WebGL canvas brighter than white, but a WebGPU canvas
 * configured with an rgba16float format and `toneMapping: { mode: 'extended' }` can. So the WebGL canvas gets a
 * float16 drawing buffer (drawingBufferStorage, with EXT_color_buffer_float), the Remastered pipeline writes
 * extended-range sRGB into it (1 = the desktop's white), and once a frame is drawn it is copied into the WebGPU
 * canvas laid over it. The WebGL canvas stays underneath at opacity 0, so it keeps the mouse and pointer lock.
 * Checked in Electron 44 (Chromium 152): a 3.0 cleared into the WebGL buffer arrives as 3.0 in the WebGPU texture.
 */
export type HdrState = 'off' | 'starting' | 'on' | 'unsupported';

interface FloatStorage {
  drawingBufferStorage?: (format: number, width: number, height: number) => void;
  drawingBufferFormat?: number;
}

const RGBA8 = 0x8058;
const RGBA16F = 0x881a;
// GPUTextureUsage flags; TypeScript's DOM library has the WebGPU types but not this global.
const TEXTURE_COPY_DST = 0x02;
const TEXTURE_RENDER_ATTACHMENT = 0x10;

export class HdrPresenter {
  state: HdrState = 'off';
  /** Why HDR is off when it was asked for. */
  reason = '';
  private device: GPUDevice | null = null;
  private ctx: GPUCanvasContext | null = null;
  private overlay: HTMLCanvasElement | null = null;
  private wanted = false;
  /** Bumped by every start and stop, so a start that was overtaken while it waited gives up. */
  private run = 0;
  private float = false;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly source: HTMLCanvasElement,
    private readonly onChange: () => void,
  ) {}

  /** The display can show more than SDR white right now (EDR headroom on a Mac). */
  static displayHdr(): boolean {
    return typeof matchMedia === 'function' && matchMedia('(dynamic-range: high)').matches;
  }

  get active(): boolean {
    return this.state === 'on';
  }

  /** Turns HDR on or off. Starting is async (a WebGPU device); until it is up the office draws in SDR. */
  set(on: boolean) {
    const was = this.wanted;
    this.wanted = on;
    if (!on) {
      if (!was) return;
      this.stop();
      // Turned off by hand: the next time it's turned on, it tries again.
      this.state = 'off';
      this.reason = '';
      return;
    }
    // Called on every settings change: one that failed waits for HDR to be turned off and on before trying again.
    if (this.state !== 'off') return;
    void this.start();
  }

  private async start() {
    const run = ++this.run;
    this.state = 'starting';
    this.onChange();
    try {
      const storage = this.gl as unknown as FloatStorage;
      if (typeof storage.drawingBufferStorage !== 'function') throw new Error('this browser has no WebGL drawingBufferStorage');
      if (!this.gl.getExtension('EXT_color_buffer_float')) throw new Error('no EXT_color_buffer_float');
      const device = await this.gpuDevice();
      // Turned off (and maybe on again) while the device was coming: that later call owns the state now.
      if (run !== this.run) return;
      const overlay = document.createElement('canvas');
      overlay.className = 'scene-hdr';
      overlay.setAttribute('aria-hidden', 'true');
      const ctx = overlay.getContext('webgpu') as GPUCanvasContext | null;
      if (!ctx) throw new Error('no WebGPU canvas');
      ctx.configure({
        device,
        format: 'rgba16float',
        alphaMode: 'opaque',
        colorSpace: 'srgb',
        toneMapping: { mode: 'extended' },
        usage: TEXTURE_RENDER_ATTACHMENT | TEXTURE_COPY_DST,
      });
      this.ctx = ctx;
      this.overlay = overlay;
      this.source.after(overlay);
      this.storage(true);
      if (!this.float) throw new Error('the WebGL canvas would not take a float16 drawing buffer');
      this.source.classList.add('hdr-under');
      this.state = 'on';
      this.reason = HdrPresenter.displayHdr() ? '' : 'this display has no HDR headroom right now; highlights clip at white';
    } catch (err) {
      if (run !== this.run) return;
      this.fail((err as Error).message);
    }
    this.onChange();
  }

  /** One device for the page's life: turning HDR off and on again reuses it rather than making another. */
  private async gpuDevice(): Promise<GPUDevice> {
    if (this.device) return this.device;
    if (!navigator.gpu) throw new Error('no WebGPU in this browser');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no WebGPU adapter');
    const device = await adapter.requestDevice();
    void device.lost.then((info) => {
      if (this.device !== device) return;
      this.device = null;
      if (this.state === 'on' || this.state === 'starting') this.fail(`the WebGPU device was lost (${info.message || info.reason})`);
    });
    this.device = device;
    return device;
  }

  private fail(reason: string) {
    this.stop();
    this.state = 'unsupported';
    this.reason = reason;
    this.onChange();
  }

  private stop() {
    this.run++;
    this.ctx?.unconfigure();
    this.ctx = null;
    this.overlay?.remove();
    this.overlay = null;
    this.source.classList.remove('hdr-under');
    if (this.float) this.storage(false);
    if (this.state !== 'unsupported') this.state = 'off';
  }

  /** The WebGL drawing buffer's format, for its current size. Called again after every resize. */
  storage(float: boolean) {
    const storage = this.gl as unknown as FloatStorage;
    if (typeof storage.drawingBufferStorage !== 'function') return;
    const gl = this.gl;
    storage.drawingBufferStorage(float ? RGBA16F : RGBA8, gl.drawingBufferWidth, gl.drawingBufferHeight);
    this.float = float && storage.drawingBufferFormat === RGBA16F;
  }

  /** After a resize: the drawing buffer is reallocated, so it is asked for in float16 again. */
  resized() {
    if (this.state === 'on' && this.gl.drawingBufferWidth > 0 && this.gl.drawingBufferHeight > 0) this.storage(true);
  }

  /** Copies the frame just drawn to the HDR canvas. Called once a frame, after everything is drawn. */
  present() {
    if (this.state !== 'on' || !this.device || !this.ctx || !this.overlay) return;
    const w = this.source.width;
    const h = this.source.height;
    // A minimized or zero-sized window has nothing to copy, and copying nothing is a WebGPU error, not a failure.
    if (w === 0 || h === 0) return;
    if (this.overlay.width !== w || this.overlay.height !== h) {
      this.overlay.width = w;
      this.overlay.height = h;
    }
    try {
      this.device.queue.copyExternalImageToTexture({ source: this.source }, { texture: this.ctx.getCurrentTexture() }, [w, h]);
    } catch (err) {
      this.fail(`copying the frame failed: ${(err as Error).message}`);
    }
  }
}
