// The rich block page: draws one ```mermaid block or `$$…$$` equation of a Thread message, offline,
// for the Android app (ui/worker/RichBlock.kt via core/RichPage.kt). The app calls richDraw(); the
// page answers through OfficeBridge.postMessage with the drawing's height and a diagram's sanitized SVG,
// which the app keeps so the same diagram shows again without loading Mermaid. Mermaid and KaTeX
// load only the first time a page draws with them.

import { BAD_ELEMENTS, doneMessage, failedMessage, fitScale, isUnsafeAttr, KATEX_OPTIONS, naturalWidth } from './logic.js';

const stage = document.getElementById('stage');
// The app's web message listener, injected for this page's origin only.
const post = (msg) => globalThis.OfficeBridge?.postMessage(JSON.stringify(msg));

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

function stylesheet(href) {
  return new Promise((resolve, reject) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.onload = () => resolve();
    l.onerror = () => reject(new Error(`couldn't load ${href}`));
    document.head.append(l);
  });
}

let katexReady;
function katex() {
  katexReady ??= Promise.all([load('vendor/katex.min.js'), stylesheet('vendor/katex.min.css')]).then(() => globalThis.katex);
  return katexReady;
}

async function drawMath(tex) {
  const k = await katex();
  const box = document.createElement('div');
  box.className = 'math';
  k.render(tex, box, KATEX_OPTIONS);
  stage.replaceChildren(box);
  // KaTeX's fonts load as its glyphs are laid out; measure once they are in.
  void box.offsetWidth;
  await document.fonts.ready;
  const style = getComputedStyle(stage);
  const available = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const scale = fitScale(available, box.scrollWidth);
  if (scale < 1) box.style.fontSize = `${scale}em`;
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
  document.body.classList.toggle('math', kind === 'math');
  try {
    if (kind === 'math') {
      await drawMath(String(source ?? ''));
      await painted();
      post(doneMessage(id, stage.getBoundingClientRect().height));
      return;
    }
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
