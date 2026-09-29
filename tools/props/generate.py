"""Generate agent-office prop GLBs.

Run inside Blender:

    blender --background --python tools/props/generate.py

or from a live session (MCP / Text editor):

    exec(open("tools/props/generate.py").read())

Every prop is modelled in metres to match the office's procedural scale (a desk is
2.2 x 1.1 x 0.78), given a Principled BSDF material, decimated under the per-prop
triangle budget, and exported to `src/client/public/props/<name>.glb`. A manifest is
written alongside with the triangle count and bounds so the client and the tests can
assert the budget without parsing GLB binary chunks.
"""

from __future__ import annotations

import json
import math
import os
import shutil

import bpy
from mathutils import Matrix

# --------------------------------------------------------------------------------------
# config
# --------------------------------------------------------------------------------------

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT_DIR = os.path.join(REPO, "src", "client", "public", "props")
TRI_BUDGET = 8000
RENDER_SEGMENTS = 16  # cylinder/spheroid side resolution
BEVEL_SEGMENTS = 2
SMOOTH_ANGLE = math.radians(40)


# --------------------------------------------------------------------------------------
# scene helpers
# --------------------------------------------------------------------------------------


def reset_scene() -> None:
    """Empty the file so every prop is built from nothing."""
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras):
        for block in list(coll):
            if block.users == 0:
                coll.remove(block)


def material(name: str, color: str, roughness: float = 0.6, metallic: float = 0.0, **kw):
    """A Principled material. `color` is sRGB hex, converted to linear for the shader."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]

    rgb = srgb_to_linear(color)
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic

    for key, value in kw.items():
        socket = bsdf.inputs.get(_SOCKET_ALIASES.get(key, key))
        if socket is None:
            continue
        # A hex string on a colour socket becomes a linear RGBA vector.
        if isinstance(value, str) and len(socket.default_value) == 4 and value.startswith("#"):
            value = (*srgb_to_linear(value), 1.0)
        socket.default_value = value
    return mat


_SOCKET_ALIASES = {
    "emission": "Emission Color",
    "emission_strength": "Emission Strength",
    "sheen": "Sheen Weight",
    "coat": "Coat Weight",
    "alpha": "Alpha",
    "ior": "IOR",
}


def srgb_to_linear(hex_color: str) -> tuple[float, float, float]:
    h = hex_color.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i : i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def attach(obj, mat):
    obj = raw(obj)
    obj.data.materials.clear()
    obj.data.materials.append(mat)
    return obj


def raw(obj):
    """Unwrap a _ObjProxy back to the bpy object."""
    return obj._o if isinstance(obj, _ObjProxy) else obj


def bevel(obj, width: float, segments: int = BEVEL_SEGMENTS, angle: float = 50.0):
    """Bevel every edge over `angle` degrees. This is what makes props catch light."""
    mod = obj.modifiers.new("Bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(angle)
    mod.harden_normals = False
    return mod


def smooth(obj):
    """Angle-limited smooth shading; 4.1+ removed use_auto_smooth for this operator."""
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=SMOOTH_ANGLE)
    except (AttributeError, RuntimeError):
        bpy.ops.object.shade_smooth()
    return obj


def apply_modifiers(obj):
    bpy.context.view_layer.objects.active = obj
    for mod in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)


class _ObjProxy:
    """Wraps a bpy object so the prop builders can write `obj.rotation = (...)`.

    bpy exposes `rotation_euler`; the plain-attribute spelling keeps the prop code short
    and readable next to the three.js code it is replacing.
    """

    __slots__ = ("_o",)

    def __init__(self, obj):
        object.__setattr__(self, "_o", obj)

    def __getattr__(self, item):
        return getattr(object.__getattribute__(self, "_o"), item)

    def __setattr__(self, key, value):
        obj = object.__getattribute__(self, "_o")
        setattr(obj, "rotation_euler" if key == "rotation" else key, value)


def set_origin_to_bottom_center(obj):
    """Every prop sits on y=0 with its origin at the footprint centre, so the client can
    place it with a single position and no per-prop fudge offsets.

    The prop builders above author Y-up to match the three.js code they replace, so this
    runs after `upright()` has mapped Y-up onto Blender's Z-up.
    """
    xs = [v.co.x for v in obj.data.vertices]
    ys = [v.co.y for v in obj.data.vertices]
    zs = [v.co.z for v in obj.data.vertices]
    dx = (min(xs) + max(xs)) / 2
    dy = (min(ys) + max(ys)) / 2
    floor = min(zs)
    for vert in obj.data.vertices:
        vert.co.x -= dx
        vert.co.y -= dy
        vert.co.z -= floor
    return obj


def upright(obj):
    """Blender is Z-up, the prop code and three.js are Y-up.

    +90 degrees about X sends (x, y, z) -> (x, -z, y), so an authored +y becomes Blender
    +z and the prop stands up. The glTF exporter then applies its own +90 for the spec's
    Y-up, which cancels this one, so three.js receives the geometry as authored.
    """
    obj.data.transform(Matrix.Rotation(math.radians(90), 4, "X"))
    obj.data.update()
    return obj


def weld(obj, merge: float = 1e-4):
    """Join leaves a vertex per face corner seam, roughly doubling the buffer. Welding
    first is what keeps a prop's GLB in the tens of KB rather than the hundreds."""
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=merge)
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


def drop_uvs(obj):
    """No prop has a texture, so TEXCOORD_0 is 8 bytes per vertex of dead weight."""
    while obj.data.uv_layers:
        obj.data.uv_layers.remove(obj.data.uv_layers[0])
    return obj


# --------------------------------------------------------------------------------------
# primitive builders
# --------------------------------------------------------------------------------------


def box(name, size, loc=(0, 0, 0), rot=(0, 0, 0), bevel_w=0.0, bevel_seg=BEVEL_SEGMENTS):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel_w:
        bevel(obj, bevel_w, bevel_seg)
    return _ObjProxy(obj)


def cyl(name, radius, depth, loc=(0, 0, 0), rot=(0, 0, 0), verts=RENDER_SEGMENTS, bevel_w=0.0):
    """A cylinder standing along +Y, because every builder in this file places height on
    Y. Rotations still apply about the object's own axes after that lay-down."""
    bpy.ops.mesh.primitive_cylinder_add(
        radius=radius, depth=depth, location=loc, vertices=verts
    )
    obj = bpy.context.active_object
    obj.name = name
    obj.data.transform(Matrix.Rotation(math.radians(90), 4, "X"))  # Z-axis -> +Y
    obj.data.update()
    if rot != (0, 0, 0):
        obj.rotation_euler = rot
    if bevel_w:
        bevel(obj, bevel_w)
    return _ObjProxy(obj)


def cone(name, r1, r2, depth, loc=(0, 0, 0), rot=(0, 0, 0), verts=RENDER_SEGMENTS, bevel_w=0.0):
    """A truncated cone standing along +Y: r1 at the bottom, r2 at the top.

    -90 about X sends the primitive's +Z to +Y, so radius2 (the top) lands up and
    radius1 (the base) lands down - the same way a pot is widest at its rim-side base.
    """
    bpy.ops.mesh.primitive_cone_add(
        radius1=r1, radius2=r2, depth=depth, location=loc, vertices=verts
    )
    obj = bpy.context.active_object
    obj.name = name
    obj.data.transform(Matrix.Rotation(math.radians(-90), 4, "X"))
    obj.data.update()
    if rot != (0, 0, 0):
        obj.rotation_euler = rot
    if bevel_w:
        bevel(obj, bevel_w)
    return _ObjProxy(obj)


def sphere(name, radius, loc=(0, 0, 0), segs=RENDER_SEGMENTS, rings=RENDER_SEGMENTS // 2, scale=None):
    bpy.ops.mesh.primitive_uv_sphere_add(
        radius=radius, location=loc, segments=segs, ring_count=rings
    )
    obj = bpy.context.active_object
    obj.name = name
    if scale:
        # A bare number means "scale uniformly", the way a canopy blob is written.
        if isinstance(scale, (int, float)):
            scale = (scale, scale, scale)
        obj.scale = scale
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return _ObjProxy(obj)


def torus(name, major, minor, loc=(0, 0, 0), rot=(0, 0, 0), major_segs=RENDER_SEGMENTS, minor_segs=8):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major, minor_radius=minor, location=loc, rotation=rot,
        major_segments=major_segs, minor_segments=minor_segs,
    )
    obj = bpy.context.active_object
    obj.name = name
    return _ObjProxy(obj)


# --------------------------------------------------------------------------------------
# prop registry
# --------------------------------------------------------------------------------------


class Prop:
    """One prop to build. A plain class rather than a dataclass so the file also runs
    when exec'd without being registered in sys.modules (MCP, Blender's text editor)."""

    def __init__(self, name: str, build, tags: list[str]):
        self.name = name
        self.build = build
        self.tags = tags


REGISTRY: list[Prop] = []


def prop(name: str, *tags: str):
    def wrap(fn):
        REGISTRY.append(Prop(name=name, build=fn, tags=list(tags)))
        return fn

    return wrap


# Shared materials, created once per reset.
M = {}


def build_materials() -> None:
    M.clear()
    M.update({
        "fabric": material("Fabric", "#3d4457", roughness=0.92, sheen=0.6),
        "fabric_warm": material("FabricWarm", "#c1666f", roughness=0.9, sheen=0.5),
        "plastic_dark": material("PlasticDark", "#23262e", roughness=0.45),
        "plastic_black": material("PlasticBlack", "#14161b", roughness=0.35),
        "chrome": material("Chrome", "#c9ced6", roughness=0.22, metallic=1.0),
        "steel": material("Steel", "#9aa3b0", roughness=0.38, metallic=1.0),
        "alu": material("Alu", "#b9bfc8", roughness=0.3, metallic=1.0),
        "laminate": material("Laminate", "#e8e2d6", roughness=0.55),
        "oak": material("Oak", "#c99b62", roughness=0.5),
        "walnut": material("Walnut", "#7a5230", roughness=0.45),
        "paper": material("Paper", "#f4f1ea", roughness=0.85),
        "ceramic": material("Ceramic", "#f2f0ec", roughness=0.18, coat=0.6),
        "terracotta": material("Terracotta", "#c4703f", roughness=0.72),
        "soil": material("Soil", "#3a2a1e", roughness=0.95),
        "leaf": material("Leaf", "#4f9a4a", roughness=0.6),
        "leaf_dark": material("LeafDark", "#357038", roughness=0.62),
        "bark": material("Bark", "#6b4a32", roughness=0.88),
        "white_paint": material("WhitePaint", "#f0f0ee", roughness=0.4),
        "brass": material("Brass", "#c9a227", roughness=0.28, metallic=1.0),
        "glass_dark": material("GlassDark", "#15171c", roughness=0.12, coat=0.8),
        "bulb": material("Bulb", "#fff3d0", roughness=0.3, emission="#ffe08a", emission_strength=3.0),
        "screen_off": material("ScreenOff", "#0c0e12", roughness=0.08, coat=0.9),
        "neon": material("Neon", "#ff4fa3", roughness=0.2, emission="#ff4fa3", emission_strength=4.0),
        "rubber": material("Rubber", "#1b1d22", roughness=0.85),
        "concrete": material("Concrete", "#b9b6b0", roughness=0.88),
        "book_red": material("BookRed", "#c0392b", roughness=0.62),
        "book_blue": material("BookBlue", "#2f6f9f", roughness=0.62),
        "book_gold": material("BookGold", "#d4a24a", roughness=0.62),
        "book_green": material("BookGreen", "#3d7a4e", roughness=0.62),
        "book_cream": material("BookCream", "#e6dcc4", roughness=0.65),
    })


# --------------------------------------------------------------------------------------
# the 25 props
# --------------------------------------------------------------------------------------


@prop("chair", "desk", "meeting", "loft")
def build_chair():
    """Task chair: five-star base on castors, gas lift, upholstered seat and back.

    The backrest sits at +z, behind whoever is seated. The office places the worker at
    z = +0.93 facing -z toward the desk, so their back - and the backrest behind it -
    are toward +z, and +z is also the side away from the desk. A backrest on the other
    side sits between the worker and their desk.

    This is load-bearing, not cosmetic: `main.ts` turns `desk.chair` to face the desk
    when a worker is hired, and `leaving.ts` spins the chair as they get up, so the
    chair's origin and facing are part of how the office animates.
    """
    parts = []
    # five-star base + castors
    for i in range(5):
        a = i / 5 * math.tau
        leg = box(f"star{i}", (0.055, 0.045, 0.33), loc=(math.sin(a) * 0.17, 0.05, math.cos(a) * 0.17), rot=(0, a, 0), bevel_w=0.012)
        leg.location = (math.sin(a) * 0.17, 0.055, math.cos(a) * 0.17)
        parts.append((leg, M["plastic_dark"]))
        caster = cyl(f"castor{i}", 0.032, 0.022, verts=10)
        caster.rotation = (math.radians(90), 0, a)
        caster.location = (math.sin(a) * 0.33, 0.032, math.cos(a) * 0.33)
        parts.append((caster, M["rubber"]))
    parts.append((attach(cyl("hub", 0.07, 0.07, loc=(0, 0.07, 0), verts=12), M["plastic_dark"]), None))
    # gas lift
    parts.append((attach(cyl("lift", 0.032, 0.3, loc=(0, 0.25, 0), verts=12), M["chrome"]), None))
    parts.append((attach(cyl("lift_boot", 0.05, 0.12, loc=(0, 0.14, 0), verts=12), M["plastic_dark"]), None))
    # seat pan + cushion
    parts.append((attach(box("seat_shell", (0.5, 0.035, 0.48), loc=(0, 0.44, 0), bevel_w=0.02), M["plastic_dark"]), None))
    parts.append((attach(box("seat_pad", (0.48, 0.075, 0.46), loc=(0, 0.49, 0), bevel_w=0.045, bevel_seg=3), M["fabric"]), None))
    # back rest on a stem, behind the sitter at +z
    stem = box("back_stem", (0.07, 0.3, 0.05), loc=(0, 0.63, 0.21), rot=(math.radians(-10), 0, 0), bevel_w=0.014)
    parts.append((attach(stem, M["plastic_dark"]), None))
    back = box("back_pad", (0.46, 0.52, 0.075), loc=(0, 0.9, 0.26), rot=(math.radians(8), 0, 0), bevel_w=0.05, bevel_seg=3)
    parts.append((attach(back, M["fabric"]), None))
    # armrests
    for sx in (-1, 1):
        post = box(f"arm{sx}", (0.04, 0.17, 0.04), loc=(sx * 0.27, 0.58, 0.04), bevel_w=0.012)
        parts.append((attach(post, M["plastic_dark"]), None))
        pad = box(f"armpad{sx}", (0.06, 0.032, 0.22), loc=(sx * 0.27, 0.67, 0.02), bevel_w=0.014)
        parts.append((attach(pad, M["rubber"]), None))
    return parts


@prop("plant", "desk", "lounge")
def build_plant():
    """Potted plant: tapered pot, soil, and a canopy of clustered leaves."""
    parts = []
    pot = cone("pot", 0.22, 0.3, 0.44, loc=(0, 0.22, 0), verts=RENDER_SEGMENTS, bevel_w=0.015)
    parts.append((attach(pot, M["terracotta"]), None))
    lip = cyl("lip", 0.315, 0.05, loc=(0, 0.44, 0), verts=RENDER_SEGMENTS, bevel_w=0.012)
    parts.append((attach(lip, M["terracotta"]), None))
    soil = cyl("soil", 0.27, 0.03, loc=(0, 0.445, 0), verts=RENDER_SEGMENTS)
    parts.append((attach(soil, M["soil"]), None))
    # A canopy of rounded clusters, the way the procedural plant used overlapping
    # spheres, plus a few larger leaves for silhouette.
    for si, (loc, size, mat) in enumerate((
        ((0.0, 0.95, 0.0), 0.34, M["leaf"]),
        ((0.2, 1.2, 0.1), 0.24, M["leaf_dark"]),
        ((-0.18, 1.24, -0.08), 0.26, M["leaf"]),
        ((0.04, 1.45, -0.06), 0.2, M["leaf_dark"]),
    )):
        blob = sphere(f"canopy{si}", size, loc=loc, segs=14, rings=10)
        parts.append((attach(smooth(blob), mat), None))
    for si, (loc, size, mat) in enumerate((
        ((0.0, 0.7, 0.0), 0.055, M["leaf_dark"]),
        ((0.16, 0.8, 0.08), 0.05, M["leaf_dark"]),
        ((-0.14, 0.82, -0.06), 0.05, M["leaf_dark"]),
    )):
        stalk = cyl(f"stalk{si}", size, 0.42, loc=loc, verts=8)
        parts.append((attach(stalk, mat), None))
    for li in range(7):
        a = li / 7 * math.tau + 0.4
        leaf = box(f"leaf{li}", (0.26, 0.014, 0.1),
                   loc=(math.sin(a) * 0.24, 1.0 + (li % 3) * 0.14, math.cos(a) * 0.24),
                   rot=(0, a, math.radians(40)), bevel_w=0.018)
        parts.append((attach(leaf, M["leaf"] if li % 2 else M["leaf_dark"]), None))
    return parts


@prop("desk", "office")
def build_desk():
    """Work desk: laminate top on four steel legs, with a modesty panel."""
    W, D, H = 2.2, 1.1, 0.78
    parts = []
    top = box("top", (W, 0.07, D), loc=(0, H - 0.035, 0), bevel_w=0.02, bevel_seg=3)
    parts.append((attach(top, M["laminate"]), None))
    edge = box("edge", (W + 0.01, 0.022, D + 0.01), loc=(0, H - 0.075, 0), bevel_w=0.008)
    parts.append((attach(edge, M["walnut"]), None))
    for sx in (-1, 1):
        for sz in (-1, 1):
            leg = cyl(f"leg{sx}{sz}", 0.038, H - 0.09,
                      loc=(sx * (W / 2 - 0.14), (H - 0.09) / 2, sz * (D / 2 - 0.12)), verts=10)
            parts.append((attach(leg, M["steel"]), None))
            foot = cyl(f"foot{sx}{sz}", 0.05, 0.02,
                       loc=(sx * (W / 2 - 0.14), 0.01, sz * (D / 2 - 0.12)), verts=10)
            parts.append((attach(foot, M["rubber"]), None))
    panel = box("modesty", (W - 0.32, 0.34, 0.03), loc=(0, H - 0.27, -D / 2 + 0.07), bevel_w=0.012)
    parts.append((attach(panel, M["laminate"]), None))
    rail = box("rail", (W - 0.34, 0.05, 0.04), loc=(0, 0.1, -D / 2 + 0.07), bevel_w=0.01)
    parts.append((attach(rail, M["steel"]), None))
    return parts


@prop("beanbag", "lounge")
def build_beanbag():
    """Beanbag: a slumped squashed spheroid with a back bolster."""
    parts = []
    seat = sphere("seat", 0.6, loc=(0, 0.3, 0), segs=RENDER_SEGMENTS + 8, rings=10, scale=(1, 0.5, 1))
    parts.append((attach(smooth(seat), M["fabric_warm"]), None))
    back = sphere("back", 0.5, loc=(0, 0.55, 0.3), segs=RENDER_SEGMENTS, rings=8, scale=(1.05, 0.92, 0.68))
    parts.append((attach(smooth(back), M["fabric_warm"]), None))
    rim = torus("rim", 0.5, 0.045, loc=(0, 0.14, 0.06), major_segs=RENDER_SEGMENTS + 4)
    rim.scale = (1.05, 1.0, 0.95)
    parts.append((attach(smooth(rim), M["fabric"]), None))
    return parts


@prop("laptop-base", "desk")
def build_laptop():
    """Laptop lower half: aluminium deck, recessed keyboard, trackpad.

    The lid and the screen stay procedural in the client - the lid animates open and the
    screen is a live CanvasTexture, neither of which survives a static GLB.
    """
    parts = []
    deck = box("deck", (0.78, 0.032, 0.52), loc=(0, 0.016, 0.02), bevel_w=0.014, bevel_seg=3)
    parts.append((attach(deck, M["alu"]), None))
    well = box("kb_well", (0.66, 0.012, 0.235), loc=(0, 0.031, -0.02), bevel_w=0.006)
    parts.append((attach(well, M["plastic_black"]), None))
    rows, cols = 5, 14
    for r in range(rows):
        for c in range(cols):
            key = box(f"key{r}_{c}", (0.037, 0.008, 0.035),
                      loc=(-0.3 + c * 0.046, 0.038, -0.115 + r * 0.044), bevel_w=0.003)
            parts.append((attach(key, M["plastic_dark"]), None))
    pad = box("trackpad", (0.2, 0.006, 0.11), loc=(0, 0.035, 0.19), bevel_w=0.006)
    parts.append((attach(pad, M["alu"]), None))
    hinge = cyl("hinge", 0.02, 0.7, loc=(0, 0.03, -0.235), rot=(0, math.radians(90), 0), verts=10)
    parts.append((attach(hinge, M["alu"]), None))
    return parts


@prop("mug", "desk")
def build_mug():
    parts = []
    body = cyl("body", 0.055, 0.115, loc=(0, 0.058, 0), verts=RENDER_SEGMENTS, bevel_w=0.01)
    parts.append((attach(body, M["ceramic"]), None))
    inner = cyl("inner", 0.047, 0.02, loc=(0, 0.108, 0), verts=RENDER_SEGMENTS)
    parts.append((attach(inner, M["soil"]), None))
    handle = torus("handle", 0.032, 0.011, loc=(0.062, 0.06, 0), rot=(math.radians(90), 0, 0), major_segs=12, minor_segs=8)
    handle.scale = (1.0, 1.0, 0.8)
    parts.append((attach(smooth(handle), M["ceramic"]), None))
    return parts


@prop("book-stack", "desk")
def build_book_stack():
    parts = []
    mats = [M["book_red"], M["book_blue"], M["book_gold"]]
    for i, mat in enumerate(mats):
        w, d = 0.17 - i * 0.012, 0.24 - i * 0.014
        book = box(f"book{i}", (w, 0.045, d), loc=(i * 0.012, 0.025 + i * 0.047, -i * 0.01),
                   rot=(0, math.radians(6 * i), 0), bevel_w=0.008)
        parts.append((attach(book, mat), None))
        pages = box(f"pages{i}", (w - 0.016, 0.032, d - 0.014),
                    loc=(i * 0.012, 0.025 + i * 0.047, -i * 0.01), rot=(0, math.radians(6 * i), 0), bevel_w=0.004)
        parts.append((attach(pages, M["paper"]), None))
    return parts


@prop("bookshelf", "wall")
def build_bookshelf():
    """Bookshelf carcass. The ~200 books on its shelves are left procedural."""
    W, H, D = 1.8, 2.0, 0.34
    parts = []
    parts.append((attach(box("side_l", (0.04, H, D), loc=(-W / 2 + 0.02, H / 2, 0), bevel_w=0.01), M["walnut"]), None))
    parts.append((attach(box("side_r", (0.04, H, D), loc=(W / 2 - 0.02, H / 2, 0), bevel_w=0.01), M["walnut"]), None))
    parts.append((attach(box("back", (W, H, 0.02), loc=(0, H / 2, -D / 2 + 0.01), bevel_w=0.006), M["oak"]), None))
    parts.append((attach(box("top", (W, 0.045, D), loc=(0, H - 0.022, 0), bevel_w=0.01), M["walnut"]), None))
    parts.append((attach(box("bottom", (W, 0.05, D), loc=(0, 0.025, 0), bevel_w=0.01), M["walnut"]), None))
    for i in range(4):
        y = 0.05 + (H - 0.14) / 4 * i + (H - 0.14) / 8
        parts.append((attach(box(f"shelf{i}", (W - 0.08, 0.03, D - 0.02), loc=(0, y, 0.01), bevel_w=0.006), M["oak"]), None))
    return parts


@prop("pendant-lamp", "ceiling")
def build_pendant():
    parts = []
    parts.append((attach(cyl("cord", 0.008, 0.5, loc=(0, 0.75, 0), verts=6), M["plastic_black"]), None))
    parts.append((attach(cyl("canopy", 0.05, 0.03, loc=(0, 1.0, 0), verts=12), M["white_paint"]), None))
    shade = cone("shade", 0.42, 0.1, 0.36, loc=(0, 0.3, 0), verts=RENDER_SEGMENTS * 2, bevel_w=0.01)
    parts.append((attach(shade, M["brass"]), None))
    inner = cone("shade_in", 0.4, 0.095, 0.34, loc=(0, 0.3, 0), verts=RENDER_SEGMENTS * 2)
    parts.append((attach(inner, M["white_paint"]), None))
    parts.append((attach(sphere("bulb", 0.075, loc=(0, 0.14, 0), segs=12, rings=8), M["bulb"]), None))
    return parts


@prop("window-frame", "wall")
def build_window_frame():
    """Window frame and mullion. The pane stays procedural - it is transparent, 45x."""
    W, H, F, D = 1.5, 1.8, 0.09, 0.12
    parts = []
    for tag, y in (("top", H - F / 2), ("bot", F / 2)):
        parts.append((attach(box(tag, (W, F, D), loc=(0, y, 0), bevel_w=0.012), M["white_paint"]), None))
    for sx in (-1, 1):
        parts.append((attach(box(f"jamb{sx}", (F, H, D), loc=(sx * (W / 2 - F / 2), H / 2, 0), bevel_w=0.012), M["white_paint"]), None))
    parts.append((attach(box("mullion", (0.055, H - 2 * F, D * 0.8), loc=(0, H / 2, 0), bevel_w=0.008), M["white_paint"]), None))
    parts.append((attach(box("transom", (W - 2 * F, 0.05, D * 0.8), loc=(0, H * 0.68, 0), bevel_w=0.008), M["white_paint"]), None))
    return parts


@prop("stool", "lounge", "kitchen")
def build_stool():
    parts = []
    parts.append((attach(cyl("seat", 0.19, 0.05, loc=(0, 0.66, 0), verts=RENDER_SEGMENTS, bevel_w=0.014), M["oak"]), None))
    parts.append((attach(cyl("pad", 0.175, 0.03, loc=(0, 0.7, 0), verts=RENDER_SEGMENTS, bevel_w=0.012), M["fabric"]), None))
    parts.append((attach(cyl("ring", 0.16, 0.018, loc=(0, 0.22, 0), verts=RENDER_SEGMENTS), M["steel"]), None))
    for i in range(4):
        a = i / 4 * math.tau + math.radians(45)
        leg = cyl(f"leg{i}", 0.016, 0.66, loc=(math.sin(a) * 0.12, 0.33, math.cos(a) * 0.12),
                  rot=(math.cos(a) * 0.09, 0, -math.sin(a) * 0.09), verts=8)
        parts.append((attach(leg, M["steel"]), None))
    return parts


@prop("sofa", "lounge", "rooftop")
def build_sofa():
    W, D = 1.9, 0.85
    parts = []
    parts.append((attach(box("base", (W, 0.28, D), loc=(0, 0.3, 0), bevel_w=0.05, bevel_seg=3), M["fabric"]), None))
    for sx in (-1, 1):
        parts.append((attach(box(f"arm{sx}", (0.16, 0.34, D), loc=(sx * (W / 2 - 0.08), 0.5, 0), bevel_w=0.06, bevel_seg=3), M["fabric"]), None))
    parts.append((attach(box("back", (W - 0.32, 0.5, 0.18), loc=(0, 0.72, -D / 2 + 0.09), bevel_w=0.06, bevel_seg=3), M["fabric"]), None))
    for i, sx in enumerate((-0.45, 0.45)):
        parts.append((attach(box(f"cushion{i}", (0.82, 0.16, D - 0.24), loc=(sx, 0.52, 0.06), bevel_w=0.06, bevel_seg=3), M["fabric_warm"]), None))
        parts.append((attach(box(f"pillow{i}", (0.36, 0.34, 0.12), loc=(sx, 0.78, -D / 2 + 0.2), rot=(0, 0, math.radians(4 * (1 if i else -1))), bevel_w=0.05, bevel_seg=3), M["book_cream"]), None))
    for sx in (-1, 1):
        for sz in (-1, 1):
            parts.append((attach(cyl(f"foot{sx}{sz}", 0.03, 0.18, loc=(sx * (W / 2 - 0.12), 0.09, sz * (D / 2 - 0.12)), verts=8), M["walnut"]), None))
    return parts


@prop("coffee-table", "lounge")
def build_coffee_table():
    W, D, H = 1.1, 0.6, 0.42
    parts = []
    parts.append((attach(box("top", (W, 0.05, D), loc=(0, H - 0.025, 0), bevel_w=0.02, bevel_seg=3), M["walnut"]), None))
    parts.append((attach(box("shelf", (W - 0.16, 0.025, D - 0.14), loc=(0, 0.12, 0), bevel_w=0.01), M["oak"]), None))
    for sx in (-1, 1):
        for sz in (-1, 1):
            parts.append((attach(cyl(f"leg{sx}{sz}", 0.022, H - 0.05,
                                    loc=(sx * (W / 2 - 0.08), (H - 0.05) / 2, sz * (D / 2 - 0.08)), verts=8), M["steel"]), None))
    parts.append((attach(box("drawer", (0.4, 0.1, D - 0.16), loc=(0.28, H - 0.11, 0), bevel_w=0.012), M["oak"]), None))
    return parts


@prop("rug", "floor")
def build_rug():
    parts = []
    parts.append((attach(box("pile", (2.4, 0.02, 1.7), loc=(0, 0.01, 0), bevel_w=0.03, bevel_seg=2), M["book_cream"]), None))
    parts.append((attach(box("border", (2.24, 0.022, 1.54), loc=(0, 0.012, 0), bevel_w=0.02), M["book_blue"]), None))
    parts.append((attach(box("field", (2.02, 0.024, 1.32), loc=(0, 0.014, 0), bevel_w=0.02), M["book_green"]), None))
    return parts


@prop("whiteboard", "wall")
def build_whiteboard():
    W, H = 1.6, 1.1
    parts = []
    parts.append((attach(box("face", (W, 0.03, H), loc=(0, 1.05, 0), bevel_w=0.012), M["white_paint"]), None))
    parts.append((attach(box("trim", (W + 0.06, 0.05, H + 0.06), loc=(0, 1.05, 0.012), bevel_w=0.014), M["alu"]), None))
    parts.append((attach(box("tray", (W * 0.7, 0.04, 0.09), loc=(0, 0.52, 0.05), bevel_w=0.01), M["alu"]), None))
    for i, mat in enumerate((M["book_red"], M["book_blue"], M["book_green"])):
        parts.append((attach(cyl(f"marker{i}", 0.011, 0.13, loc=(-0.2 + i * 0.1, 0.56, 0.05), rot=(math.radians(90), 0, 0), verts=8), mat), None))
    for sx in (-1, 1):
        parts.append((attach(cyl(f"post{sx}", 0.022, 0.5, loc=(sx * (W / 2 - 0.05), 0.25, 0), verts=8), M["alu"]), None))
        for sz in (-1, 1):
            wheel = cyl(f"wheel{sx}{sz}", 0.035, 0.024, loc=(sx * (W / 2 - 0.05), 0.035, sz * 0.06), rot=(math.radians(90), 0, 0), verts=10)
            parts.append((attach(wheel, M["rubber"]), None))
    return parts


@prop("coffee-machine", "kitchen")
def build_coffee_machine():
    W, D, H = 0.34, 0.4, 0.62
    parts = []
    parts.append((attach(box("body", (W, H * 0.72, D), loc=(0, H * 0.36, 0), bevel_w=0.02, bevel_seg=3), M["plastic_black"]), None))
    parts.append((attach(box("head", (W, 0.14, D * 0.92), loc=(0, H * 0.78, 0), bevel_w=0.018), M["steel"]), None))
    parts.append((attach(box("drip", (W * 0.8, 0.04, D * 0.6), loc=(0, H * 0.5, 0.02), bevel_w=0.008), M["steel"]), None))
    parts.append((attach(box("tray", (W * 0.86, 0.03, D * 0.62), loc=(0, 0.09, 0.06), bevel_w=0.008), M["steel"]), None))
    parts.append((attach(box("tank", (W * 0.4, 0.24, D * 0.5), loc=(-W / 2 - 0.05, H * 0.6, -0.04), bevel_w=0.014), M["glass_dark"]), None))
    parts.append((attach(cyl("gauge", 0.05, 0.02, loc=(0.06, H * 0.8, D / 2 + 0.005), rot=(math.radians(90), 0, 0), verts=12), M["brass"]), None))
    parts.append((attach(box("panel", (W * 0.7, 0.08, 0.015), loc=(0, H * 0.9, D / 2 + 0.005), bevel_w=0.006), M["brass"]), None))
    for i in range(3):
        parts.append((attach(sphere(f"btn{i}", 0.014, loc=(-0.06 + i * 0.06, H * 0.9, D / 2 + 0.018), segs=8, rings=6), M["neon"]), None))
    return parts


@prop("fridge", "kitchen")
def build_fridge():
    W, D, H = 0.72, 0.7, 1.8
    parts = []
    parts.append((attach(box("shell", (W, H, D), loc=(0, H / 2, 0), bevel_w=0.02, bevel_seg=3), M["steel"]), None))
    for tag, y, h in (("freezer", H * 0.78, H * 0.42), ("fridge", H * 0.36, H * 0.6)):
        parts.append((attach(box(tag, (W - 0.03, h - 0.02, 0.03), loc=(0, y, D / 2 + 0.01), bevel_w=0.012), M["glass_dark"]), None))
        parts.append((attach(box(f"{tag}_h", (0.03, h * 0.6, 0.05), loc=(W / 2 - 0.05, y, D / 2 + 0.045), bevel_w=0.012), M["alu"]), None))
    parts.append((attach(box("feet", (W - 0.1, 0.06, D - 0.1), loc=(0, 0.03, 0), bevel_w=0.01), M["rubber"]), None))
    return parts


@prop("cabinet", "arcade")
def build_cabinet():
    W, D, H = 0.72, 0.82, 1.85
    parts = []
    parts.append((attach(box("body", (W, H, D), loc=(0, H / 2, 0), bevel_w=0.018, bevel_seg=3), M["plastic_black"]), None))
    parts.append((attach(box("side_l", (0.02, H - 0.1, D - 0.06), loc=(-W / 2 - 0.005, H / 2, 0), bevel_w=0.008), M["book_blue"]), None))
    parts.append((attach(box("side_r", (0.02, H - 0.1, D - 0.06), loc=(W / 2 + 0.005, H / 2, 0), bevel_w=0.008), M["book_red"]), None))
    parts.append((attach(box("marquee", (W - 0.06, 0.26, 0.04), loc=(0, H - 0.16, D / 2 + 0.02), bevel_w=0.01), M["neon"]), None))
    parts.append((attach(box("screen_bezel", (W - 0.12, 0.4, 0.05), loc=(0, H * 0.66, D / 2 - 0.02), bevel_w=0.012), M["plastic_black"]), None))
    parts.append((attach(box("screen", (W - 0.2, 0.3, 0.01), loc=(0, H * 0.66, D / 2 + 0.005), bevel_w=0.004), M["screen_off"]), None))
    parts.append((attach(box("panel", (W - 0.1, 0.24, 0.06), loc=(0, H * 0.4, D / 2 + 0.01), bevel_w=0.01), M["alu"]), None))
    for sx in (-1, 1):
        parts.append((attach(cyl(f"stick{sx}", 0.014, 0.09, loc=(sx * 0.12, H * 0.4, D / 2 + 0.05), verts=8), M["plastic_black"]), None))
        parts.append((attach(sphere(f"ball{sx}", 0.026, loc=(sx * 0.12, H * 0.36, D / 2 + 0.05), segs=10, rings=8), M["book_red"]), None))
    return parts


@prop("street-lamp", "street")
def build_street_lamp():
    H = 4.2
    parts = []
    parts.append((attach(cone("base", 0.16, 0.11, 0.4, loc=(0, 0.2, 0), verts=12, bevel_w=0.015), M["steel"]), None))
    parts.append((attach(cyl("post", 0.055, H - 0.4, loc=(0, 0.4 + (H - 0.4) / 2, 0), verts=12), M["steel"]), None))
    arm = cyl("arm", 0.04, 0.5, loc=(0.22, H - 0.08, 0), rot=(0, math.radians(90), math.radians(18)), verts=10)
    parts.append((attach(arm, M["steel"]), None))
    parts.append((attach(box("head", (0.3, 0.1, 0.2), loc=(0.42, H - 0.24, 0), bevel_w=0.02), M["steel"]), None))
    parts.append((attach(box("lens", (0.24, 0.03, 0.16), loc=(0.42, H - 0.3, 0), bevel_w=0.008), M["bulb"]), None))
    return parts


@prop("tree", "street")
def build_tree():
    parts = []
    trunk = cone("trunk", 0.2, 0.3, 2.2, loc=(0, 1.1, 0), verts=10)
    parts.append((attach(trunk, M["bark"]), None))
    for i, (loc, scale, mat) in enumerate((
        ((0, 3.1, 0), 1.5, M["leaf"]),
        ((0.75, 3.8, 0.4), 1.05, M["leaf_dark"]),
        ((-0.65, 3.7, -0.3), 0.95, M["leaf"]),
        ((0.15, 4.2, -0.5), 0.8, M["leaf_dark"]),
    )):
        blob = sphere(f"canopy{i}", 1.0, loc=loc, segs=12, rings=8, scale=scale)
        parts.append((attach(smooth(blob), mat), None))
    for i in range(3):
        a = i / 3 * math.tau
        br = cyl(f"branch{i}", 0.05, 1.0, loc=(math.sin(a) * 0.35, 2.3, math.cos(a) * 0.35),
                 rot=(math.cos(a) * 0.5, 0, -math.sin(a) * 0.5), verts=6)
        parts.append((attach(br, M["bark"]), None))
    return parts


@prop("jukebox", "lounge")
def build_jukebox():
    W, D, H = 0.9, 0.55, 1.5
    parts = []
    body = box("body", (W, H * 0.9, D), loc=(0, H * 0.45 + 0.1, 0), bevel_w=0.03, bevel_seg=3)
    parts.append((attach(body, M["walnut"]), None))
    arch = cyl("arch", W / 2, 0.3, loc=(0, H * 0.9 + 0.15, 0), rot=(0, math.radians(90), 0), verts=16, bevel_w=0.02)
    arch.scale = (1.0, 1.0, 0.6)
    parts.append((attach(arch, M["walnut"]), None))
    parts.append((attach(cyl("grille", 0.3, 0.04, loc=(0, H * 0.68, D / 2 + 0.01), rot=(math.radians(90), 0, 0), verts=16), M["brass"]), None))
    for i in range(6):
        parts.append((attach(box(f"bar{i}", (0.4, 0.022, 0.03), loc=(0, H * 0.5 + i * 0.045, D / 2 + 0.02), bevel_w=0.006), M["neon"]), None))
    parts.append((attach(cyl("plate", 0.12, 0.02, loc=(0, H * 0.9 + 0.2, D / 2 * 0.8), rot=(math.radians(90), 0, 0), verts=16), M["brass"]), None))
    parts.append((attach(box("plinth", (W, 0.12, D), loc=(0, 0.06, 0), bevel_w=0.014), M["walnut"]), None))
    return parts


@prop("basketball-hoop", "sports")
def build_hoop():
    B, H = 1.8, 3.05
    parts = []
    parts.append((attach(box("board", (B * 0.62, 1.05, 0.06), loc=(0, H, -0.35), bevel_w=0.014), M["white_paint"]), None))
    parts.append((attach(box("edge", (B * 0.62 + 0.05, 1.1, 0.03), loc=(0, H, -0.38), bevel_w=0.01), M["book_red"]), None))
    parts.append((attach(box("square", (0.6, 0.45, 0.02), loc=(0, H - 0.16, -0.31), bevel_w=0.006), M["book_red"]), None))
    parts.append((attach(cyl("rim", 0.23, 0.03, loc=(0, H - 0.42, -0.05), verts=RENDER_SEGMENTS), M["book_red"]), None))
    for i in range(10):
        a = i / 10 * math.tau
        net = cyl(f"net{i}", 0.004, 0.42, loc=(math.sin(a) * 0.22, H - 0.63, -0.05 + math.cos(a) * 0.22),
                  rot=(math.cos(a) * 0.16, 0, -math.sin(a) * 0.16), verts=4)
        parts.append((attach(net, M["white_paint"]), None))
    parts.append((attach(box("arm", (0.12, 0.12, 0.4), loc=(0, H + 0.2, -0.56), bevel_w=0.016), M["steel"]), None))
    return parts


@prop("desk-lamp", "desk")
def build_desk_lamp():
    parts = []
    parts.append((attach(cyl("foot", 0.09, 0.025, loc=(0, 0.013, 0), verts=RENDER_SEGMENTS, bevel_w=0.008), M["brass"]), None))
    parts.append((attach(cyl("stem", 0.012, 0.4, loc=(0, 0.22, 0), verts=8), M["brass"]), None))
    arm = cyl("arm", 0.012, 0.26, loc=(0.09, 0.44, 0), rot=(0, math.radians(-55), math.radians(28)), verts=8)
    parts.append((attach(arm, M["brass"]), None))
    parts.append((attach(cone("shade", 0.1, 0.05, 0.14, loc=(0.21, 0.48, 0), rot=(0, 0, math.radians(150)), verts=RENDER_SEGMENTS, bevel_w=0.008), M["brass"]), None))
    parts.append((attach(sphere("bulb", 0.035, loc=(0.23, 0.43, 0), segs=10, rings=6), M["bulb"]), None))
    return parts


@prop("trash-bin", "office")
def build_trash_bin():
    parts = []
    parts.append((attach(cone("body", 0.17, 0.21, 0.56, loc=(0, 0.28, 0), verts=RENDER_SEGMENTS, bevel_w=0.012), M["steel"]), None))
    parts.append((attach(cyl("lid", 0.225, 0.04, loc=(0, 0.575, 0), verts=RENDER_SEGMENTS, bevel_w=0.012), M["steel"]), None))
    parts.append((attach(cyl("hole", 0.12, 0.03, loc=(0, 0.6, 0), verts=RENDER_SEGMENTS), M["rubber"]), None))
    parts.append((attach(cyl("rim", 0.215, 0.03, loc=(0, 0.045, 0), verts=RENDER_SEGMENTS), M["rubber"]), None))
    return parts


@prop("wall-clock", "wall")
def build_wall_clock():
    parts = []
    parts.append((attach(cyl("case", 0.22, 0.06, loc=(0, 0, 0), rot=(math.radians(90), 0, 0), verts=RENDER_SEGMENTS * 2, bevel_w=0.01), M["white_paint"]), None))
    parts.append((attach(cyl("face", 0.2, 0.01, loc=(0, 0, 0.035), rot=(math.radians(90), 0, 0), verts=RENDER_SEGMENTS * 2), M["paper"]), None))
    parts.append((attach(cyl("bezel", 0.235, 0.03, loc=(0, 0, 0.02), rot=(math.radians(90), 0, 0), verts=RENDER_SEGMENTS * 2, bevel_w=0.008), M["steel"]), None))
    for i in range(12):
        a = i / 12 * math.tau
        long = 0.045 if i % 3 == 0 else 0.026
        tick = box(f"tick{i}", (0.012, long, 0.004), loc=(math.sin(a) * (0.17 - long / 2), math.cos(a) * (0.17 - long / 2), 0.043), rot=(0, 0, -a))
        parts.append((attach(tick, M["plastic_dark"]), None))
    hand_h = box("hand_h", (0.014, 0.1, 0.005), loc=(0.03, 0.04, 0.05), rot=(0, 0, math.radians(-35)))
    parts.append((attach(hand_h, M["plastic_dark"]), None))
    hand_m = box("hand_m", (0.01, 0.14, 0.005), loc=(0.06, 0.05, 0.055), rot=(0, 0, math.radians(60)))
    parts.append((attach(hand_m, M["plastic_dark"]), None))
    parts.append((attach(cyl("pin", 0.014, 0.01, loc=(0, 0, 0.06), rot=(math.radians(90), 0, 0), verts=10), M["brass"]), None))
    return parts


# --------------------------------------------------------------------------------------
# build / measure / export
# --------------------------------------------------------------------------------------


def assemble(parts):
    """Join every part, applying modifiers first so the mesh is final before merging."""
    meshes = []
    for entry in parts:
        obj, mat_override = entry if isinstance(entry, tuple) and len(entry) == 2 else (entry, None)
        obj = raw(obj)
        if mat_override is not None:
            obj = attach(obj, mat_override)
        elif not obj.data.materials:
            obj = attach(obj, M["plastic_dark"])
        apply_modifiers(obj)
        meshes.append(obj)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    joined = bpy.context.active_object
    upright(joined)
    drop_uvs(joined)
    weld(joined)
    set_origin_to_bottom_center(joined)
    return joined


def tri_count(obj) -> int:
    return sum(max(len(poly.vertices) - 2, 0) for poly in obj.data.polygons)


def decimate_to_budget(obj, budget: int) -> tuple[int, float]:
    """Drop to the budget with a decimate modifier. Returns (before, after)."""
    before = tri_count(obj)
    if before <= budget:
        return before, before
    ratio = max(budget / before, 0.05)
    mod = obj.modifiers.new("Decimate", "DECIMATE")
    mod.ratio = ratio
    mod.decimate_type = "COLLAPSE"
    mod.use_collapse_triangulate = True
    apply_modifiers(obj)
    return before, tri_count(obj)


def bounds(obj) -> dict:
    """Three.js-space bounds, so the numbers can be compared against the procedural props
    these replace.

    After `upright()` the mesh is Blender Z-up, and the exporter's own +90 about X turns
    that into glTF Y-up: three_x = blender_x, three_y = blender_z, three_z = -blender_y.
    """
    xs = [v.co.x for v in obj.data.vertices]
    ys = [v.co.y for v in obj.data.vertices]
    zs = [v.co.z for v in obj.data.vertices]

    def span(v):
        return round(max(v) - min(v), 4)

    return {"width": span(xs), "height": span(zs), "depth": span(ys)}


def export(obj, name: str) -> str:
    path = os.path.join(OUT_DIR, f"{name}.glb")
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        # Draco quantises positions and normals, which takes a prop from ~95 KB to ~20 KB
        # with no visible change at office viewing distance. The client decodes it with
        # DRACOLoader; see src/client/world/props.ts.
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
        export_draco_position_quantization=14,
        export_draco_normal_quantization=10,
        export_draco_texcoord_quantization=12,
        export_draco_generic_quantization=12,
    )
    return path


def generate() -> dict:
    if os.path.isdir(OUT_DIR):
        shutil.rmtree(OUT_DIR)
    os.makedirs(OUT_DIR, exist_ok=True)

    manifest = {}
    for entry in REGISTRY:
        reset_scene()
        build_materials()
        obj = assemble(entry.build())
        before, after = decimate_to_budget(obj, TRI_BUDGET)
        path = export(obj, entry.name)
        size = os.path.getsize(path)
        manifest[entry.name] = {
            "url": f"/props/{entry.name}.glb",
            "triangles": after,
            "bytes": size,
            "materials": len(obj.data.materials),
            "tags": entry.tags,
            **bounds(obj),
        }
        print(f"{entry.name:20s} tris {before:6d} -> {after:6d}  {size / 1024:7.1f} KB  mats {len(obj.data.materials)}")

    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True)
    return manifest


def contact_sheet(out_path: str, cols: int = 5, res: int = 480) -> str:
    """Renders every prop under a neutral studio light so the materials can be eyeballed.

    Colours live in the Principled BSDF, so a render is the only honest check that a
    prop came out the colour it was authored - a screenshot of the viewport would show
    solid-mode grey instead.
    """
    reset_scene()
    build_materials()

    built = []
    for entry in REGISTRY:
        obj = assemble(entry.build())
        decimate_to_budget(obj, TRI_BUDGET)
        built.append((entry, raw(obj)))

    # Lay them out on a grid, scaled to a uniform cell so small props are still legible.
    # The meshes are Z-up inside Blender (see `upright`), so the grid runs on X/Y.
    cell = 2.6
    rows = math.ceil(len(built) / cols)
    for i, (_, obj) in enumerate(built):
        xs = [v.co.x for v in obj.data.vertices]
        ys = [v.co.y for v in obj.data.vertices]
        zs = [v.co.z for v in obj.data.vertices]
        tallest = max(max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)) or 1.0
        s = (cell * 0.42) / tallest
        col, row = i % cols, i // cols
        obj.scale = (s, s, s)
        obj.location = (
            (col - (cols - 1) / 2) * cell,
            ((rows - 1) / 2 - row) * cell,
            0.0,
        )

    bpy.ops.mesh.primitive_plane_add(size=cols * cell * 1.6, location=(0, 0, -0.001))
    attach(bpy.context.active_object, material("Backdrop", "#dfe3e8", roughness=0.95))

    # Key + fill + world, so the render reads like the office's soft indoor light.
    def area_light(loc, power, size, color):
        bpy.ops.object.light_add(type="AREA", location=loc)
        lamp = bpy.context.active_object
        lamp.data.energy = power
        lamp.data.size = size
        lamp.data.color = color
        return lamp

    area_light((5, -6, 9), 1400, 7, (1.0, 0.97, 0.92))
    area_light((-6, 4, 5), 500, 9, (0.86, 0.91, 1.0))
    world = bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.62, 0.66, 0.72, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.55

    # Fit the whole grid: frame its bounding box and back the camera off by the
    # horizontal field of view, so nothing spills past the frame edge.
    # An orthographic camera: for a contact sheet, every cell comes out the same size
    # regardless of how far back the camera sits, so nothing is cropped or lost in haze.
    grid_w, grid_h = cols * cell, rows * cell
    cam_data = bpy.data.cameras.new("Cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = max(grid_w, grid_h) * 1.06
    cam = bpy.data.objects.new("Cam", cam_data)
    bpy.context.collection.objects.link(cam)
    tilt = math.radians(38)  # off vertical, so props read as objects rather than plans
    dist = max(grid_w, grid_h)
    cam.location = (0, -math.sin(tilt) * dist * 0.5, math.cos(tilt) * dist)
    bpy.context.scene.camera = cam

    target = bpy.data.objects.new("CamTarget", None)
    target.location = (0, 0, cell * 0.25)
    bpy.context.collection.objects.link(target)
    track = cam.constraints.new("TRACK_TO")
    track.target = target
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"

    scene = bpy.context.scene
    # EEVEE_NEXT from 4.2 on; the stock name is a safe fallback if a build ever lacks it.
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = cols * res
    scene.render.resolution_y = rows * res
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    try:
        scene.view_settings.view_transform = "AgX"
    except TypeError:
        scene.view_settings.view_transform = "Filmic"
    scene.render.filepath = out_path
    bpy.ops.render.render(write_still=True)
    return out_path


if __name__ == "__main__":
    result = generate()
    total = sum(v["triangles"] for v in result.values())
    over = [k for k, v in result.items() if v["triangles"] > TRI_BUDGET]
    print(f"\n{len(result)} props, {total} triangles total, budget {TRI_BUDGET}/prop")
    print("OVER BUDGET: " + (", ".join(over) if over else "none"))
