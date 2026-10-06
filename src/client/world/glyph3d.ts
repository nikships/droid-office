import * as THREE from 'three';
import { FACTORY_GLYPH_PATH, FACTORY_GLYPH_VIEWBOX } from './glyph';

let shapes: THREE.Shape[] | null = null;

/** The pinwheel outline (one shape, eight cut-outs), one unit across, centered, +y up (SVG's y flipped). */
export function glyphShapes(): THREE.Shape[] {
  if (shapes) return shapes;
  const [vx, vy, vw, vh] = FACTORY_GLYPH_VIEWBOX;
  const size = Math.max(vw, vh);
  const cx = vx + vw / 2;
  const cy = vy + vh / 2;
  const X = (v: number) => (v - cx) / size;
  const Y = (v: number) => -(v - cy) / size;
  const path = new THREE.ShapePath();
  // The path only uses absolute M, C, H and Z.
  const tokens = FACTORY_GLYPH_PATH.match(/[MCHZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  let i = 0;
  let x = 0;
  let y = 0;
  const num = () => Number(tokens[i++]);
  let cmd = '';
  while (i < tokens.length) {
    if (/[MCHZ]/i.test(tokens[i])) cmd = tokens[i++].toUpperCase();
    if (cmd === 'M') {
      x = num();
      y = num();
      path.moveTo(X(x), Y(y));
      cmd = 'L';
    } else if (cmd === 'L') {
      x = num();
      y = num();
      path.lineTo(X(x), Y(y));
    } else if (cmd === 'C') {
      const [x1, y1, x2, y2] = [num(), num(), num(), num()];
      x = num();
      y = num();
      path.bezierCurveTo(X(x1), Y(y1), X(x2), Y(y2), X(x), Y(y));
    } else if (cmd === 'H') {
      x = num();
      path.lineTo(X(x), Y(y));
    } else if (cmd === 'Z') {
      path.currentPath?.closePath();
    } else i++;
  }
  shapes = path.toShapes();
  return shapes;
}

/**
 * The pinwheel as a solid `size` meters across and `depth` deep, centered on the origin and facing +z.
 * `curve` is how many points each curve gets: keep it low (4-6) for anything small or repeated.
 */
export function glyphGeometry(size: number, depth: number, curve = 6, bevel = 0): THREE.BufferGeometry {
  const geo = new THREE.ExtrudeGeometry(glyphShapes(), {
    depth,
    curveSegments: curve,
    bevelEnabled: bevel > 0,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 1,
  });
  geo.translate(0, 0, -depth / 2);
  geo.scale(size, size, 1);
  geo.computeVertexNormals();
  return geo;
}

/** The flat pinwheel, `size` meters across, facing +z: for decals and signs. */
export function glyphFlat(size: number, curve = 6): THREE.BufferGeometry {
  const geo = new THREE.ShapeGeometry(glyphShapes(), curve);
  geo.scale(size, size, 1);
  return geo;
}
