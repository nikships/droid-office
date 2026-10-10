import { h } from './dom';

// Mermaid diagrams in wiki pages, drawn as SVG. The library is large, so it loads the first time a page has a diagram.

type Mermaid = typeof import('mermaid').default;

let loaded: Promise<Mermaid> | undefined;
let counter = 0;

function mermaid(): Promise<Mermaid> {
  loaded ??= import('mermaid').then((m) => {
    m.default.initialize({
      startOnLoad: false,
      // Pages are written by a model from a repository's contents: 'strict' keeps scripts and click handlers out of the SVG.
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

/** Replaces a ```mermaid code block with its drawing. A diagram that won't parse stays as its source, with the reason. */
export async function drawDiagram(pre: HTMLElement, source: string): Promise<void> {
  const box = h('div.wk-diagram-box', { role: 'img', 'aria-label': 'Diagram' }, h('span.spinner'));
  pre.replaceWith(box);
  const id = `wk-mermaid-${++counter}`;
  try {
    const m = await mermaid();
    const { svg } = await m.render(id, source);
    // The SVG comes from mermaid's strict mode; DOMParser keeps it from running anything while it is read.
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const root = doc.documentElement;
    if (root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) throw new Error('The diagram did not draw');
    for (const bad of root.querySelectorAll('script, foreignObject')) bad.remove();
    root.removeAttribute('height');
    // Draw at natural size, shrinking only when the page is narrower, rather than stretching to the page's full width.
    const natural = Number(root.getAttribute('viewBox')?.split(/\s+/)[2]);
    root.setAttribute('width', natural > 0 ? `${Math.ceil(natural)}` : '100%');
    root.style.maxWidth = '100%';
    box.replaceChildren(document.importNode(root, true));
  } catch (e) {
    // A failed render leaves mermaid's error element (its id with a "d" in front) in the document; take it away.
    document.getElementById(`d${id}`)?.remove();
    box.className = 'wk-diagram-box failed';
    box.replaceChildren(h('div.wk-diagram', {}, `mermaid diagram, couldn’t draw it: ${e instanceof Error ? e.message.split('\n')[0] : 'unknown error'}`), h('pre', {}, h('code', {}, source)));
  }
}
