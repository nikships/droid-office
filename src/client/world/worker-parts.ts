import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { toonUnique } from './toon';

export interface WorkerPart {
  geo: THREE.BufferGeometry;
  mat: THREE.MeshToonMaterial | 'skin';
}

/** Only the worker's fixed, opaque paint: animated skin and emissive optics stay separate. */
function paint(part: WorkerPart): THREE.MeshToonMaterial | null {
  const mat = part.mat;
  if (mat === 'skin' || mat.transparent || mat.opacity !== 1 || mat.vertexColors || mat.map || mat.alphaMap || mat.emissiveMap || mat.emissive.getHex() !== 0 || mat.userData.remasterFinish) return null;
  return mat;
}

/**
 * Join consecutive paint parts at one fixed joint, baking their unchanged linear colors.
 * Never cross an articulation, skin, light or outline boundary. No per-frame synchronization.
 */
export function mergeWorkerPaint(parts: WorkerPart[]): WorkerPart[] {
  const out: WorkerPart[] = [];
  for (let i = 0; i < parts.length; ) {
    const first = parts[i];
    const mat = paint(first);
    const outline = JSON.stringify(mat?.userData.outlineParameters);
    let end = i + 1;
    while (mat && end < parts.length) {
      const next = paint(parts[end]);
      if (!next || next.gradientMap !== mat.gradientMap || next.side !== mat.side || JSON.stringify(next.userData.outlineParameters) !== outline) break;
      end++;
    }
    if (!mat || end === i + 1) {
      out.push(first);
      i++;
      continue;
    }
    const colored = parts.slice(i, end).map((part) => {
      const geo = part.geo.clone();
      const color = (part.mat as THREE.MeshToonMaterial).color;
      const data = new Float32Array(geo.getAttribute('position').count * 3);
      for (let n = 0; n < data.length; n += 3) {
        data[n] = color.r;
        data[n + 1] = color.g;
        data[n + 2] = color.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(data, 3));
      return geo;
    });
    const merged = mergeGeometries(colored);
    for (const geo of colored) geo.dispose();
    if (merged) {
      const material = toonUnique('#ffffff');
      material.vertexColors = true;
      material.gradientMap = mat.gradientMap;
      material.side = mat.side;
      if (mat.userData.outlineParameters) material.userData.outlineParameters = { ...mat.userData.outlineParameters };
      out.push({ geo: merged, mat: material });
    } else out.push(...parts.slice(i, end));
    i = end;
  }
  return out;
}
