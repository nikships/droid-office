import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildOffice } from '../../../src/client/world/office';
import { loadFonts } from '../../../src/client/fonts';
import { Worker } from '../../../src/client/world/character';
import { Laptop } from '../../../src/client/world/laptop';
import { loadPropManifest, preloadProps, propReady } from '../../../src/client/world/props';
import { BALCONY, FLOOR, SLAB, WALL_HEIGHT, WALL_T } from '../../../src/shared/layout';

// Build the actual source environment, without connecting to any office or PTY.
// Batch opaque colour variants with vertex colours, retaining spatial culling.
const office = buildOffice();
await loadFonts();
// The single-floor foundation cannot ride between floors yet. Export its car
// arrived/open, including the source's disabled doorway collision, not a trap.
office.elevator.setOpen(true);
office.elevator.update(2);
for (const desk of office.desks.values()) desk.vacancy.visible = false;
// The headset office is the floor itself, with no street, garage, lot or city
// outside it. An upper floor's level plugs the exit doorway with wall (the
// source's own exitPlug) and drops the street a storey, out of the envelope.
office.setLevel(1, 2);
office.group.updateMatrixWorld(true);
const building = { minX: FLOOR.minX - WALL_T - 0.05, maxX: FLOOR.maxX + WALL_T + 0.05, minZ: FLOOR.minZ - WALL_T - 0.05, maxZ: FLOOR.maxZ + WALL_T + 0.05 };
const balcony = { minX: BALCONY.minX - 0.3, maxX: BALCONY.maxX + 0.3, minZ: building.maxZ - 0.1, maxZ: BALCONY.maxZ + 0.3 };
const inside = (x: number, z: number) => [building, balcony].some((r) => x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ);
const bounds = new THREE.Box3();
const middle = new THREE.Vector3();
function onFloor(object: THREE.Mesh): boolean {
  if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
  bounds.copy(object.geometry.boundingBox!).applyMatrix4(object.matrixWorld);
  bounds.getCenter(middle);
  return bounds.max.y > -SLAB - 0.05 && bounds.min.y < WALL_HEIGHT + 0.5 && inside(middle.x, middle.z);
}
const root = new THREE.Group();
root.name = 'Three.js office environment';
const buckets = new Map<string, { geometries: THREE.BufferGeometry[]; material: THREE.Material }>();
let sourceMeshes = 0;
let sourceTriangles = 0;
let outsideMeshes = 0;
office.group.traverseVisible((object) => {
  if (!(object instanceof THREE.Mesh)) return;
  if (!onFloor(object)) {
    outsideMeshes++;
    return;
  }
  sourceMeshes++;
  const source = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
  source.applyMatrix4(object.matrixWorld);
  const position = source.getAttribute('position');
  if (!source.getAttribute('normal')) source.computeVertexNormals();
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  const groups = source.groups.length ? source.groups : [{ start: 0, count: position.count, materialIndex: 0 }];
  for (const group of groups) {
    const material = (materials.length === 1 ? materials[0] : materials[group.materialIndex ?? 0]) as THREE.MeshStandardMaterial;
    if (!material.visible) continue;
    const count = Math.min(group.count, position.count - group.start);
    const geometry = new THREE.BufferGeometry();
    for (const [name, width] of [
      ['position', 3],
      ['normal', 3],
      ['uv', 2],
    ] as const) {
      const values = new Float32Array(count * width);
      const attribute = source.getAttribute(name);
      if (attribute) {
        for (let i = 0; i < count; i++) for (let axis = 0; axis < width; axis++) values[i * width + axis] = attribute.getComponent(group.start + i, axis);
      }
      geometry.setAttribute(name, new THREE.BufferAttribute(values, width));
    }
    const colors = new Float32Array(count * 3);
    const tint = material.color ?? new THREE.Color('white');
    const sourceColor = source.getAttribute('color');
    for (let i = 0; i < count; i++) {
      colors[i * 3] = tint.r * (sourceColor?.getX(group.start + i) ?? 1);
      colors[i * 3 + 1] = tint.g * (sourceColor?.getY(group.start + i) ?? 1);
      colors[i * 3 + 2] = tint.b * (sourceColor?.getZ(group.start + i) ?? 1);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingBox();
    const center = geometry.boundingBox!.getCenter(new THREE.Vector3());
    const unlit = material instanceof THREE.MeshBasicMaterial;
    const key = [
      Math.floor(center.x / 12),
      Math.floor(center.z / 12),
      unlit,
      material.map?.uuid ?? '',
      material.transparent,
      material.opacity,
      material.side,
      material.emissive?.getHexString() ?? '',
      material.emissiveIntensity ?? 0,
      material.emissiveMap?.uuid ?? '',
      material.alphaTest,
    ].join('|');
    let bucket = buckets.get(key);
    if (!bucket) {
      const options = { color: 'white', map: material.map ?? null, vertexColors: true, transparent: material.transparent, opacity: material.opacity, side: material.side, alphaTest: material.alphaTest };
      // glTFast ignores KHR_materials_emissive_strength, so a dimmed glow is
      // baked into the factor; only a glow above 1 still needs the extension.
      const glow = material.emissiveIntensity ?? 0;
      const exported = unlit
        ? new THREE.MeshBasicMaterial(options)
        : new THREE.MeshStandardMaterial({
            ...options,
            roughness: 1,
            metalness: 0,
            emissive: (material.emissive ?? new THREE.Color('black')).clone().multiplyScalar(Math.min(glow, 1)),
            emissiveIntensity: Math.max(glow, 1),
            emissiveMap: material.emissiveMap ?? null,
          });
      exported.name = unlit ? 'Office unlit' : 'Office toon';
      bucket = { geometries: [], material: exported };
      buckets.set(key, bucket);
    }
    bucket.geometries.push(geometry);
    sourceTriangles += count / 3;
  }
  source.dispose();
});
for (const [key, bucket] of buckets) {
  const geometry = mergeGeometries(bucket.geometries);
  if (!geometry) throw new Error('Environment attributes cannot be batched');
  const mesh = new THREE.Mesh(geometry, bucket.material);
  mesh.name = `Office chunk ${key.split('|').slice(0, 2).join(',')} ${root.children.length}`;
  root.add(mesh);
}
const matrix = (object: THREE.Object3D) => object.matrixWorld.toArray();
const colliders = office.colliders.filter((c) => (c.top ?? 0) > -SLAB && inside((c.minX + c.maxX) / 2, (c.minZ + c.maxZ) / 2));
const contract = {
  schema: 1,
  source: 'src/client/world/office.ts buildOffice(), one office floor with its exit plugged and nothing outside the building or balcony, native printed signs; static scenery, not live gameplay',
  elevatorOpen: office.elevator.open && office.elevator.settled,
  sourceMeshes,
  sourceTriangles,
  outsideMeshes,
  batches: root.children.length,
  colliders,
  slabs: [] as { positions: number[]; indices: number[] }[],
  seats: [...office.desks.values()].map((desk) => ({
    id: desk.def.id,
    laptop: matrix(desk.laptopAnchor),
    worker: matrix(desk.seatAnchor),
    visible: desk.group.visible,
  })),
};
// Keep the source's real slab/hatch topology for Unity collision. The browser's
// broad navigation rectangles alone do not encode ladder/pole holes.
office.stack.group.traverseVisible((object) => {
  if (!(object instanceof THREE.Mesh)) return;
  const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (bounds && bounds.max.x - bounds.min.x > 30 && bounds.max.z - bounds.min.z > 20 && bounds.max.y - bounds.min.y < 0.5) {
    contract.slabs.push({
      positions: Array.from(geometry.getAttribute('position').array),
      indices: geometry.index ? Array.from(geometry.index.array) : Array.from({ length: geometry.getAttribute('position').count }, (_, i) => i),
    });
  }
  geometry.dispose();
});
const glb = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true });
function download(id: string, bytes: BlobPart, type: string, filename: string) {
  const anchor = document.getElementById(id) as HTMLAnchorElement;
  anchor.href = URL.createObjectURL(new Blob([bytes], { type }));
  anchor.download = filename;
}
download('model', glb as ArrayBuffer, 'model/gltf-binary', 'office-environment.glb');
download('contract', JSON.stringify(contract, null, 2), 'application/json', 'office-environment.json');
const worker = new Worker('', '#ffffff', false);
const workerBody = worker.root.children[0];
workerBody.name = 'Worker body';
const shellMaterial = (workerBody.children[0] as THREE.Mesh).material;
// The office swaps every laptop's procedural stand-in for the MacBook GLBs once
// they load (main.ts preloadProps), so export that, not the stand-in.
await loadPropManifest();
await preloadProps(['macbook-base', 'macbook-lid']);
if (!propReady('macbook-base') || !propReady('macbook-lid')) throw new Error('MacBook prop GLBs did not load');
const laptop = new Laptop();
laptop.update(2, undefined);
laptop.root.updateMatrixWorld(true);
function modelMaterials(model: THREE.Object3D, isWorker: boolean) {
  const converted = new Map<THREE.Material, THREE.Material>();
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (!object.geometry.getAttribute('color')) {
      const colors = new Float32Array(object.geometry.getAttribute('position').count * 3);
      colors.fill(1);
      object.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    const original = object.material as THREE.MeshStandardMaterial;
    if (original.userData.nativeSharpText) object.name = 'Terminal display';
    let material = converted.get(original);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: original.color,
        map: original.userData.nativeSharpText ? null : (original.map ?? null),
        roughness: 1,
        metalness: 0,
      });
      material.name = isWorker && original === shellMaterial ? 'Worker shell' : 'Office toon';
      converted.set(original, material);
    }
    object.material = material;
  });
}
modelMaterials(worker.root, true);
modelMaterials(laptop.root, false);
worker.root.updateMatrixWorld(true);
const actor = new THREE.Group();
const body = new THREE.Group();
body.name = 'Worker body';
actor.add(body);
const actorBatches = new Map<THREE.Material, THREE.BufferGeometry[]>();
worker.root.traverseVisible((object) => {
  if (!(object instanceof THREE.Mesh)) return;
  const material = object.material as THREE.Material;
  const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
  geometry.applyMatrix4(object.matrixWorld);
  const batch = actorBatches.get(material) ?? [];
  batch.push(geometry);
  actorBatches.set(material, batch);
});
for (const [material, geometries] of actorBatches) {
  const geometry = mergeGeometries(geometries);
  if (!geometry) throw new Error('Worker attributes cannot be batched');
  body.add(new THREE.Mesh(geometry, material));
}
download('worker', (await new GLTFExporter().parseAsync(actor, { binary: true })) as ArrayBuffer, 'model/gltf-binary', 'office-worker.glb');
download('laptop', (await new GLTFExporter().parseAsync(laptop.root, { binary: true })) as ArrayBuffer, 'model/gltf-binary', 'office-laptop.glb');
document.getElementById('status')!.textContent = JSON.stringify({ sourceMeshes, sourceTriangles, outsideMeshes, batches: contract.batches });
Object.assign(window, { environmentExportReady: true });
