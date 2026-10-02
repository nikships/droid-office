"""Generate droid-office prop GLBs.

Run inside Blender:

    blender --background --python tools/props/generate.py

or from a live session (MCP / Text editor):

    import importlib.util
    spec = importlib.util.spec_from_file_location("propsgen", "tools/props/generate.py")
    propsgen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(propsgen)

Rebuild only some props, merging into the existing manifest (rows without a builder,
and their GLBs, are dropped; everything else stays byte-identical):

    blender --background --python tools/props/generate.py -- macbook-base macbook-lid

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
import sys

import bpy
from mathutils import Matrix, Vector

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
    """Untextured props do not need TEXCOORD_0's eight bytes per vertex."""
    while obj.data.uv_layers:
        obj.data.uv_layers.remove(obj.data.uv_layers[0])
    return obj


def flip_uvs_v(obj):
    """Mirror a mesh's UVs vertically, in place."""
    obj = raw(obj)
    for layer in obj.data.uv_layers:
        for uv_data in layer.data:
            uv_data.uv = (uv_data.uv.x, 1.0 - uv_data.uv.y)
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


def plane(name, size, loc=(0, 0, 0)):
    """An XY plane facing +Z with canonical 0..1 UVs, `size` in (width, height).

    For the laptop's display: the one prop part that keeps its UVs, because the client
    paints the live terminal onto it as a texture.
    """
    bpy.ops.mesh.primitive_plane_add(size=1, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = (size[0], size[1], 1)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return _ObjProxy(obj)


# --------------------------------------------------------------------------------------
# prop registry
# --------------------------------------------------------------------------------------


class Prop:
    """One prop to build. A plain class rather than a dataclass so the file also runs
    when exec'd without being registered in sys.modules (MCP, Blender's text editor).

    `recenter` parks the prop's origin at its footprint centre; props authored in
    another node's space (the laptop's base and lid) turn it off. A `multipart` build
    returns (body_parts, loose_parts) instead of one parts list: the body joins into a
    single mesh as usual, and each loose (name, object, material) exports as its own
    node, so the client can find it by name. `keep_uvs` preserves embedded palette
    atlas coordinates; existing untextured props still drop their body UVs.
    """

    def __init__(self, name: str, build, tags: list[str], recenter: bool = True, multipart: bool = False, keep_uvs: bool = False):
        self.name = name
        self.build = build
        self.tags = tags
        self.recenter = recenter
        self.multipart = multipart
        self.keep_uvs = keep_uvs


REGISTRY: list[Prop] = []


def prop(name: str, *tags: str, recenter: bool = True, multipart: bool = False, keep_uvs: bool = False):
    def wrap(fn):
        REGISTRY.append(Prop(name=name, build=fn, tags=list(tags), recenter=recenter, multipart=multipart, keep_uvs=keep_uvs))
        return fn

    return wrap


# Shared materials, created once per reset.
M = {}


def build_materials() -> None:
    M.clear()
    M.update({
        "plastic_dark": material("PlasticDark", "#23262e", roughness=0.45),
        "plastic_black": material("PlasticBlack", "#14161b", roughness=0.35),
        "chrome": material("Chrome", "#c9ced6", roughness=0.22, metallic=1.0),
        "glass_dark": material("GlassDark", "#15171c", roughness=0.12, coat=0.8),
        "screen_off": material("ScreenOff", "#0c0e12", roughness=0.08, coat=0.9),
        "rubber": material("Rubber", "#1b1d22", roughness=0.85),
        # The office has no environment map, so a full-metal body would render near
        # black: these keep enough diffuse to read as aluminium under the room lights.
        "mac_body": material("MacbookBody", "#5b5e63", roughness=0.45, metallic=0.6),
        "mac_key": material("MacbookKey", "#17181c", roughness=0.5),
        "mac_pad": material("MacbookPad", "#7a7e85", roughness=0.5, metallic=0.6),
    })


# --------------------------------------------------------------------------------------
#------------------------------------------------------------------------------
# the MacBook’s two halves
#------------------------------------------------------------------------------


@prop("macbook-base", "desk", recenter=False)
def build_macbook_base():
    """MacBook Pro lower half: a space-grey unibody deck on rubber strips, a black
    keyboard tray with staggered rows and a wide spacebar, speaker grilles, a glass
    trackpad in a seam, side ports, and the hinge barrel the lid turns in.

    Authored in the laptop's own space (deck z -0.24..0.28, strips on y=0), so the GLB
    drops onto the desk with no offset and the hinge lands under the lid's pivot.
    """
    parts = []
    parts.append((attach(smooth(box("deck", (0.78, 0.032, 0.52), loc=(0, 0.021, 0.02), bevel_w=0.012, bevel_seg=3)), M["mac_body"]), None))
    for tag, z in (("rear", -0.18), ("front", 0.22)):
        parts.append((attach(box(f"strip_{tag}", (0.6, 0.005, 0.025), loc=(0, 0.0025, z), bevel_w=0.002), M["rubber"]), None))
    parts.append((attach(box("kb_tray", (0.72, 0.010, 0.25), loc=(0, 0.035, -0.045), bevel_w=0.006), M["plastic_black"]), None))
    rows, cols, pitch = 5, 14, 0.047
    for r in range(rows):
        for c in range(cols):
            if r == rows - 1 and 4 <= c <= 9:
                continue  # the spacebar covers the bottom middle
            key = box(f"key{r}_{c}", (0.041, 0.008, 0.037),
                      loc=((c - (cols - 1) / 2) * pitch + r * 0.005, 0.044, -0.045 + (r - 2) * 0.044),
                      bevel_w=0.002, bevel_seg=1)
            parts.append((attach(key, M["mac_key"]), None))
    parts.append((attach(box("spacebar", (6 * pitch - 0.006, 0.008, 0.037), loc=((rows - 1) * 0.005, 0.044, 0.043), bevel_w=0.002, bevel_seg=1), M["mac_key"]), None))
    for sx in (-1, 1):
        parts.append((attach(box(f"grille{sx}", (0.025, 0.004, 0.24), loc=(sx * 0.3725, 0.038, -0.045)), M["plastic_black"]), None))
    parts.append((attach(box("pad_seam", (0.248, 0.003, 0.158), loc=(0, 0.0375, 0.155)), M["plastic_black"]), None))
    parts.append((attach(box("pad", (0.24, 0.004, 0.15), loc=(0, 0.038, 0.155), bevel_w=0.002), M["mac_pad"]), None))
    parts.append((attach(box("scoop", (0.14, 0.010, 0.012), loc=(0, 0.032, 0.276), bevel_w=0.003), M["plastic_black"]), None))
    # The hinge barrel along X: cyl() stands parts along Y, and Z+90 lays Y onto X.
    hinge = cyl("hinge", 0.018, 0.66, loc=(0, 0.030, -0.245), rot=(0, 0, math.radians(90)), verts=12)
    parts.append((attach(hinge, M["plastic_black"]), None))
    # Ports, slightly proud of the deck's sides: MagSafe, Thunderbolt, HDMI, SD, jack.
    for tag, x, h, w, z in (
        ("magsafe", -0.39, 0.012, 0.030, -0.10),
        ("tb1", -0.39, 0.010, 0.026, -0.02),
        ("tb2", -0.39, 0.010, 0.026, 0.04),
        ("hdmi", -0.39, 0.012, 0.050, 0.10),
        ("tb3", 0.39, 0.010, 0.026, -0.06),
        ("sd", 0.39, 0.006, 0.050, 0.0),
    ):
        parts.append((attach(box(tag, (0.004, h, w), loc=(x, 0.021, z)), M["plastic_black"]), None))
    jack = cyl("jack", 0.006, 0.004, loc=(0.39, 0.021, 0.06), rot=(0, 0, math.radians(90)), verts=8)
    parts.append((attach(jack, M["plastic_black"]), None))
    return parts


@prop("macbook-lid", "desk", recenter=False, multipart=True)
def build_macbook_lid():
    """MacBook Pro lid, standing open with its hinge line on y=0: an aluminium shell,
    a glass front, the camera notch with its lens, and a mirrored badge on the back.

    Returns (body_parts, loose_parts): the body joins into one mesh, while the `Display`
    plane exports as its own node with real UVs, so the client can paint the live
    terminal onto it. The lid drops straight into the client's lid group, whose origin
    is the hinge and whose rotation opens and shuts it.
    """
    body = []
    body.append((attach(smooth(box("shell", (0.78, 0.50, 0.020), loc=(0, 0.25, 0), bevel_w=0.008, bevel_seg=2)), M["mac_body"]), None))
    body.append((attach(box("glass", (0.76, 0.48, 0.004), loc=(0, 0.25, 0.0105), bevel_w=0.002), M["glass_dark"]), None))
    body.append((attach(box("lip", (0.70, 0.012, 0.022), loc=(0, 0.006, 0), bevel_w=0.004), M["plastic_black"]), None))
    body.append((attach(box("notch", (0.045, 0.012, 0.004), loc=(0, 0.479, 0.015), bevel_w=0.002), M["rubber"]), None))
    lens = cyl("lens", 0.0035, 0.002, loc=(0, 0.479, 0.0175), rot=(math.radians(90), 0, 0), verts=8)
    body.append((attach(lens, M["glass_dark"]), None))
    badge = cyl("badge", 0.055, 0.002, loc=(0, 0.26, -0.0105), rot=(math.radians(90), 0, 0), verts=24)
    body.append((attach(smooth(badge), M["chrome"]), None))
    # The glTF exporter flips V on the way out (Blender's UV origin is the bottom-left,
    # glTF's the top-left), which would land the live terminal upside down: the client
    # paints it with flipY, the way three.js PlaneGeometry (v=1 at the top) expects.
    # Pre-flipping here cancels the exporter's flip, so the display matches that.
    display = flip_uvs_v(plane("Display", (0.72, 0.46), loc=(0, 0.253, 0.013)))
    return body, [("Display", display, M["screen_off"])]


# U6 gun and medic collection props
# --------------------------------------------------------------------------------------


def palette_material(name, swatches):
    """One Principled shader, with embedded colour and metallic/roughness atlases.

    Each part samples the centre of one eight-pixel swatch. Keeping these UVs gives
    steel, wood, cloth and rubber their own finish without extra material slots.
    """
    width, height = len(swatches) * 8, 8
    colors, finishes = [], []
    for _ in range(height):
        for color, roughness, metallic in swatches.values():
            h = color.lstrip("#")
            rgba = tuple(int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)) + (1.0,)
            colors.extend(rgba * 8)
            finishes.extend((1.0, roughness, metallic, 1.0) * 8)
    color_image = bpy.data.images.new(f"{name}Color", width, height)
    color_image.pixels[:] = colors
    color_image.pack()
    finish_image = bpy.data.images.new(f"{name}MetalRough", width, height)
    finish_image.colorspace_settings.name = "Non-Color"
    finish_image.pixels[:] = finishes
    finish_image.pack()

    mat = material(name, "#ffffff")
    mat.use_backface_culling = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes["Principled BSDF"]
    for image, socket in ((color_image, "Base Color"), (finish_image, None)):
        texture = nodes.new("ShaderNodeTexImage")
        texture.image = image
        texture.interpolation = "Closest"
        if socket:
            links.new(texture.outputs["Color"], bsdf.inputs[socket])
        else:
            separate = nodes.new("ShaderNodeSeparateColor")
            links.new(texture.outputs["Color"], separate.inputs["Color"])
            links.new(separate.outputs["Green"], bsdf.inputs["Roughness"])
            links.new(separate.outputs["Blue"], bsdf.inputs["Metallic"])
    uv = {key: ((i + 0.5) / len(swatches), 0.5) for i, key in enumerate(swatches)}
    return mat, uv


def paint(obj, palette, swatch):
    obj = attach(obj, palette[0])
    layer = obj.data.uv_layers.active or obj.data.uv_layers.new(name="UVMap")
    # Join matches layers by name: custom meshes and primitives must share one layer.
    layer.name = "UVMap"
    for loop in layer.data:
        loop.uv = palette[1][swatch]
    return obj


def mesh_object(name, vertices, faces):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def side_profile(name, outline, width, bevel_w=0.0):
    """Extrude a Y/Z silhouette across X (grip, frame, scoop shell)."""
    n = len(outline)
    vertices = [(x, y, z) for x in (-width / 2, width / 2) for y, z in outline]
    faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))]
    faces += [(i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n)]
    obj = mesh_object(name, vertices, faces)
    if bevel_w:
        bevel(obj, bevel_w)
    return obj


def limb(name, start, end, r1, r2=None, verts=12):
    """A tapered segment between two authored Y-up endpoints."""
    start, end = Vector(start), Vector(end)
    obj = raw(cone(name, r1, r1 if r2 is None else r2, (end - start).length,
                   loc=(start + end) * 0.5, verts=verts))
    obj.rotation_euler = Vector((0, 1, 0)).rotation_difference(end - start).to_euler()
    for face in obj.data.polygons:
        face.use_smooth = len(face.vertices) == 4
    return obj


def tube_path(name, points, radius, sides=8, closed=False):
    """A low-poly swept tube; useful for open guards, handles and the curved trigger."""
    points = [Vector(p) for p in points]
    vertices, faces = [], []
    for i, point in enumerate(points):
        previous = points[(i - 1) % len(points)] if closed or i else point
        following = points[(i + 1) % len(points)] if closed or i < len(points) - 1 else point
        tangent = (following - previous).normalized()
        axis = Vector((1, 0, 0)) if abs(tangent.x) < 0.9 else Vector((0, 1, 0))
        normal = tangent.cross(axis).normalized()
        bitangent = tangent.cross(normal).normalized()
        for j in range(sides):
            a = j * math.tau / sides
            vertices.append(point + radius * (normal * math.cos(a) + bitangent * math.sin(a)))
    for i in range(len(points) if closed else len(points) - 1):
        for j in range(sides):
            a, b = i * sides + j, i * sides + (j + 1) % sides
            c, d = ((i + 1) % len(points)) * sides + (j + 1) % sides, ((i + 1) % len(points)) * sides + j
            faces.append((a, b, c, d))
    if not closed:
        faces += [tuple(reversed(range(sides))), tuple(range(len(vertices) - sides, len(vertices)))]
    obj = mesh_object(name, vertices, faces)
    for face in obj.data.polygons:
        face.use_smooth = len(face.vertices) == 4
    return obj


def barrel_tube(name, y, z_start, z_end, outer, inner, sides=32):
    """An actual hollow bore along +Z, including its muzzle annulus."""
    vertices = []
    for z, radius in ((z_start, outer), (z_end, outer), (z_start, inner), (z_end, inner)):
        vertices += [(radius * math.cos(i * math.tau / sides),
                      y + radius * math.sin(i * math.tau / sides), z) for i in range(sides)]
    faces = []
    for i in range(sides):
        j = (i + 1) % sides
        faces += [(i, j, sides + j, sides + i),
                  (2 * sides + j, 2 * sides + i, 3 * sides + i, 3 * sides + j),
                  (sides + i, sides + j, 3 * sides + j, 3 * sides + i),
                  (j, i, 2 * sides + i, 2 * sides + j)]
    obj = mesh_object(name, vertices, faces)
    for i, face in enumerate(obj.data.polygons):
        face.use_smooth = i % 4 < 2
    return obj


@prop("magnum-44", "u6", "gun", "right-hand", recenter=False, keep_uvs=True)
def build_magnum_44():
    """Six-inch stainless .44 revolver; +Z is the bore, origin is the grip centre."""
    palette = palette_material("Magnum44", {
        "steel": ("#c9ced4", 0.26, 0.95),
        "brushed": ("#9fa8b3", 0.38, 0.90),
        "dark": ("#20242b", 0.66, 0.05),
        "wood": ("#542e20", 0.48, 0.0),
        "checkering": ("#351e17", 0.62, 0.0),
    })
    parts = []

    def add(obj, swatch="steel"):
        parts.append((paint(obj, palette, swatch), None))
        return raw(obj)

    # Build in a convenient floor-based space, then move the grip into the origin.
    add(box("TopStrap", (0.031, 0.014, 0.089), (0, 0.161, -0.002), bevel_w=0.003))
    add(side_profile("RecoilShield", [(0.094, -0.067), (0.160, -0.067),
                                     (0.160, -0.046), (0.097, -0.040)], 0.036, 0.003))
    add(side_profile("LowerFrame", [(0.083, -0.063), (0.097, -0.062),
                                   (0.100, 0.042), (0.084, 0.032)], 0.028, 0.002))
    add(box("Crane", (0.020, 0.027, 0.014), (0, 0.113, 0.033), bevel_w=0.002), "brushed")
    cylinder = raw(cyl("FlutedCylinder", 0.026, 0.049, (0, 0.130, -0.005),
                       rot=(math.pi / 2, 0, 0), verts=48, bevel_w=0.001))
    apply_modifiers(cylinder)
    for i in range(6):
        a = i * math.tau / 6
        cutter = raw(cyl("FluteCutter", 0.007, 0.038,
                         (0.030 * math.cos(a), 0.130 + 0.030 * math.sin(a), -0.009),
                         rot=(math.pi / 2, 0, 0), verts=12))
        mod = cylinder.modifiers.new("CylinderFlute", "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.object = cutter
        bpy.context.view_layer.objects.active = cylinder
        bpy.ops.object.modifier_apply(modifier=mod.name)
        bpy.data.objects.remove(cutter, do_unlink=True)
    for face in cylinder.data.polygons:
        face.use_smooth = len(face.vertices) == 4
    add(cylinder, "brushed")
    for i in range(6):
        a = i * math.tau / 6
        add(cyl(f"Chamber{i}", 0.0054, 0.0006,
                (0.017 * math.cos(a), 0.130 + 0.017 * math.sin(a), 0.0197),
                rot=(math.pi / 2, 0, 0), verts=16), "dark")
    add(barrel_tube("SixInchBarrel", 0.142, 0.035, 0.205, 0.012, 0.0056))
    add(cyl("BoreShadow", 0.0055, 0.001, (0, 0.142, 0.061),
            rot=(math.pi / 2, 0, 0), verts=16), "dark")
    add(box("BarrelRib", (0.013, 0.005, 0.163), (0, 0.155, 0.120), bevel_w=0.001))
    add(side_profile("FullUnderlug", [(0.118, 0.040), (0.133, 0.040),
                                    (0.133, 0.199), (0.121, 0.199)], 0.017, 0.002))
    add(cyl("EjectorRod", 0.003, 0.062, (0, 0.119, 0.058),
            rot=(math.pi / 2, 0, 0), verts=12), "brushed")
    add(box("FrontSight", (0.004, 0.012, 0.015), (0, 0.163, 0.191), bevel_w=0.001), "dark")
    add(box("RearSight", (0.019, 0.006, 0.016), (0, 0.171, -0.038), bevel_w=0.001), "dark")
    guard = [(0, 0.067 + 0.023 * math.sin(i * math.tau / 32),
              -0.026 + 0.030 * math.cos(i * math.tau / 32)) for i in range(32)]
    add(tube_path("OpenTriggerGuard", guard, 0.003, closed=True))
    add(tube_path("CurvedTrigger", [(0, 0.092, -0.024), (0, 0.082, -0.019),
                                   (0, 0.069, -0.024), (0, 0.058, -0.033)], 0.0022))
    add(side_profile("Hammer", [(0.143, -0.067), (0.174, -0.067),
                               (0.176, -0.079), (0.184, -0.080),
                               (0.184, -0.063), (0.162, -0.053)], 0.010, 0.001), "brushed")
    grip_outline = [(0.002, -0.096), (0.014, -0.116), (0.074, -0.101),
                    (0.101, -0.065), (0.089, -0.048), (0.072, -0.064),
                    (0.020, -0.071)]
    add(side_profile("WoodGrip", grip_outline, 0.032, 0.004), "wood")
    for sx in (-1, 1):
        add(box(f"CheckeredPanel{sx}", (0.0018, 0.047, 0.026),
                (sx * 0.016, 0.046, -0.086), rot=(math.radians(15), 0, 0),
                bevel_w=0.001), "checkering")
        add(cyl(f"GripScrew{sx}", 0.003, 0.002, (sx * 0.018, 0.052, -0.086),
                rot=(0, 0, math.pi / 2), verts=12), "brushed")
        add(cyl(f"FramePin{sx}", 0.0024, 0.001, (sx * 0.0185, 0.116, -0.055),
                rot=(0, 0, math.pi / 2), verts=12), "brushed")
        add(box(f"CylinderLatch{sx}", (0.004, 0.010, 0.013),
                (sx * 0.019, 0.141, -0.056), bevel_w=0.001), "brushed")
    for obj, _ in parts:
        obj.location += Vector((0, -0.052, 0.086))
    return parts


@prop("medic", "u6", "casualty", "character", recenter=False, keep_uvs=True)
def build_medic():
    """White-uniform paramedic in a planted carry reference pose, facing +Z.

    Hands at (+/-0.23, 0.82, 0.30) meet the stretcher's end grips. Duplicate and
    rotate one medic 180 degrees at the other end; the front medic backpedals.
    This is a static mesh, not an animation rig.
    """
    palette = palette_material("Medic", {
        "white": ("#f1f0e9", 0.83, 0.0),
        "seam": ("#c5cbd0", 0.87, 0.0),
        "skin": ("#b98261", 0.72, 0.0),
        "hair": ("#302620", 0.91, 0.0),
        "boots": ("#222a33", 0.74, 0.0),
        "gloves": ("#95c4ce", 0.72, 0.0),
        "mark": ("#bd2938", 0.77, 0.0),
    })
    parts = []

    def add(obj, swatch="white"):
        parts.append((paint(obj, palette, swatch), None))

    add(box("UniformShirt", (0.40, 0.48, 0.22), (0, 1.245, 0), bevel_w=0.045, bevel_seg=3))
    add(box("TrouserSeat", (0.34, 0.17, 0.21), (0, 0.985, 0), bevel_w=0.035))
    add(box("Belt", (0.35, 0.033, 0.225), (0, 1.021, 0), bevel_w=0.008), "boots")
    add(box("Buckle", (0.040, 0.028, 0.008), (0, 1.021, 0.118), bevel_w=0.003), "seam")
    add(cyl("Neck", 0.058, 0.095, (0, 1.510, 0), verts=16), "skin")
    add(sphere("Head", 1, (0, 1.648, 0.005), segs=20, rings=12,
               scale=(0.093, 0.125, 0.087)), "skin")
    add(sphere("Nose", 1, (0, 1.635, 0.091), segs=12, rings=6,
               scale=(0.016, 0.025, 0.022)), "skin")
    for sx in (-1, 1):
        add(sphere(f"Ear{sx}", 1, (sx * 0.090, 1.642, 0), segs=12, rings=6,
                   scale=(0.016, 0.033, 0.022)), "skin")
        add(box(f"Eye{sx}", (0.018, 0.005, 0.004), (sx * 0.032, 1.668, 0.086),
                bevel_w=0.001), "hair")
        add(box(f"Brow{sx}", (0.028, 0.006, 0.006), (sx * 0.032, 1.685, 0.082),
                bevel_w=0.001), "hair")
        add(box(f"Collar{sx}", (0.080, 0.042, 0.016), (sx * 0.050, 1.468, 0.107),
                rot=(0, 0, sx * math.radians(26)), bevel_w=0.007))
        add(box(f"ShirtPocket{sx}", (0.087, 0.081, 0.014), (sx * 0.098, 1.320, 0.115),
                bevel_w=0.005), "seam")
        add(box(f"PocketFlap{sx}", (0.089, 0.024, 0.009), (sx * 0.098, 1.359, 0.126),
                bevel_w=0.003))
    add(box("ShirtPlacket", (0.012, 0.385, 0.007), (0, 1.245, 0.114),
            bevel_w=0.002), "seam")
    for y in (1.13, 1.22, 1.31, 1.40):
        add(sphere("Button", 0.004, (0, y, 0.122), segs=8, rings=4), "white")
    add(box("MedicalPatch", (0.051, 0.052, 0.008), (-0.098, 1.322, 0.129),
            bevel_w=0.003))
    add(box("ChestCrossVertical", (0.012, 0.038, 0.005), (-0.098, 1.322, 0.135)), "mark")
    add(box("ChestCrossHorizontal", (0.037, 0.012, 0.005), (-0.098, 1.322, 0.135)), "mark")
    add(box("CapCrown", (0.194, 0.076, 0.179), (0, 1.754, 0), bevel_w=0.026))
    add(box("CapBand", (0.195, 0.023, 0.180), (0, 1.718, 0), bevel_w=0.009), "seam")
    add(box("CapVisor", (0.160, 0.012, 0.100), (0, 1.719, 0.097), bevel_w=0.014))
    add(box("CapCrossVertical", (0.009, 0.034, 0.005), (0, 1.750, 0.091)), "mark")
    add(box("CapCrossHorizontal", (0.031, 0.009, 0.005), (0, 1.750, 0.091)), "mark")
    for sx in (-1, 1):
        shoulder = (sx * 0.205, 1.419, 0.0)
        elbow = (sx * 0.258, 1.080, 0.105)
        wrist = (sx * 0.230, 0.851, 0.265)
        add(sphere(f"Shoulder{sx}", 0.072, shoulder, segs=12, rings=8))
        add(limb(f"UpperSleeve{sx}", shoulder, elbow, 0.065, 0.055))
        add(sphere(f"Elbow{sx}", 0.055, elbow, segs=12, rings=8))
        add(limb(f"LowerSleeve{sx}", elbow, wrist, 0.053, 0.034))
        add(limb(f"Cuff{sx}", (sx * 0.231, 0.881, 0.244), wrist, 0.036), "seam")
        add(box(f"GlovedPalm{sx}", (0.059, 0.058, 0.088),
                (sx * 0.230, 0.824, 0.305), bevel_w=0.020), "gloves")
        add(box(f"CurledFingers{sx}", (0.055, 0.039, 0.026),
                (sx * 0.230, 0.797, 0.322), bevel_w=0.010), "gloves")
        add(sphere(f"Thumb{sx}", 1, (sx * 0.204, 0.814, 0.292), segs=10, rings=6,
                   scale=(0.014, 0.021, 0.027)), "gloves")
        # Staggered feet suggest a walking step, with both soles on the floor.
        hip = (sx * 0.093, 0.957, 0)
        knee = (sx * 0.115, 0.530, sx * 0.055)
        ankle = (sx * 0.117, 0.134, sx * 0.100)
        add(limb(f"Thigh{sx}", hip, knee, 0.091, 0.067))
        add(sphere(f"Knee{sx}", 0.068, knee, segs=12, rings=8))
        add(limb(f"Shin{sx}", knee, ankle, 0.066, 0.047))
        add(box(f"Boot{sx}", (0.114, 0.140, 0.221),
                (sx * 0.117, 0.075, sx * 0.100 + 0.046), bevel_w=0.023), "boots")
        add(box(f"Sole{sx}", (0.117, 0.022, 0.226),
                (sx * 0.117, 0.011, sx * 0.100 + 0.046), bevel_w=0.006), "boots")
    return parts


@prop("stretcher", "u6", "casualty", "split-scoop", recenter=False, multipart=True, keep_uvs=True)
def build_stretcher():
    """Orange split scoop, 1.86 m bed / 2.24 m handle span, floor-resting at origin.

    ScoopLeft and ScoopRight retain a shared origin for outward translation during
    loading. The head pad is split with the bed; no rigid bridge joins the halves.
    """
    palette = palette_material("Stretcher", {
        "orange": ("#ee6a20", 0.69, 0.0),
        "steel": ("#bac6cd", 0.31, 0.85),
        "pad": ("#2a3947", 0.91, 0.0),
        "grip": ("#273039", 0.86, 0.0),
        "seam": ("#b84b18", 0.77, 0.0),
    })
    halves = []
    for sx, name in ((-1, "ScoopLeft"), (1, "ScoopRight")):
        parts = []

        def add(obj, swatch="orange"):
            parts.append((paint(obj, palette, swatch), None))

        add(box(f"{name}Bed", (0.265, 0.038, 1.86), (sx * 0.135, 0.070, 0),
                bevel_w=0.014))
        # Raised outer edge reads as a shallow scoop without hard edges under the body.
        add(box(f"{name}Lip", (0.024, 0.046, 1.77), (sx * 0.268, 0.091, 0),
                bevel_w=0.010))
        for z in (-0.940, 0.940):
            add(box(f"{name}End", (0.258, 0.043, 0.055), (sx * 0.136, 0.074, z),
                    bevel_w=0.010))
        for z in (-0.75, -0.45, -0.15, 0.15, 0.45, 0.75):
            add(box(f"{name}Rib", (0.220, 0.008, 0.020), (sx * 0.139, 0.092, z),
                    bevel_w=0.003), "seam")
        add(limb(f"{name}Rail", (sx * 0.230, 0.034, -1.090),
                 (sx * 0.230, 0.034, 1.090), 0.015, verts=16), "steel")
        for sz in (-1, 1):
            handle = [(sx * 0.230, 0.034, sz * 0.900),
                      (sx * 0.230, 0.034, sz * 1.075),
                      (sx * 0.213, 0.034, sz * 1.105),
                      (sx * 0.150, 0.034, sz * 1.105)]
            add(tube_path(f"{name}Handle{sz}", handle, 0.014, sides=12), "steel")
            add(limb(f"{name}Grip{sz}", (sx * 0.230, 0.034, sz * 0.985),
                     (sx * 0.230, 0.034, sz * 1.080), 0.020, verts=16), "grip")
            add(box(f"{name}Latch{sz}", (0.028, 0.025, 0.036),
                    (sx * 0.018, 0.072, sz * 0.947), bevel_w=0.005), "steel")
        add(box(f"{name}HeadPad", (0.165, 0.045, 0.265), (sx * 0.086, 0.110, -0.665),
                bevel_w=0.018), "pad")
        for z in (-0.660, 0.660):
            add(box(f"{name}Skid", (0.027, 0.035, 0.250), (sx * 0.230, 0.0175, z),
                    bevel_w=0.006), "grip")
        halves.append(parts)
    # Assemble the right half using the same atlas-preserving finish as the left.
    right = assemble(halves[1], recenter=False, keep_uvs=True)
    # assemble_multipart expects loose parts in the builder's Y-up space.
    right.data.transform(Matrix.Rotation(math.radians(-90), 4, "X"))
    return halves[0], [("ScoopRight", right, palette[0])]


# build / measure / export
# --------------------------------------------------------------------------------------


def assemble(parts, recenter: bool = True, keep_uvs: bool = False):
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
    # Join leaves the first part's transform on the object and the mesh relative to it;
    # bake it in, so every step below (and the manifest) measures true coordinates.
    bpy.ops.object.select_all(action="DESELECT")
    joined.select_set(True)
    bpy.context.view_layer.objects.active = joined
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    upright(joined)
    if not keep_uvs:
        drop_uvs(joined)
    weld(joined)
    if recenter:
        set_origin_to_bottom_center(joined)
    return joined


def assemble_multipart(body_parts, loose_parts, recenter: bool = True, keep_uvs: bool = False):
    """A multipart prop: the body joins into one mesh like a normal prop, and each loose
    (name, object, material) finishes as its own node, keeping its UVs — the reason a
    part stays loose is that the client addresses it directly (the laptop's display is
    painted as a texture, which needs UVs and a node the client can find by name)."""
    objs = [assemble(body_parts, recenter=recenter, keep_uvs=keep_uvs)]
    for name, obj, mat in loose_parts:
        obj = raw(obj)
        obj.name = name
        if mat is not None:
            obj = attach(obj, mat)
        elif not obj.data.materials:
            obj = attach(obj, M["plastic_dark"])
        apply_modifiers(obj)
        # A loose part keeps its own object, so bake its transform into the mesh — join
        # does this for body parts — leaving the object transform identity for export.
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        upright(obj)
        weld(obj)
        if recenter:
            set_origin_to_bottom_center(obj)
        objs.append(obj)
    return objs


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


def decimate_prop(objs, budget: int) -> tuple[int, int]:
    """Decimate a (possibly multipart) prop to the budget. Loose nodes are never touched:
    the client aims at them directly, so their vertices stay exactly where authored."""
    before = sum(tri_count(o) for o in objs)
    if before <= budget:
        return before, before
    if len(objs) == 1:
        return decimate_to_budget(objs[0], budget)
    loose = sum(tri_count(o) for o in objs[1:])
    decimate_to_budget(objs[0], max(budget - loose, 64))
    return before, sum(tri_count(o) for o in objs)


def bounds(*objs) -> dict:
    """Three.js-space bounds across every node, so the numbers can be compared against
    the procedural props these replace.

    After `upright()` the mesh is Blender Z-up, and the exporter's own +90 about X turns
    that into glTF Y-up: three_x = blender_x, three_y = blender_z, three_z = -blender_y.
    """
    xs, ys, zs = [], [], []
    for obj in objs:
        xs += [v.co.x for v in obj.data.vertices]
        ys += [v.co.y for v in obj.data.vertices]
        zs += [v.co.z for v in obj.data.vertices]

    def span(v):
        return round(max(v) - min(v), 4)

    return {"width": span(xs), "height": span(zs), "depth": span(ys)}


def material_count(objs) -> int:
    """Distinct materials across every node, the way the glTF exporter deduplicates them."""
    return len({m.name for o in objs for m in o.data.materials})


def export(objs, name: str) -> str:
    path = os.path.join(OUT_DIR, f"{name}.glb")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
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


def build_prop(entry: Prop, reset: bool = True) -> list:
    """Build one registry entry into its finished object(s), without exporting.

    The contact sheet passes reset=False: it lays every prop out in one scene, so each
    build adds to the scene instead of replacing it.
    """
    if reset:
        reset_scene()
        build_materials()
    result = entry.build()
    if entry.multipart:
        body_parts, loose_parts = result
        objs = assemble_multipart(body_parts, loose_parts, entry.recenter, entry.keep_uvs)
    else:
        objs = [assemble(result, entry.recenter, entry.keep_uvs)]
    if entry.keep_uvs:
        objs[0].name = "ScoopLeft" if entry.name == "stretcher" else entry.name
    return objs


def export_prop(entry: Prop) -> dict:
    """Build one prop, export its GLB, and return its manifest row."""
    objs = build_prop(entry)
    before, after = decimate_prop(objs, TRI_BUDGET)
    path = export(objs, entry.name)
    size = os.path.getsize(path)
    row = {
        "url": f"/props/{entry.name}.glb",
        "triangles": after,
        "bytes": size,
        "materials": material_count(objs),
        "tags": entry.tags,
        **bounds(*objs),
    }
    print(f"{entry.name:20s} tris {before:6d} -> {after:6d}  {size / 1024:7.1f} KB  mats {row['materials']}")
    return row


def clean_output() -> None:
    """Empty the output dir for a full run, keeping the committed Draco decoder: it is
    checked in (three.js ships it), not generated, and wiping it would break every prop."""
    os.makedirs(OUT_DIR, exist_ok=True)
    for name in os.listdir(OUT_DIR):
        if name == "draco":
            continue
        path = os.path.join(OUT_DIR, name)
        if os.path.isdir(path):
            shutil.rmtree(path)
        else:
            os.remove(path)


def load_manifest() -> dict:
    path = os.path.join(OUT_DIR, "manifest.json")
    if not os.path.exists(path):
        return {}
    with open(path) as fh:
        return json.load(fh)


def write_manifest(manifest: dict) -> None:
    with open(os.path.join(OUT_DIR, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=2, sort_keys=True)


def generate() -> dict:
    clean_output()
    manifest = {}
    for entry in REGISTRY:
        manifest[entry.name] = export_prop(entry)
    write_manifest(manifest)
    return manifest


def generate_some(names: list[str]) -> dict:
    """Rebuild only `names`, merging into the existing manifest: rows without a builder
    any more (and their GLBs) are dropped, everything else stays byte-identical."""
    manifest = load_manifest()
    wanted = {e.name: e for e in REGISTRY}
    unknown = [n for n in names if n not in wanted]
    if unknown:
        raise SystemExit(f"unknown prop(s): {', '.join(unknown)}")
    for name in names:
        manifest[name] = export_prop(wanted[name])
    for stale in [k for k in manifest if k not in wanted]:
        del manifest[stale]
        glb = os.path.join(OUT_DIR, f"{stale}.glb")
        if os.path.exists(glb):
            os.remove(glb)
        print(f"{stale:20s} removed (no builder)")
    write_manifest(manifest)
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
        objs = build_prop(entry, reset=False)
        decimate_prop(objs, TRI_BUDGET)
        built.append((entry, objs))

    # Lay them out on a grid, scaled to a uniform cell so small props are still legible.
    # The meshes are Z-up inside Blender (see `upright`), so the grid runs on X/Y.
    cell = 2.6
    rows = math.ceil(len(built) / cols)
    for i, (_, objs) in enumerate(built):
        xs, ys, zs = [], [], []
        for obj in objs:
            xs += [v.co.x for v in obj.data.vertices]
            ys += [v.co.y for v in obj.data.vertices]
            zs += [v.co.z for v in obj.data.vertices]
        tallest = max(max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)) or 1.0
        s = (cell * 0.42) / tallest
        col, row = i % cols, i // cols
        # Multipart nodes move as a rigid group: the same scale and offset on each.
        loc = (
            (col - (cols - 1) / 2) * cell,
            ((rows - 1) / 2 - row) * cell,
            0.0,
        )
        for obj in objs:
            obj.scale = (s, s, s)
            obj.location = loc

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
    wanted = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    result = generate_some(wanted) if wanted else generate()
    total = sum(v["triangles"] for v in result.values())
    over = [k for k, v in result.items() if v["triangles"] > TRI_BUDGET]
    print(f"\n{len(result)} props, {total} triangles total, budget {TRI_BUDGET}/prop")
    print("OVER BUDGET: " + (", ".join(over) if over else "none"))
