# Medic collection sequence

The casualty presentation is shared by the desktop scene and the installed native client.
`src/client/world/casualties.ts` handles visuals and sound callbacks. `worker.shoot` starts a
server-owned, persisted 30-second revival deadline without stopping the worker or its PTY.
There is no confirmation dialog: walking within 2.4 metres of the body and pressing E sends
`worker.revive`, restoring it to its seat with its session untouched. If the deadline expires,
the server dismisses the worker and deletes its owned worktrees and branches, even with
uncommitted or unpublished work. Collection starts when that worker's removal arrives.
Every client on the floor renders the downed state and the medic sequence.
In the headset nothing opens either, and the revival is the use action with a free hand at the
body (see the gun section of [the controller interactions](vr-native-controller-interactions.md)).
Each body has its own scene, so several can be down at once. Given the bullet's direction and
the shooter's eyes (the headset's own shots, which go down at once rather than waiting for the
server's echo), the body reels from the hit instead of tumbling: thrown back out of its chair
along the bullet, it staggers away from the shot onto its feet beside the chair, then goes over
backwards onto the open floor, where the shooter can see it past the furniture round it (see the
gun section of [the controller interactions](vr-native-controller-interactions.md)). Without a
bullet (the desktop, and other clients) it tumbles out sideways. Either way it lands with its
length flat along the floor and its lowest point on it, so the medics, a reaching hand and the
blood pool all meet it at floor level; a reeled body's pool spreads under its chest, and its
flung-out arms come in to its sides as it settles onto the stretcher or gets back up.

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
new geometry buffers during pickup. The original casualty tests still cover shooting, nearby
revival, sound and laptop lifecycle behavior.

A standalone browser fixture was reviewed and recorded without connecting to an office,
starting workers, or sending terminal input. This checks appearance and choreography.
Headset motion, furniture clearance across the populated office, and sustained 90 Hz still
require the installed-client check described in `docs/vr-native-android.md`.
