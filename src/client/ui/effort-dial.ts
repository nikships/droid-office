import type { AgentEffort } from '../../shared/protocol';
import { DIAL_VIEWBOX, dialGeometry } from '../../shared/effort-dial';
import { EFFORT_LABEL } from './effort-label';

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** The effort dial (src/shared/effort-dial.ts) as an SVG, named "High effort" for screen readers and on hover. */
export function effortDial(effort: AgentEffort): SVGSVGElement {
  const g = dialGeometry(effort);
  const label = `${EFFORT_LABEL[effort]} effort`;
  const svg = svgEl('svg', { class: 'effort-dial', viewBox: DIAL_VIEWBOX.join(' '), width: DIAL_VIEWBOX[2], height: DIAL_VIEWBOX[3], role: 'img', 'aria-label': label, 'data-effort': effort }) as SVGSVGElement;
  const title = svgEl('title', {});
  title.textContent = label;
  const line = (l: { x1: number; y1: number; x2: number; y2: number }, cls: string) => svgEl('line', { class: cls, ...l });
  svg.append(
    title,
    ...g.ticks.map((t) => line(t, 'effort-dial-tick')),
    svgEl('path', { class: 'effort-dial-track', d: g.track }),
    svgEl('path', { class: 'effort-dial-arc', d: g.arc, stroke: g.color }),
    svgEl('line', { class: 'effort-dial-needle', ...g.needle, stroke: g.color }),
    svgEl('circle', { class: 'effort-dial-hub', ...g.hub }),
  );
  return svg;
}
