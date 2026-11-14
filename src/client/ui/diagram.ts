import { attachCopyFeedback, highlightCodeBlock, syncHorizontalScrollCue } from './code-highlight';
import { h, openModal } from './dom';
import { windowHeader } from './kit';

// Mermaid diagrams in wiki pages and Thread messages, drawn as strict-mode SVG. The library is
// large, so it loads the first time a diagram renders, and sanitized SVG markup caches in an LRU
// map so Thread re-paints reuse the rendered diagram synchronously without flashing.

type Mermaid = typeof import('mermaid').default;

const MAX_SVG_CACHE = 64;

let loaded: Promise<Mermaid> | undefined;
let counter = 0;
const svgCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function mermaid(): Promise<Mermaid> {
  loaded ??= import('mermaid').then((m) => {
    m.default.initialize({
      startOnLoad: false,
      // Pages and messages come from model output or repositories: 'strict' keeps scripts and click handlers out of the SVG.
      securityLevel: 'strict',
      theme: 'dark',
      fontFamily: 'inherit',
      // Labels as SVG text, so no foreignObject (HTML inside the SVG) is needed.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
    return m.default;
  });
  return loaded;
}

function readLru(key: string): string | undefined {
  const hit = svgCache.get(key);
  if (hit === undefined) return undefined;
  // Refresh LRU order.
  svgCache.delete(key);
  svgCache.set(key, hit);
  return hit;
}

function writeLru(key: string, svgMarkup: string): void {
  if (svgCache.has(key)) svgCache.delete(key);
  else if (svgCache.size >= MAX_SVG_CACHE) {
    const oldest = svgCache.keys().next().value;
    if (oldest !== undefined) svgCache.delete(oldest);
  }
  svgCache.set(key, svgMarkup);
}

function parseSanitizedSvg(svg: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
    throw new Error('The diagram did not draw');
  }
  for (const bad of root.querySelectorAll('script, foreignObject, iframe, object, embed')) bad.remove();
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      if (attr.name.toLowerCase().startsWith('on')) el.removeAttribute(attr.name);
    }
  }
  root.removeAttribute('height');
  const natural = Number(root.getAttribute('viewBox')?.split(/\s+/)[2]);
  root.setAttribute('width', natural > 0 ? `${Math.ceil(natural)}` : '100%');
  root.classList.add('wt-diagram-svg');
  return document.importNode(root, true) as unknown as SVGSVGElement;
}

function peekCachedMermaidSvg(source: string): SVGSVGElement | null {
  const key = source.trim();
  if (!key) return null;
  const cached = readLru(key);
  if (!cached) return null;
  try {
    return parseSanitizedSvg(cached);
  } catch {
    svgCache.delete(key);
    return null;
  }
}

async function renderSanitizedMarkup(source: string): Promise<string> {
  const key = source.trim();
  if (!key) throw new Error('Empty diagram');
  const cached = readLru(key);
  if (cached) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const id = `wk-mermaid-${++counter}`;
  const job = (async () => {
    try {
      const m = await mermaid();
      const { svg } = await m.render(id, key);
      const cleanEl = parseSanitizedSvg(svg);
      const serialized = new XMLSerializer().serializeToString(cleanEl);
      writeLru(key, serialized);
      return serialized;
    } finally {
      inflight.delete(key);
      // A failed render leaves mermaid's error element (its id, or with a "d" in front) in the document; take it away.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  })();

  inflight.set(key, job);
  return job;
}

/** Renders `source` to a sanitized strict-mode `<svg>` element, reusing a 64-entry LRU cache on repeat renders. */
export async function renderMermaidSvg(source: string): Promise<SVGSVGElement> {
  const markup = await renderSanitizedMarkup(source);
  return parseSanitizedSvg(markup);
}

/** Replaces a ```mermaid code block on a wiki page with its drawing. A diagram that won't parse stays as its source, with the reason. */
export async function drawDiagram(pre: HTMLElement, source: string): Promise<void> {
  const box = h('div.wk-diagram-box', { role: 'img', 'aria-label': 'Diagram' }, h('span.spinner'));
  pre.replaceWith(box);
  try {
    const svg = await renderMermaidSvg(source);
    svg.style.maxWidth = '100%';
    box.replaceChildren(svg);
  } catch (e) {
    box.className = 'wk-diagram-box failed';
    box.replaceChildren(h('div.wk-diagram', {}, `mermaid diagram, couldn’t draw it: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown error'}`), h('pre', {}, h('code', {}, source)));
  }
}

function openMermaidZoomModal(source: string): void {
  const modalCopyBtn = h('button.btn.sm.ghost.wt-code-copy', { type: 'button', 'aria-label': 'Copy Mermaid source' }, 'Copy source');
  attachCopyFeedback(modalCopyBtn, () => source, 'Copy source');

  const stage = h('div.wt-diagram-zoom-stage', { role: 'img', 'aria-label': 'Mermaid diagram' });
  const cached = peekCachedMermaidSvg(source);
  if (cached) stage.append(cached);
  else {
    stage.append(h('span.spinner'));
    void renderMermaidSvg(source)
      .then((svg) => {
        if (stage.isConnected) stage.replaceChildren(svg);
      })
      .catch(() => {
        if (stage.isConnected) stage.replaceChildren(h('pre.wt-diagram-fallback', {}, source));
      });
  }

  const content = h('div.modal.wt-diagram-modal', { 'aria-label': 'Mermaid diagram' }, windowHeader('Mermaid diagram', undefined, modalCopyBtn), h('div.body.wt-diagram-modal-body', {}, stage));
  openModal(content, { size: 'xl', backdropCloses: true, reading: true, doing: 'reading a diagram' });
}

/**
 * Builds an interactive `.wt-diagram-card` for Thread view with Diagram/Source toggle, Zoom modal,
 * and Copy button. Incomplete or invalid Mermaid stays cleanly as its highlighted source block.
 */
export function renderThreadMermaid(source: string): HTMLElement {
  let showingSource = false;

  const codeEl = highlightCodeBlock(source, 'mermaid');
  const pre = h('pre.wt-horizontal-content', { tabindex: 0, 'aria-label': 'Mermaid source, scroll horizontally' }, codeEl);
  const cue = h('span.wt-code-cue', { hidden: true }, 'Scroll horizontally ↔');
  const sourceWrap = h('div.wt-code-scroll.wt-diagram-source', {}, pre, cue);
  pre.addEventListener('scroll', () => syncHorizontalScrollCue(sourceWrap));

  const stage = h('div.wt-diagram-stage', { role: 'img', 'aria-label': 'Mermaid diagram', hidden: true });

  const toggleBtn = h(
    'button.btn.sm.ghost.wt-diagram-toggle',
    {
      type: 'button',
      hidden: true,
      'aria-pressed': 'false',
      onclick: () => {
        showingSource = !showingSource;
        toggleBtn.textContent = showingSource ? 'Diagram' : 'Source';
        toggleBtn.setAttribute('aria-pressed', showingSource ? 'true' : 'false');
        sourceWrap.hidden = !showingSource;
        stage.hidden = showingSource;
        if (showingSource) syncHorizontalScrollCue(sourceWrap);
      },
    },
    'Source',
  );

  const zoomBtn = h(
    'button.btn.sm.ghost.wt-diagram-zoom',
    {
      type: 'button',
      hidden: true,
      'aria-label': 'Zoom Mermaid diagram',
      onclick: () => openMermaidZoomModal(source),
    },
    'Zoom',
  );

  const copyBtn = h('button.btn.sm.ghost.wt-code-copy', { type: 'button', 'aria-label': 'Copy Mermaid source' }, 'Copy');
  attachCopyFeedback(copyBtn, () => source, 'Copy');

  const activateDiagram = (svg: SVGSVGElement) => {
    stage.replaceChildren(svg);
    toggleBtn.hidden = false;
    zoomBtn.hidden = false;
    stage.hidden = showingSource;
    sourceWrap.hidden = !showingSource;
  };

  const cached = peekCachedMermaidSvg(source);
  if (cached) {
    activateDiagram(cached);
  } else {
    void renderMermaidSvg(source)
      .then(activateDiagram)
      .catch(() => {
        // Incomplete or invalid Mermaid (e.g. mid-stream): keep highlighted source without noisy broken-SVG boxes.
      });
  }

  const card = h('div.wt-code-block.wt-diagram-card', {}, h('div.wt-code-head', {}, h('span.wt-code-lang', {}, 'MERMAID'), h('div.wt-code-actions', {}, toggleBtn, zoomBtn, copyBtn)), stage, sourceWrap);
  return card;
}
