// Browser-side fingerprint overrides for signals that the in-container Xvfb
// stack leaks even after puppeteer-extra-plugin-stealth's defaults. Each
// function exported here is serialized via Function.prototype.toString() and
// injected with page.evaluateOnNewDocument, so it MUST be self-contained —
// any reference to a module-scoped value (import, top-level const, helper)
// will be undefined when the script runs in the page.

/**
 * All overrides wired up in BrowserService.newPage(). Covers:
 *
 *  1. WebGL UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL — claim Intel UHD
 *     Graphics 620 on Mesa instead of SwiftShader/llvmpipe.
 *  2. navigator.mediaDevices.enumerateDevices — return a non-empty list
 *     (containers have no real audio/video hardware).
 *  3. Canvas fingerprint — per-coordinate deterministic noise injected into
 *     every readback path:
 *       - CanvasRenderingContext2D.getImageData
 *       - OffscreenCanvasRenderingContext2D.getImageData
 *       - HTMLCanvasElement.toDataURL / toBlob
 *       - OffscreenCanvas.convertToBlob
 *       - WebGLRenderingContext / WebGL2RenderingContext.readPixels
 *     Source canvases are never mutated (encoded methods round-trip through
 *     a temp OffscreenCanvas).
 *  4. AudioContext fingerprint — same idea for AudioBuffer.getChannelData,
 *     defeats the OfflineAudioContext probe technique.
 *  5. screen.availWidth/Height — subtract a plausible taskbar height
 *     (openbox alone has no panel, so without this they'd equal width/height).
 *
 * navigator.hardwareConcurrency is intentionally NOT handled here — the stealth
 * plugin's default-enabled `navigator.hardwareConcurrency` evasion already
 * pins it to 4 via a Proxy (which preserves native toString better than our
 * defineProperty would).
 */
export function applyFingerprintOverrides(): void {
  // Per-session seed: stable within a page lifetime so repeated probes return
  // the same fingerprint (real users have stable hardware), different across
  // container restarts so device-bans don't accumulate against one signature.
  const SESSION_SEED = (Math.random() * 0xffffffff) | 0;

  // --- 1. WebGL renderer/vendor -------------------------------------------
  const SPOOF_VENDOR = 'Intel';
  const SPOOF_RENDERER = 'Mesa Intel(R) UHD Graphics 620 (KBL GT2)';
  const UNMASKED_VENDOR_WEBGL = 0x9245;
  const UNMASKED_RENDERER_WEBGL = 0x9246;

  const patchGetParameter = (proto: { getParameter: (p: number) => unknown }): void => {
    const original = proto.getParameter;
    proto.getParameter = function (this: unknown, parameter: number) {
      if (parameter === UNMASKED_VENDOR_WEBGL) return SPOOF_VENDOR;
      if (parameter === UNMASKED_RENDERER_WEBGL) return SPOOF_RENDERER;
      // eslint-disable-next-line prefer-rest-params
      return original.apply(this, arguments as unknown as [number]);
    };
  };

  if (typeof WebGLRenderingContext !== 'undefined') {
    patchGetParameter(WebGLRenderingContext.prototype);
  }
  if (typeof WebGL2RenderingContext !== 'undefined') {
    patchGetParameter(WebGL2RenderingContext.prototype);
  }

  // --- 2. mediaDevices.enumerateDevices -----------------------------------
  if (navigator.mediaDevices?.enumerateDevices) {
    const original = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async function (): Promise<MediaDeviceInfo[]> {
      const real = await original();
      if (real.length > 0) return real;
      const make = (kind: MediaDeviceKind): MediaDeviceInfo => {
        const proto =
          typeof MediaDeviceInfo !== 'undefined' ? MediaDeviceInfo.prototype : Object.prototype;
        const d = Object.create(proto) as MediaDeviceInfo;
        Object.defineProperties(d, {
          deviceId: { value: '', enumerable: true },
          kind: { value: kind, enumerable: true },
          label: { value: '', enumerable: true },
          groupId: { value: '', enumerable: true },
        });
        return d;
      };
      return [make('audioinput'), make('audiooutput')];
    };
  }

  // --- 3. Canvas fingerprint ---------------------------------------------
  // Antibot probes render a known shape (text "Cwm fjordbank glyphs vext quiz",
  // a few gradients), read it back, and hash the bytes. With SwiftShader the
  // hash matches a known-bot table.
  //
  // Strategy: noise the readback path, not the canvas itself.
  //
  //   * Each modified pixel is shifted by a value derived from
  //     hash(SESSION_SEED, canvasWidth, canvasHeight, absoluteX, absoluteY,
  //          channel). So:
  //       - same physical pixel always gets the same shift within a session
  //         → overlapping getImageData() reads of the same region are
  //         self-consistent (a detector cross-checking won't see drift);
  //       - shift is independent of the canvas's pixel values, so identical
  //         canvases between sessions hash differently (anti-replay);
  //       - alpha channel is left alone (transparency must stay exact).
  //
  //   * Noise is applied to ~50 evenly-strided pixels per readback —
  //     enough to perturb any hash, cheap on the small probe canvases (~200×60)
  //     that fingerprinters use.
  //
  //   * For toDataURL / toBlob / convertToBlob we encode from a noised COPY
  //     so the page's own canvas is never mutated.
  //
  //   * We patch CanvasRenderingContext2D, OffscreenCanvasRenderingContext2D
  //     (workers/offscreen path), and WebGL{1,2} readPixels (sites that read
  //     framebuffer directly).

  // Deterministic per-coordinate noise: returns -1, 0, or +1.
  // Mixing constants are Murmur3 finalizer primes — good avalanche for the
  // small inputs we feed in.
  const noiseAt = (cw: number, ch: number, x: number, y: number, channel: number): number => {
    let h = SESSION_SEED;
    h = Math.imul(h ^ cw, 0x85ebca77);
    h = Math.imul(h ^ ch, 0xc2b2ae3d);
    h = Math.imul(h ^ x, 0x27d4eb2f);
    h = Math.imul(h ^ y, 0x165667b1);
    h = Math.imul(h ^ channel, 0x9e3779b1);
    return ((h >>> 0) % 3) - 1;
  };

  const NOISE_PIXELS_PER_REGION = 50;

  // Mutate a region's RGB bytes in place. (data, regionW, regionH) describe
  // the buffer; (offsetX, offsetY) are the region's top-left in the source
  // canvas; (canvasW, canvasH) are the source canvas dimensions used as part
  // of the per-pixel hash, so any sub-region read of the same canvas applies
  // the same shifts to the same pixels.
  const noiseImageRegion = (
    data: Uint8ClampedArray | Uint8Array,
    regionW: number,
    regionH: number,
    offsetX: number,
    offsetY: number,
    canvasW: number,
    canvasH: number,
  ): void => {
    if (regionW <= 0 || regionH <= 0) return;
    const total = regionW * regionH;
    const stride = Math.max(1, (total / NOISE_PIXELS_PER_REGION) | 0);
    for (let p = 0; p < total; p += stride) {
      const ly = (p / regionW) | 0;
      const lx = p % regionW;
      const ax = offsetX + lx;
      const ay = offsetY + ly;
      const base = p * 4;
      if (base + 2 >= data.length) break;
      data[base] = (data[base] + noiseAt(canvasW, canvasH, ax, ay, 0)) & 0xff;
      data[base + 1] = (data[base + 1] + noiseAt(canvasW, canvasH, ax, ay, 1)) & 0xff;
      data[base + 2] = (data[base + 2] + noiseAt(canvasW, canvasH, ax, ay, 2)) & 0xff;
    }
  };

  // Patch getImageData on both 2D context flavors. We resolve canvas dims via
  // `this.canvas` so cross-region reads stay consistent.
  const patch2DGetImageData = (proto: {
    getImageData: (sx: number, sy: number, sw: number, sh: number, settings?: ImageDataSettings) => ImageData;
    canvas: HTMLCanvasElement | OffscreenCanvas;
  }): void => {
    const original = proto.getImageData;
    Object.defineProperty(proto, 'getImageData', {
      configurable: true,
      writable: true,
      value: function (
        this: { canvas: HTMLCanvasElement | OffscreenCanvas },
        sx: number,
        sy: number,
        sw: number,
        sh: number,
        settings?: ImageDataSettings,
      ): ImageData {
        const result =
          settings === undefined
            ? (original as (...a: unknown[]) => ImageData).call(this, sx, sy, sw, sh)
            : (original as (...a: unknown[]) => ImageData).call(this, sx, sy, sw, sh, settings);
        const canvas = this.canvas;
        const cw = canvas?.width ?? sw;
        const ch = canvas?.height ?? sh;
        noiseImageRegion(result.data, result.width, result.height, sx, sy, cw, ch);
        return result;
      },
    });
  };

  if (typeof CanvasRenderingContext2D !== 'undefined') {
    patch2DGetImageData(CanvasRenderingContext2D.prototype as unknown as Parameters<typeof patch2DGetImageData>[0]);
  }
  if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
    patch2DGetImageData(OffscreenCanvasRenderingContext2D.prototype as unknown as Parameters<typeof patch2DGetImageData>[0]);
  }

  // Encoded readback (toDataURL / toBlob / convertToBlob): noise the copy,
  // not the source. Returns null only if we can't create a copy context, in
  // which case caller falls back to the original method on the source.
  const encodeViaNoisedCopy = (
    source: HTMLCanvasElement | OffscreenCanvas,
    encode: (copy: OffscreenCanvas) => unknown,
  ): unknown | null => {
    const width = source.width;
    const height = source.height;
    if (width === 0 || height === 0 || typeof OffscreenCanvas === 'undefined') return null;
    const copy = new OffscreenCanvas(width, height);
    const ctx = copy.getContext('2d');
    if (!ctx) return null;
    try {
      // drawImage works for both HTMLCanvasElement and OffscreenCanvas
      // sources. For WebGL canvases Chrome reads the live framebuffer.
      (ctx as OffscreenCanvasRenderingContext2D).drawImage(
        source as CanvasImageSource,
        0,
        0,
      );
    } catch {
      return null;
    }
    // Our patched getImageData on OffscreenCanvasRenderingContext2D returns
    // noised data already; putImageData writes the noised bytes back onto
    // the copy (the source canvas is untouched).
    const imageData = (ctx as OffscreenCanvasRenderingContext2D).getImageData(0, 0, width, height);
    (ctx as OffscreenCanvasRenderingContext2D).putImageData(imageData, 0, 0);
    return encode(copy);
  };

  if (typeof HTMLCanvasElement !== 'undefined') {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (
      this: HTMLCanvasElement,
      type?: string,
      quality?: unknown,
    ): string {
      // OffscreenCanvas has no toDataURL — render the noised copy onto a
      // throwaway HTMLCanvas and call the original toDataURL on that.
      const noised = encodeViaNoisedCopy(this, (copy) => {
        const out = document.createElement('canvas');
        out.width = copy.width;
        out.height = copy.height;
        const outCtx = out.getContext('2d');
        if (!outCtx) return null;
        outCtx.drawImage(copy as unknown as CanvasImageSource, 0, 0);
        return (origToDataURL as (...a: unknown[]) => string).call(out, type, quality);
      });
      if (typeof noised === 'string') return noised;
      return (origToDataURL as (...a: unknown[]) => string).call(this, type, quality);
    };

    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
      type?: string,
      quality?: unknown,
    ): void {
      const handled = encodeViaNoisedCopy(this, (copy) => {
        const opts: { type?: string; quality?: number } = {};
        if (typeof type === 'string') opts.type = type;
        if (typeof quality === 'number') opts.quality = quality;
        copy
          .convertToBlob(opts)
          .then((blob) => callback(blob))
          .catch(() => callback(null));
        return true;
      });
      if (handled === true) return;
      (origToBlob as (...a: unknown[]) => void).call(this, callback, type, quality);
    };
  }

  if (typeof OffscreenCanvas !== 'undefined') {
    const origConvertToBlob = OffscreenCanvas.prototype.convertToBlob;
    OffscreenCanvas.prototype.convertToBlob = function (
      this: OffscreenCanvas,
      options?: ImageEncodeOptions,
    ): Promise<Blob> {
      const noised = encodeViaNoisedCopy(this, (copy) =>
        (origConvertToBlob as (...a: unknown[]) => Promise<Blob>).call(copy, options),
      );
      if (noised instanceof Promise) return noised as Promise<Blob>;
      return (origConvertToBlob as (...a: unknown[]) => Promise<Blob>).call(this, options);
    };
  }

  // WebGL readPixels: sites that bypass the 2D context read framebuffer
  // bytes directly. We noise the user-provided buffer after the original
  // call fills it. Only the common RGBA/Uint8 case is patched — other
  // formats (FLOAT, INT) aren't used by fingerprinters in practice.
  const patchWebGLReadPixels = (proto: {
    readPixels: (...args: unknown[]) => void;
    canvas: HTMLCanvasElement | OffscreenCanvas;
  }): void => {
    const original = proto.readPixels;
    Object.defineProperty(proto, 'readPixels', {
      configurable: true,
      writable: true,
      value: function (
        this: { canvas: HTMLCanvasElement | OffscreenCanvas },
        x: number,
        y: number,
        width: number,
        height: number,
        format: number,
        type: number,
        pixels: ArrayBufferView | null,
      ): void {
        original.call(this, x, y, width, height, format, type, pixels);
        if (!(pixels instanceof Uint8Array) && !(pixels instanceof Uint8ClampedArray)) return;
        const canvas = this.canvas;
        const cw = canvas?.width ?? width;
        const ch = canvas?.height ?? height;
        noiseImageRegion(pixels, width, height, x, y, cw, ch);
      },
    });
  };

  if (typeof WebGLRenderingContext !== 'undefined') {
    patchWebGLReadPixels(WebGLRenderingContext.prototype as unknown as Parameters<typeof patchWebGLReadPixels>[0]);
  }
  if (typeof WebGL2RenderingContext !== 'undefined') {
    patchWebGLReadPixels(WebGL2RenderingContext.prototype as unknown as Parameters<typeof patchWebGLReadPixels>[0]);
  }

  // --- 4. AudioContext fingerprint ----------------------------------------
  // OfflineAudioContext-based probes render a known oscillator and hash the
  // resulting samples. Our software audio path produces a constant hash. We
  // perturb getChannelData by 1e-7 — well below audible thresholds, but
  // enough to drift any hash off the known-bot value. Same SESSION_SEED, so
  // stable within session.
  if (typeof AudioBuffer !== 'undefined') {
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    // Map the int seed to a tiny signed float drift well below audibility.
    const audioDrift = ((SESSION_SEED >>> 0) / 0xffffffff - 0.5) * 1e-7;
    AudioBuffer.prototype.getChannelData = function (this: AudioBuffer, channel: number) {
      const arr = origGetChannelData.call(this, channel);
      // Perturb every 100th sample — cheap, but defeats sample-by-sample hashing.
      for (let i = 0; i < arr.length; i += 100) {
        arr[i] = arr[i] + audioDrift;
      }
      return arr;
    };
  }

  // --- 5. screen.availWidth / availHeight ---------------------------------
  // openbox alone draws no panel, so availHeight == height — a tell. Subtract
  // 40px to mimic a typical taskbar/dock. Defined on Screen.prototype so the
  // override survives any (very unlikely) re-reads of the screen instance.
  try {
    Object.defineProperty(Screen.prototype, 'availHeight', {
      configurable: true,
      get(): number {
        return Math.max(0, screen.height - 40);
      },
    });
    Object.defineProperty(Screen.prototype, 'availTop', {
      configurable: true,
      get(): number {
        return 0;
      },
    });
    Object.defineProperty(Screen.prototype, 'availLeft', {
      configurable: true,
      get(): number {
        return 0;
      },
    });
  } catch {
    // Property may be non-configurable in some Chrome builds — fingerprint
    // worsens slightly, but the page still works.
  }

}
