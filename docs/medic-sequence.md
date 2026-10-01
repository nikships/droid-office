# Medic collection sequence

The casualty presentation is shared by the desktop scene and the installed native client.
`src/client/world/casualties.ts` handles only local visuals and sound callbacks. A shot does
not stop a worker or its PTY. The existing kill dialog sends `worker.kill` only after explicit
confirmation, and the collection starts when that worker's removal arrives. Revive restores
an unconfirmed worker to its seat with its session untouched. Given the bullet's direction, the
hit shoves the body along it and leans it away from the shooter in the first frame, easing into
the fall, and the body sprawls out on the side the bullet was heading.

Two medics enter from the elevator at full size, accelerate into their route, and slow before
turning into the fallen worker's orientation. They approach its torso rather than its foot
origin. Both hold an orange split scoop stretcher with steel handles and a head pad.

The pickup lasts 4.8 seconds. The team crouches and lowers the split bed around the body;
the hands support the head/feet ends while the worker rolls smoothly face up; the halves
close underneath it. The body then stays attached to the bed through the synchronized rise
and a short withdrawal from the vacated chair. The medics turn toward the elevator, keep
their hands on the handles, and walk out. The front medic faces the patient and walks
backwards. The stretcher, patient and hand targets share a small walking bob. Departure
fades private material copies without shrinking the people or changing shared materials.

`Person.medicPose` creates articulated arms and legs only when requested by the casualty
scene. The hand and boot meshes are the limb endpoints; their targets are solved using
cached vectors and quaternions. Passing null or disposing restores the ordinary limbs and
label visibility and releases the helper geometry. Ordinary player updates stay unchanged.

Each medic adds nine meshes: four lower limb segments, two boots, a cap, and two cross bars.
The stretcher adds six meshes using one shared box buffer and one pole buffer per team.
Only the canvas halves add new shadow casters. Everything uses ordinary supported three.js
meshes and toon materials. The animation changes transforms, visibility and material opacity;
it does not rebuild buffers, create textures, skin meshes, or add custom shader programs.

`clear()` restores unconfirmed workers. It cancels collections in every later phase, removes
the team and stain, and releases the collected model and laptop once. The thud, siren, laptop
closing and elevator-door position callbacks retain their existing contracts.

Verification uses the real `Person` and `Worker` geometry in `tests/casualties-medic.test.ts`:
hand contact over six fall/yaw combinations and complete carry routes, planted boots,
continuous position/rotation/world scale across loading and attachment, private fade material
ownership, revive/clear behavior, helper reset/disposal, and native scene conformance.
The exporter accepts the medic scene without errors or unsupported features and sends no
new geometry buffers during pickup. The original casualty tests still cover shot/dialog,
sound and laptop lifecycle behavior.

A standalone browser fixture was reviewed and recorded without connecting to an office,
starting workers, or sending terminal input. This checks appearance and choreography.
Headset motion, furniture clearance across the populated office, and sustained 90 Hz still
require the installed-client check described in `docs/vr-native-android.md`.
