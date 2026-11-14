// The rich block page: draws one ```mermaid block of a Thread message, offline, for the Android app
// (ui/worker/RichBlock.kt via core/RichPage.kt). The app calls richDraw(); the page answers through
// OfficeBridge.post with the drawing's height and its sanitized SVG, which the app keeps so the same
// diagram shows again without loading Mermaid. Mermaid loads only the first time a page draws.

import { BAD_ELEMENTS, doneMessage, failedMessage, isUnsafeAttr, naturalWidth } from './logic.js';

const stage = document.getElementById('stage');
const post = (msg) => globalThis.OfficeBridge?.post(JSON.stringify(msg));

const scripts = new Map();
function load(src) {
  let p = scripts.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`couldn't load ${src}`));
      document.head.append(s);
    });
    scripts.set(src, p);
  }
  return p;
}

let mermaidReady;
function mermaid() {
  mermaidReady ??= Promise.all([load('vendor/mermaid.min.js'), document.fonts.load('14px Geist').catch(() => undefined)]).then(() => {
    const m = globalThis.mermaid;
    m.initialize({
      startOnLoad: false,
      // Messages come from model output: 'strict' keeps scripts and click handlers out of the SVG.
      securityLevel: 'strict',
      theme: 'dark',
      fontFamily: 'Geist, sans-serif',
      // Labels as SVG text, so no foreignObject (HTML inside the SVG) is needed.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
    return m;
  });
  return mermaidReady;
}

let counter = 0;
async function drawMermaid(source) {
  const m = await mermaid();
  const id = `rb-mermaid-${++counter}`;
  try {
    const { svg } = await m.render(id, source.trim());
    return svg;
  } finally {
    // A failed render leaves Mermaid's error element (its id, or with a "d" in front) in the document.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

/** [markup] as a drawing the page shows: an SVG with nothing that runs code. */
function sanitized(markup) {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) throw new Error('The diagram did not draw');
  for (const bad of root.querySelectorAll(BAD_ELEMENTS)) bad.remove();
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      if (isUnsafeAttr(attr.name, attr.value)) el.removeAttribute(attr.name);
    }
  }
  root.removeAttribute('height');
  const natural = naturalWidth(root.getAttribute('viewBox'));
  root.setAttribute('width', natural > 0 ? `${Math.ceil(natural)}` : '100%');
  return document.importNode(root, true);
}

const painted = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

globalThis.richDraw = async (id, kind, source, svg, zoom) => {
  document.body.classList.toggle('zoom', zoom === true);
  try {
    if (kind !== 'mermaid') throw new Error(`can't draw ${kind}`);
    const drawing = sanitized(typeof svg === 'string' ? svg : await drawMermaid(String(source ?? '')));
    stage.replaceChildren(drawing);
    await painted();
    post(doneMessage(id, stage.getBoundingClientRect().height, new XMLSerializer().serializeToString(drawing)));
  } catch (e) {
    stage.replaceChildren();
    post(failedMessage(id, e));
  }
};

post({ type: 'ready' });
