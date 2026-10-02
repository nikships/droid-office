# U6 gun and medic props

Authored and reviewed in live Blender 5.2.1 through Blender MCP. These are mesh
deliverables for Unity milestone **U6**, not completed gameplay or animation.
The original Blender scene was preserved; `U6 Props Art` and `U6 GLB Roundtrip`
contain the authored models and the decoded carry preview.

## Assets

Bounds are **width × height × depth, in metres**, in glTF/office Y-up space.
Every asset uses one Principled BSDF, two tiny embedded PNG palette atlases
(colour and metallic/roughness), backface culling and Draco compression.
The existing pipeline's **8,000 triangles per prop** cap applies unchanged.
No decimation was needed for these models.

| Prop | Triangles | Bounds (m) | Bytes | Mesh nodes |
| --- | ---: | --- | ---: | --- |
| `magnum-44` | 3,788 | 0.0520 × 0.1808 × 0.3200 | 23,896 | `magnum-44` |
| `medic` | 5,720 | 0.6260 × 1.7920 × 0.5160 | 45,144 | `medic` |
| `stretcher` | 3,968 | 0.5600 × 0.1325 × 2.2380 | 24,760 | `ScoopLeft`, `ScoopRight` |

- **Magnum:** silver six-inch .44 revolver, six cylinder flutes/chambers, hollow
  11.2 mm bore, underlug, sights, hammer, open trigger guard and curved trigger,
  brown grip and dark inset panels. Its origin is the right-hand grip centre,
  not the floor. Bore direction is +Z; muzzle anchor is `(0, 0.090, 0.291)`.
  The grip is approximately 32 mm wide and 100 mm tall.
- **Medic:** human paramedic in white shirt, trousers and cap, with medical
  patches, gloves and boots. The static walking-carry reference pose has
  staggered, floor-planted soles and bent arms. Origin is floor-centred; faces +Z.
- **Stretcher:** orange split scoop with steel end handles, rubber grips, skids
  and a split head pad at the -Z end. The central bed is 1.86 m long; handles
  span 2.238 m. Both nodes retain the same floor-centred origin. Translate the
  halves outward on X to open them; the pad and handles move with their half.

A two-medic team plus stretcher costs **15,408 triangles** and four mesh draws
before Unity batching. This is an asset count, not a measured headset result.

## Locations and rebuild

- Generator: `tools/props/generate.py`.
- Canonical output: `src/client/public/props/{magnum-44,medic,stretcher}.glb`
  and added rows in `manifest.json`.
- Byte-identical Unity copies:
  `native/unity/Assets/Art/Props/{magnum-44,medic,stretcher}.glb`.
- `.gitattributes` routes Unity binary art through Git LFS. Folder and GLB
  `.meta` files keep stable GUIDs in plain git.
- glTFast and Draco are required in the eventual Unity project. Apply the U0
  handedness check once; the coordinates here are not already Unity-mirrored.

Run from the repository root, passing **only the three new names**:

```sh
blender --background --python tools/props/generate.py -- magnum-44 medic stretcher
node tools/props/verify.mjs
cp src/client/public/props/{magnum-44,medic,stretcher}.glb native/unity/Assets/Art/Props/
```

On this Mac, the Homebrew-path executable failed to find Blender's bundled Python
and resources. Prepending `/Applications/Blender.app/Contents/MacOS` to `PATH`
for the export command worked. The app-bundle executable was used for the final run.
The two existing MacBook GLBs and their manifest rows remained byte-identical.

## Animation handoff, deferred

The gun and medic are joined **static meshes**, with no armatures, skin weights,
clips or authored hand poses. The stretcher has independently addressable halves
but no animation clips. Add rigs before trying to deform the medic.

- **Medic:** shared humanoid rig/weights; forward arrival walk; backward carry
  walk for the front medic facing the patient; forward carry for the rear medic;
  crouch, reach, support head/feet, close scoop, synchronized lift and withdrawal.
  Fit the loading cycle to **4.8 seconds**. Keep hand IK on the grips, boots
  planted and the patient attached through the lift. Share a small carry bob
  across hands, bed and patient. Fade private instance materials at the elevator.
- **Carry reference:** put medics at `(0, 0, ±1.335)`, facing inward (rotate the
  +Z-end medic 180°). Raise the stretcher origin to Y = `0.786`. Its grip centres
  are then approximately `(±0.230, 0.820, ±1.030)`, matching the posed palms.
  This arrangement was reviewed with both source meshes and imported GLBs.
- **Gun:** right-hand grab pose and back-holster alignment; draw, stow and recoil;
  trigger/hammer articulation requires separating those baked parts or adding
  bones. Muzzle flash, sound and haptics are runtime effects, not baked meshes.
- **Still open:** medic LODs, colliders, patient clearance during pickup, Unity
  prefabs/importer setup and physical-headset look/feel and 90 Hz acceptance.

## Validation

Export succeeded with `OVER BUDGET: none`. Blender's exporter reports a
`Material.use_nodes` deprecation and a sampler-consolidation warning; both atlas
nodes use the same nearest sampler, and the exported texture maps round-trip.

The verifier now decodes embedded RGB/RGBA PNG pixels in Node and fails missing
textures, material-count mismatches and bounds mismatches, as well as bad Draco
payloads/triangle counts. The five PNG filter modes, malformed-image rejection
and every exported colour swatch were checked separately. No tests were added
to or changed under `tests/`.

Final `node tools/props/verify.mjs` output:

```text
OK  macbook-base       tris= 3720 (manifest 3720) meshes=5 mats=5 colored=5 images=0/0 size=0.7840x0.0480x0.5450
OK  macbook-lid        tris=  506 (manifest 506) meshes=6 mats=6 colored=6 images=0/0 size=0.7800x0.5000x0.0300
OK  magnum-44          tris= 3788 (manifest 3788) meshes=1 mats=1 colored=1 images=2/2 size=0.0520x0.1808x0.3200
OK  medic              tris= 5720 (manifest 5720) meshes=1 mats=1 colored=1 images=2/2 size=0.6260x1.7920x0.5160
OK  stretcher          tris= 3968 (manifest 3968) meshes=2 mats=1 colored=2 images=2/2 size=0.5600x0.1325x2.2380

5 props, 17702 tris, 14 material slots, failures: 0
```

Python syntax, Node syntax and scoped Biome lint/format checks passed. SHA-256
checks confirmed existing binaries unchanged and canonical/Unity copies equal;
Git LFS clean filters produced pointers with matching hashes and sizes. All three
Unity GLBs decoded back into Blender with their embedded finishes and one material
per prop. Unity/on-device validation was **not run**. Web/server tests and builds
were not run for this art-only change while Track A worked in parallel.
