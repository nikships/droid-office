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

import bmesh
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
    node, so the client can find it by name. `keep_uvs` keeps the body's UVs for props
    painted from a palette atlas (see `palette_material`); untextured props drop them.
    `draco` off exports plain buffers, for a prop the tests parse in Node, where three's
    DRACOLoader has no Web Worker to decode in.
    """

    def __init__(self, name: str, build, tags: list[str], recenter: bool = True, multipart: bool = False, keep_uvs: bool = False, draco: bool = True):
        self.name = name
        self.build = build
        self.tags = tags
        self.recenter = recenter
        self.multipart = multipart
        self.keep_uvs = keep_uvs
        self.draco = draco


REGISTRY: list[Prop] = []


def prop(name: str, *tags: str, recenter: bool = True, multipart: bool = False, keep_uvs: bool = False, draco: bool = True):
    def wrap(fn):
        REGISTRY.append(Prop(name=name, build=fn, tags=list(tags), recenter=recenter, multipart=multipart, keep_uvs=keep_uvs, draco=draco))
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


# Palette-atlas helpers
# --------------------------------------------------------------------------------------


def palette_material(name, swatches):
    """One Principled shader, with embedded colour and metallic/roughness atlases.

    Each part samples the centre of one eight-pixel swatch. Keeping these UVs gives
    steel, graphite, glass and signal orange their own finish without extra material slots.
    A swatch is (color, roughness, metallic) or (color, roughness, metallic, glow): a glow
    of 0..1 adds an emission atlas that lights that swatch with its own colour, so a signal
    colour still reads in a dim room without lifting the swatches around it.
    """
    width, height = len(swatches) * 8, 8
    colors, finishes, glows = [], [], []
    for _ in range(height):
        for color, roughness, metallic, *glow in swatches.values():
            h = color.lstrip("#")
            rgb = tuple(int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))
            k = glow[0] if glow else 0.0
            colors.extend((*rgb, 1.0) * 8)
            finishes.extend((1.0, roughness, metallic, 1.0) * 8)
            glows.extend((*(c * k for c in rgb), 1.0) * 8)
    color_image = bpy.data.images.new(f"{name}Color", width, height)
    color_image.pixels[:] = colors
    color_image.pack()
    finish_image = bpy.data.images.new(f"{name}MetalRough", width, height)
    finish_image.colorspace_settings.name = "Non-Color"
    finish_image.pixels[:] = finishes
    finish_image.pack()
    layers = [(color_image, "Base Color"), (finish_image, None)]
    if any(len(s) > 3 and s[3] for s in swatches.values()):
        glow_image = bpy.data.images.new(f"{name}Glow", width, height)
        glow_image.pixels[:] = glows
        glow_image.pack()
        layers.append((glow_image, "Emission Color"))

    mat = material(name, "#ffffff")
    mat.use_backface_culling = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes["Principled BSDF"]
    if len(layers) > 2:
        bsdf.inputs["Emission Strength"].default_value = 1.0
    for image, socket in layers:
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


def tube_path(name, points, radius, sides=8, closed=False):
    """A low-poly swept tube along `points`, for cables and handles."""
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


# Factory hero props: the Droid Computer, the robot cell and its PR crates
# --------------------------------------------------------------------------------------

# Factory's monochrome industrial palette, with orange only as a signal. One atlas is
# shared by every factory prop so their finishes match exactly.
FACTORY_SWATCHES = {
    "base": ("#0a0a0a", 0.85, 0.0),
    "body": ("#161616", 0.42, 0.35),
    "graphite": ("#2a2a2a", 0.40, 0.55),
    "steel": ("#3a3a3a", 0.35, 0.80),
    "light": ("#8c8c8c", 0.30, 0.90),
    # The only swatch that glows: about the lift the office's own orange trim gets.
    "orange": ("#ee6018", 0.55, 0.0, 0.35),
    "glass": ("#050505", 0.08, 0.0),
}


def factory_palette():
    return palette_material("Factory", FACTORY_SWATCHES)


def smooth_obj(obj):
    """Angle-limited smooth shading on a specific object (smooth() acts on the active one)."""
    o = raw(obj)
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    smooth(o)
    return obj


def x_cyl(name, radius, length, loc, verts=RENDER_SEGMENTS):
    """A cylinder lying along X (a joint axis), smooth-sided with crisp caps."""
    return smooth_obj(cyl(name, radius, length, loc=loc, rot=(0, 0, math.radians(90)), verts=verts))


def y_cyl(name, radius, height, loc, verts=RENDER_SEGMENTS, bevel_w=0.0):
    return smooth_obj(cyl(name, radius, height, loc=loc, verts=verts, bevel_w=bevel_w))


def loose(parts):
    """Join painted parts into one loose node, back in the builder's Y-up space."""
    obj = assemble(parts, recenter=False, keep_uvs=True)
    obj.data.transform(Matrix.Rotation(math.radians(-90), 4, "X"))
    return obj


@prop("droid-computer", "factory", "hero", recenter=False, multipart=True, keep_uvs=True)
def build_droid_computer():
    """Factory's Droid Computer: a 0.45 m brushed black aluminium cube with softly rounded
    edges on four small rubber feet, a status LED bezel at the top right of its front (+Z)
    and a recessed glass readout at the bottom right.

    `Shell` is a loose node with its own material and box UVs, so the client can give it a
    brushed finish. The client lights the LED (centre (0.145, 0.387, 0.229), r 0.011) and
    paints the CPU/MEM/DSK readout (centre (0.085, 0.092, 0.2265), 0.15 x 0.058).
    """
    palette = factory_palette()
    size, foot = 0.45, 0.022
    body = []

    def add(obj, swatch):
        body.append((paint(obj, palette, swatch), None))

    for sx in (-1, 1):
        for sz in (-1, 1):
            add(box(f"Foot{sx}{sz}", (0.07, foot + 0.004, 0.07), loc=(sx * 0.15, (foot + 0.004) / 2, sz * 0.15), bevel_w=0.006, bevel_seg=1), "base")
    front = size / 2
    bezel = cyl("LedBezel", 0.017, 0.006, loc=(0.145, foot + size - 0.085, front + 0.001), rot=(math.radians(90), 0, 0), verts=16)
    add(smooth_obj(bezel), "graphite")
    add(box("Readout", (0.156, 0.064, 0.003), loc=(0.085, foot + 0.07, front + 0.0)), "glass")

    shell_mat = material("DroidShell", "#1c1c1e", roughness=0.36, metallic=0.75)
    shell = box("Shell", (size, size, size), loc=(0, foot + size / 2, 0), bevel_w=0.03, bevel_seg=4)
    smooth_obj(shell)
    return body, [("Shell", raw(shell), shell_mat)]


# The arm's links, in metres: each joint's pivot sits on the previous link's +Y axis.
ARM = {
    "pedestal": 0.44,  # yaw axis origin, on top of the pedestal cap
    "shoulder": 0.26,  # shoulder pitch axis above the turret's base
    "upper": 0.62,  # shoulder to elbow
    "fore": 0.55,  # elbow to wrist
    "wrist": 0.12,  # wrist pitch axis to the tool flange
    "tool": 0.1125,  # flange to the suction cups' faces
}


@prop("robot-arm", "factory", "hero", "animated", recenter=False, multipart=True, keep_uvs=True)
def build_robot_arm():
    """A graphite industrial arm with orange joint rings and a four-cup vacuum tool.

    The body is the static pedestal (origin on the floor). Each loose node is authored with
    its own joint at the origin and its link running up +Y, so the client nests them and
    turns them: `Turret` yaws about Y at y=ARM.pedestal; `UpperArm`, `Forearm` and `Wrist`
    pitch about X at ARM.shoulder / upper / fore along the previous link; `Tool` rolls
    about Y at ARM.wrist. The cups' faces are ARM.tool out from the flange.
    """
    palette = factory_palette()
    body = []

    def add(obj, swatch, into=None):
        (body if into is None else into).append((paint(obj, palette, swatch), None))

    # Pedestal: a bolted base plate, a square column and a turned cap.
    add(box("BasePlate", (0.62, 0.04, 0.62), loc=(0, 0.02, 0), bevel_w=0.008, bevel_seg=1), "steel")
    for sx in (-1, 1):
        for sz in (-1, 1):
            add(y_cyl(f"Bolt{sx}{sz}", 0.02, 0.022, loc=(sx * 0.255, 0.05, sz * 0.255), verts=8), "light")
    add(box("Column", (0.42, 0.36, 0.42), loc=(0, 0.04 + 0.18, 0), bevel_w=0.02, bevel_seg=2), "body")
    add(box("ColumnBand", (0.43, 0.02, 0.43), loc=(0, 0.36, 0), bevel_w=0.004, bevel_seg=1), "graphite")
    add(y_cyl("Cap", 0.2, 0.04, loc=(0, 0.42, 0), verts=24), "steel")

    turret = []
    add(y_cyl("YawRing", 0.186, 0.02, loc=(0, 0.01, 0), verts=24), "orange", turret)
    add(y_cyl("Disc", 0.18, 0.09, loc=(0, 0.065, 0), verts=24, bevel_w=0.01), "body", turret)
    add(box("Housing", (0.2, 0.16, 0.22), loc=(0, 0.17, -0.01), bevel_w=0.03, bevel_seg=2), "body", turret)
    s = ARM["shoulder"]
    for sx in (-1, 1):
        add(box(f"Cheek{sx}", (0.05, 0.2, 0.2), loc=(sx * 0.125, 0.19, 0), bevel_w=0.015, bevel_seg=2), "body", turret)
        add(x_cyl(f"ShoulderCap{sx}", 0.1, 0.05, loc=(sx * 0.125, s, 0), verts=20), "graphite", turret)
        add(x_cyl(f"ShoulderRing{sx}", 0.102, 0.014, loc=(sx * 0.157, s, 0), verts=20), "orange", turret)
        add(x_cyl(f"ShoulderHub{sx}", 0.05, 0.012, loc=(sx * 0.17, s, 0), verts=12), "light", turret)

    up = ARM["upper"]
    upper = []
    add(x_cyl("ShoulderBoss", 0.088, 0.19, loc=(0, 0, 0), verts=20), "steel", upper)
    add(box("UpperBeam", (0.15, up - 0.04, 0.13), loc=(0, up / 2, 0), bevel_w=0.03, bevel_seg=2), "body", upper)
    add(box("UpperRib", (0.155, up - 0.24, 0.02), loc=(0, up / 2, 0.06), bevel_w=0.006, bevel_seg=1), "graphite", upper)
    add(x_cyl("ElbowHub", 0.076, 0.17, loc=(0, up, 0), verts=20), "graphite", upper)
    for sx in (-1, 1):
        add(x_cyl(f"ElbowRing{sx}", 0.078, 0.012, loc=(sx * 0.091, up, 0), verts=20), "orange", upper)
    cable = tube_path("UpperCable", [(0, 0.06, -0.075), (0, 0.16, -0.105), (0, up - 0.16, -0.105), (0, up - 0.06, -0.075)], 0.016, sides=6)
    add(cable, "base", upper)

    fore = ARM["fore"]
    forearm = []
    add(box("ElbowHousing", (0.14, 0.16, 0.22), loc=(0, 0.01, -0.035), bevel_w=0.035, bevel_seg=2), "body", forearm)
    add(box("ForeBeam", (0.1, fore - 0.1, 0.1), loc=(0, fore / 2 + 0.03, 0), bevel_w=0.022, bevel_seg=2), "body", forearm)
    add(x_cyl("WristHub", 0.058, 0.12, loc=(0, fore, 0), verts=16), "graphite", forearm)
    for sx in (-1, 1):
        add(x_cyl(f"WristRing{sx}", 0.06, 0.01, loc=(sx * 0.065, fore, 0), verts=16), "orange", forearm)

    wr = ARM["wrist"]
    wrist = []
    add(box("WristBody", (0.09, 0.1, 0.09), loc=(0, 0.05, 0), bevel_w=0.018, bevel_seg=2), "body", wrist)
    add(y_cyl("Flange", 0.046, 0.02, loc=(0, wr - 0.01, 0), verts=16), "steel", wrist)

    tl = ARM["tool"]
    tool = []
    add(y_cyl("ToolRing", 0.048, 0.012, loc=(0, 0.006, 0), verts=16), "orange", tool)
    add(y_cyl("ToolNeck", 0.034, 0.06, loc=(0, 0.042, 0), verts=12), "graphite", tool)
    add(box("SuctionPlate", (0.16, 0.02, 0.16), loc=(0, 0.08, 0), bevel_w=0.006, bevel_seg=1), "steel", tool)
    for sx in (-1, 1):
        for sz in (-1, 1):
            add(y_cyl(f"Cup{sx}{sz}", 0.022, tl - 0.09, loc=(sx * 0.048, 0.09 + (tl - 0.09) / 2, sz * 0.048), verts=10), "base", tool)

    return body, [
        ("Turret", loose(turret), palette[0]),
        ("UpperArm", loose(upper), palette[0]),
        ("Forearm", loose(forearm), palette[0]),
        ("Wrist", loose(wrist), palette[0]),
        ("Tool", loose(tool), palette[0]),
    ]


# The conveyor's belt top, and its length along X.
CONVEYOR = {"belt": 0.52, "length": 2.6, "width": 0.36}


@prop("conveyor", "factory", "hero", recenter=False, keep_uvs=True)
def build_conveyor():
    """A 2.6 m belt conveyor along X (belt top y=0.52, 0.36 wide) on four legs, with a
    tunnel hood over its +X end: crates ride into it and out of sight. The open end of
    the hood carries an orange signal edge and a short strip-curtain valance; a beacon
    base on its roof takes the client's emissive lamp at (1.05, 0.905, 0)."""
    palette = factory_palette()
    parts = []

    def add(obj, swatch):
        parts.append((paint(obj, palette, swatch), None))

    length, belt = CONVEYOR["length"], CONVEYOR["belt"]
    add(box("Belt", (length - 0.1, 0.03, CONVEYOR["width"]), loc=(0, belt - 0.015, 0)), "base")
    for sz in (-1, 1):
        add(box(f"Rail{sz}", (length, 0.09, 0.03), loc=(0, belt - 0.02, sz * 0.2), bevel_w=0.006, bevel_seg=1), "graphite")
        add(box(f"RailLip{sz}", (length, 0.008, 0.034), loc=(0, belt + 0.029, sz * 0.2)), "steel")
    for sx in (-1, 1):
        roller = cyl(f"Roller{sx}", 0.035, CONVEYOR["width"] + 0.01, loc=(sx * (length / 2 - 0.05), belt - 0.03, 0), rot=(math.radians(90), 0, 0), verts=12)
        add(smooth_obj(roller), "light")
        for sz in (-1, 1):
            leg_x, leg_z = sx * 1.05, sz * 0.17
            add(box(f"Leg{sx}{sz}", (0.05, belt - 0.065, 0.05), loc=(leg_x, (belt - 0.065) / 2, leg_z), bevel_w=0.006, bevel_seg=1), "graphite")
            add(box(f"Pad{sx}{sz}", (0.09, 0.015, 0.09), loc=(leg_x, 0.0075, leg_z)), "base")
        add(box(f"Strut{sx}", (0.04, 0.04, 0.34), loc=(sx * 1.05, 0.15, 0)), "graphite")
    for sz in (-1, 1):
        add(box(f"Brace{sz}", (2.1, 0.04, 0.04), loc=(0, 0.15, sz * 0.17)), "graphite")
    # Drive: a gear motor hung under the hood end on the -Z side.
    add(box("Gearbox", (0.16, 0.14, 0.12), loc=(0.9, 0.36, -0.27), bevel_w=0.012, bevel_seg=1), "body")
    add(smooth_obj(cyl("Motor", 0.055, 0.17, loc=(0.9, 0.36, -0.39), rot=(math.radians(90), 0, 0), verts=14)), "graphite")
    add(smooth_obj(cyl("MotorCap", 0.057, 0.012, loc=(0.9, 0.36, -0.48), rot=(math.radians(90), 0, 0), verts=14)), "steel")

    # The hood, x 0.8..1.3, open toward -X.
    x0, x1, top = 0.8, 1.3, 0.86
    mid = (x0 + x1) / 2
    for sz in (-1, 1):
        add(box(f"HoodSide{sz}", (x1 - x0, top - belt + 0.03, 0.02), loc=(mid, (top + belt) / 2, sz * 0.235), bevel_w=0.004, bevel_seg=1), "body")
        add(box(f"HoodJamb{sz}", (0.03, top - belt + 0.03, 0.03), loc=(x0, (top + belt) / 2, sz * 0.235), bevel_w=0.004, bevel_seg=1), "graphite")
    add(box("HoodRoof", (x1 - x0 + 0.02, 0.02, 0.5), loc=(mid, top + 0.01, 0), bevel_w=0.005, bevel_seg=1), "body")
    add(box("HoodBack", (0.02, top - belt + 0.03, 0.47), loc=(x1, (top + belt) / 2, 0)), "body")
    add(box("HoodLintel", (0.03, 0.04, 0.5), loc=(x0, top - 0.01, 0)), "graphite")
    add(box("HoodSignal", (0.012, 0.012, 0.5), loc=(x0 - 0.016, top - 0.02, 0)), "orange")
    for i in range(7):
        z = -0.18 + i * 0.06
        add(box(f"Curtain{i}", (0.004, 0.09, 0.05), loc=(x0 + 0.02, top - 0.075, z)), "base")
    add(y_cyl("BeaconBase", 0.03, 0.03, loc=(1.05, top + 0.035, 0), verts=12), "steel")
    return parts


@prop("pr-crate", "factory", "hero", recenter=False, multipart=True, keep_uvs=True)
def build_pr_crate():
    """A small black shipping crate (0.26 x 0.2 x 0.26) with steel corner posts and rims.

    Its ±Z faces keep a clear panel (0.17 x 0.075, centred y=0.095) for the client's PR
    number stencil, and a loose `Status` node holds the two status bars above it, so the
    client can swap their material from in-review to shipped."""
    palette = factory_palette()
    body = []

    def add(obj, swatch, into=None):
        (body if into is None else into).append((paint(obj, palette, swatch), None))

    w, h = 0.26, 0.2
    add(box("Core", (w - 0.02, h - 0.02, w - 0.02), loc=(0, h / 2, 0), bevel_w=0.004, bevel_seg=1), "body")
    c = w / 2 - 0.015
    for sx in (-1, 1):
        for sz in (-1, 1):
            add(box(f"Post{sx}{sz}", (0.03, h, 0.03), loc=(sx * c, h / 2, sz * c), bevel_w=0.005, bevel_seg=1), "steel")
    for y in (0.0125, h - 0.0125):
        for s in (-1, 1):
            add(box(f"RimX{y}{s}", (w - 0.06, 0.025, 0.026), loc=(0, y, s * c)), "graphite")
            add(box(f"RimZ{y}{s}", (0.026, 0.025, w - 0.06), loc=(s * c, y, 0)), "graphite")
    status = []
    for s in (-1, 1):
        add(box(f"Status{s}", (0.08, 0.012, 0.004), loc=(0, 0.158, s * (w / 2 - 0.009))), "light", status)
    return body, [("Status", loose(status), palette[0])]


# The .44 Magnum your first-person glove holds
# --------------------------------------------------------------------------------------

# Gun space, in millimetres here and metres in the GLB: the bore along +Z, +Y up, +X the gun's
# left, and the origin up in the fist round the grip. Must match src/client/world/gun.ts.
MAGNUM = {
    "bore_y": 62.0,
    "muzzle_z": 235.0,
    # The cylinder's middle, shut, and its size. The top chamber lines up with the bore.
    "drum": (0.0, 47.0, 30.0),
    "drum_r": 24.0,
    "drum_len": 64.0,
    "chamber_at": 15.0,
    # The crane's hinge, low on the frame's left, and how far round it swings the cylinder out.
    "crane": (8.0, 12.0),
    "swing": -1.75,
}

# The grip is shaped for the glove (src/client/world/glove.ts): 36 mm across, so the palm lies
# flat on its right panel, and 55 mm front to back where the middle finger crosses it, so the
# middle, ring and little fingers reach round the front strap onto the left panel. Each row is
# (y, z): the front strap, then the slanted top edge under the frame.
GRIP_FRONT = [
    (-90.8, 0.0), (-86.0, 1.0), (-78.0, 2.8), (-72.0, 4.8), (-67.0, 6.8), (-63.0, 8.6), (-57.0, 10.8),
    (-50.0, 12.6), (-44.0, 14.0), (-36.0, 15.2), (-26.5, 16.2), (-16.0, 17.0), (-10.0, 17.6), (-4.0, 18.2),
    (2.0, 18.6), (6.5, 19.0), (7.2, 12.0), (9.5, 4.0), (14.5, -6.0), (23.0, -16.0), (33.0, -26.0), (38.0, -29.0),
]
# The backstrap, swelling into a horn under the hammer where the web of the thumb sits.
GRIP_REAR = [
    (-90.8, -44.0), (-88.0, -47.0), (-85.0, -49.0), (-81.0, -49.6), (-74.0, -48.4), (-67.0, -46.8), (-60.0, -45.0),
    (-50.0, -42.6), (-42.0, -41.0), (-33.0, -39.6), (-26.5, -38.6), (-18.0, -37.8), (-8.0, -37.3), (0.0, -37.6),
    (9.0, -38.6), (18.0, -39.6), (26.0, -39.6), (32.0, -38.4), (36.0, -36.8), (38.0, -36.0),
]
GRIP_HALF = [(-90.8, 17.5), (-70.0, 18.0), (18.0, 18.0), (30.0, 16.5), (38.0, 14.5)]


def mm(points):
    return [tuple(c / 1000 for c in p) for p in points]


def lerp_table(table, y):
    """Piecewise-linear lookup in rows of (y, value), sorted by y."""
    if y <= table[0][0]:
        return table[0][1]
    for (y0, v0), (y1, v1) in zip(table, table[1:]):
        if y <= y1:
            return v0 + (v1 - v0) * (y - y0) / (y1 - y0)
    return table[-1][1]


def link_bmesh(name, bm):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def prism_x(name, outline, width, x=0.0):
    """A side silhouette, [(z, y)] in mm, extruded `width` mm across X about `x`."""
    bm = bmesh.new()
    rings = [[bm.verts.new(((x + side * width / 2) / 1000, y / 1000, z / 1000)) for z, y in outline] for side in (-1, 1)]
    for ring in rings:
        bm.faces.new(ring)
    n = len(outline)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((rings[0][i], rings[0][j], rings[1][j], rings[1][i]))
    return link_bmesh(name, bm)


def prism_z(name, outline, z0, z1):
    """A cross-section, [(x, y)] in mm, extruded along the bore from z0 to z1 mm."""
    bm = bmesh.new()
    rings = [[bm.verts.new((x / 1000, y / 1000, z / 1000)) for x, y in outline] for z in (z0, z1)]
    for ring in rings:
        bm.faces.new(ring)
    n = len(outline)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((rings[0][i], rings[0][j], rings[1][j], rings[1][i]))
    return link_bmesh(name, bm)


def swept_disc(centre, radius, z0, z1, steps=28, cap=12):
    """What a disc on the crane sweeps as the cylinder swings out: the arc its centre takes round
    the hinge, `radius` mm either side, with a half disc at each end. A cutter for whatever the
    cylinder, or the ejector rod, would pass through on its way out."""
    hx, hy = MAGNUM["crane"]
    cx, cy = centre
    reach = math.hypot(cx - hx, cy - hy)
    a0 = math.atan2(cy - hy, cx - hx)
    sw = MAGNUM["swing"]
    s = math.copysign(1, sw)
    a1 = a0 + sw
    pts = [(hx + (reach + radius) * math.cos(a0 + sw * i / steps), hy + (reach + radius) * math.sin(a0 + sw * i / steps)) for i in range(steps + 1)]
    ex, ey = hx + reach * math.cos(a1), hy + reach * math.sin(a1)
    pts += [(ex + radius * math.cos(a1 + s * math.pi * i / cap), ey + radius * math.sin(a1 + s * math.pi * i / cap)) for i in range(1, cap)]
    pts += [(hx + (reach - radius) * math.cos(a1 - sw * i / steps), hy + (reach - radius) * math.sin(a1 - sw * i / steps)) for i in range(steps + 1)]
    sx, sy = hx + reach * math.cos(a0), hy + reach * math.sin(a0)
    pts += [(sx + radius * math.cos(a0 + s * math.pi * (1 + i / cap)), sy + radius * math.sin(a0 + s * math.pi * (1 + i / cap))) for i in range(1, cap)]
    return prism_z("SweptDisc", pts, z0, z1)


def swept_arm(reach, z0, z1, steps=24, margin=0.12):
    """The pie slice the crane's arm sweeps round its hinge, out to `reach` mm."""
    hx, hy = MAGNUM["crane"]
    dx, dy = MAGNUM["drum"][0] - hx, MAGNUM["drum"][1] - hy
    a0 = math.atan2(dy, dx)
    a1 = a0 + MAGNUM["swing"]
    lo, hi = min(a0, a1) - margin, max(a0, a1) + margin
    pts = [(hx, hy)] + [(hx + reach * math.cos(lo + (hi - lo) * i / steps), hy + reach * math.sin(lo + (hi - lo) * i / steps)) for i in range(steps + 1)]
    return prism_z("SweptArm", pts, z0, z1)


def zcyl(name, r, z0, z1, x=0.0, y=0.0, verts=24):
    """A cylinder along the bore, in mm."""
    bpy.ops.mesh.primitive_cylinder_add(radius=r / 1000, depth=(z1 - z0) / 1000, location=(x / 1000, y / 1000, (z0 + z1) / 2000), vertices=verts)
    obj = bpy.context.active_object
    obj.name = name
    return obj


def xcyl(name, r, x0, x1, y, z, verts=12):
    """A cylinder across the gun, in mm: a screw head on the frame's side."""
    obj = zcyl(name, r, x0, x1, verts=verts)
    obj.data.transform(Matrix.Rotation(math.radians(90), 4, "Y"))
    obj.location = ((x0 + x1) / 2000, y / 1000, z / 1000)
    return obj


def zdisc(name, r, x, y, z, back=False, verts=16):
    """A flat disc facing +Z (or -Z), in mm: a chamber mouth or a primer."""
    bpy.ops.mesh.primitive_circle_add(vertices=verts, radius=r / 1000, fill_type="NGON", location=(x / 1000, y / 1000, z / 1000))
    obj = bpy.context.active_object
    obj.name = name
    if back:
        obj.data.transform(Matrix.Rotation(math.pi, 4, "X"))
    return obj


def mmbox(name, size, centre, bevel_w=0.0, segments=2):
    return raw(box(name, tuple(s / 1000 for s in size), loc=tuple(c / 1000 for c in centre), bevel_w=bevel_w / 1000, bevel_seg=segments))


def cut(obj, *cutters):
    """Subtracts each cutter from `obj`, then deletes it. Any modifier already on `obj` applies first."""
    obj = raw(obj)
    for cutter in cutters:
        cutter = raw(cutter)
        mod = obj.modifiers.new("Cut", "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.solver = "EXACT"
        mod.object = cutter
        apply_modifiers(obj)
        bpy.data.objects.remove(cutter, do_unlink=True)
    return obj


def finish(obj, mat, bevel_mm=0.0, segments=2, angle=50.0):
    obj = raw(obj)
    if bevel_mm:
        bevel(obj, bevel_mm / 1000, segments, angle)
    apply_modifiers(obj)
    smooth_obj(obj)
    return attach(obj, mat)


def rounded_ring(y, z_rear, z_front, half, r_rear, r_front, k=4):
    """One horizontal slice of the grip: a rounded rectangle from the backstrap to the front strap,
    2 * half across, with its own corner radius at the back and at the front."""
    corners = [
        (half - r_front, z_front - r_front, r_front, 0.0),
        (-(half - r_front), z_front - r_front, r_front, 90.0),
        (-(half - r_rear), z_rear + r_rear, r_rear, 180.0),
        (half - r_rear, z_rear + r_rear, r_rear, 270.0),
    ]
    out = []
    for cx, cz, r, start in corners:
        for i in range(k + 1):
            a = math.radians(start + 90.0 * i / k)
            out.append((cx + r * math.cos(a), y, cz + r * math.sin(a)))
    return out


def walnut_grip():
    """The grip, lofted through horizontal slices up the silhouette, its butt rounded over."""
    bottom, top = GRIP_FRONT[0][0], GRIP_FRONT[-1][0]
    butt, crown = 7.0, 2.5
    lo, hi = bottom + butt, top - crown
    # Every corner of the silhouette gets a slice, with more between them where they are far apart.
    levels = {y for y, _ in GRIP_FRONT + GRIP_REAR if lo < y < hi}
    levels |= {lo + 6.0 * i for i in range(int((hi - lo) / 6.0) + 1)}
    levels = sorted(y for y in levels if lo <= y <= hi)
    levels = [y for i, y in enumerate(levels) if i == 0 or y - levels[i - 1] > 2.5]
    levels = sorted([bottom + d for d in (0.0, 0.6, 1.8, 3.6)] + levels + [top - d for d in (1.0, 0.0)])
    bm = bmesh.new()
    rings = []
    for y in levels:
        # Rounding over the butt and the crown: the slice pulls in as it nears either end.
        inset = 0.0
        if y - bottom < butt:
            inset = butt - math.sqrt(max(0.0, butt * butt - (butt - (y - bottom)) ** 2))
        elif top - y < crown:
            inset = crown - math.sqrt(max(0.0, crown * crown - (crown - (top - y)) ** 2))
        zf = lerp_table(GRIP_FRONT, y) - inset
        zr = lerp_table(GRIP_REAR, y) + inset
        half = lerp_table(GRIP_HALF, y) - inset
        depth = zf - zr
        # Round at the front strap; sharp along the top edge, where the walnut meets the frame.
        front = 11.0 if y <= 6.5 else max(1.5, 11.0 - (y - 6.5) * 2.0)
        r_rear = max(0.5, min(12.0 - inset, depth / 2 - 0.2, half - 0.2))
        r_front = max(0.5, min(front - inset, depth / 2 - 0.2, half - 0.2))
        rings.append([bm.verts.new(tuple(c / 1000 for c in p)) for p in rounded_ring(y, zr, zf, half, r_rear, r_front)])
    for a, b in zip(rings, rings[1:]):
        n = len(a)
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((a[i], a[j], b[j], b[i]))
    bm.faces.new(rings[0])
    bm.faces.new(rings[-1])
    return link_bmesh("Walnut", bm)


@prop("magnum", "hand", recenter=False, multipart=True, draco=False)
def build_magnum():
    """A stainless .44 Magnum revolver with a full-lug, vent-ribbed barrel, a fluted six-shot
    cylinder on a swing-out crane and a walnut grip shaped round the glove.

    The body is one mesh in gun space. `gun-crane-arm` is authored round the crane's hinge, and
    `gun-drum` (the cylinder, its ejector rod, brass and chamber mouths) round the cylinder's
    middle, so the client hangs them on groups it turns (gun.ts setCylinder). Nothing on the
    frame, barrel or lug stands where the cylinder, its rod or the crane pass on the way out:
    each is cut by what they sweep.
    """
    steel = material("GunSteel", "#d3d9e0", roughness=0.25, metallic=0.9)
    frame = material("GunFrame", "#9ba5b1", roughness=0.35, metallic=0.85)
    walnut = material("GunWalnut", "#6e3a22", roughness=0.55)
    dark = material("GunDark", "#23272e", roughness=0.45, metallic=0.5)
    brass = material("GunBrass", "#d6a646", roughness=0.3, metallic=0.9)
    orange = material("GunOrange", "#ee6018", roughness=0.5)
    m = MAGNUM
    dx, dy, dz = m["drum"]
    dr, dl = m["drum_r"], m["drum_len"]
    hx, hy = m["crane"]
    muzzle = m["muzzle_z"]
    body = []

    # The frame: a side profile with the cylinder's window notched out of its top, a recoil shield
    # behind it and the post the barrel screws into in front. Its lower edge runs inside the
    # walnut, and the guard hangs under its flat bottom (y 6).
    frame_body = prism_x(
        "Frame",
        [
            (-14, 72), (-3, 72), (-3, 22), (66, 22), (66, 72), (72, 72), (72, 20), (75, 12), (76.5, 6),
            (20, 6), (18, -2), (-36, -2), (-36, 32), (-34.5, 44), (-32, 54), (-27.5, 63), (-21, 69),
        ],
        28,
    )
    bevel(frame_body, 0.0012, 2, 50)
    top_strap = mmbox("TopStrap", (21, 10, 86), (0, 77, 29), bevel_w=2.0, segments=3)

    def swing():
        return swept_disc((dx, dy), dr + 0.6, dz - dl / 2 - 0.6, dz + dl / 2 + 0.6)

    def hammer_slot():
        return mmbox("HammerSlot", (9.2, 44, 25), (0, 66, -22.5))

    cut(frame_body, swing(), swept_disc((dx, dy), 4.0, 60, 112), swept_arm(math.hypot(dx - hx, dy - hy) + 7.5, 62.0, 66.0), hammer_slot())
    cut(top_strap, swing(), hammer_slot())
    body += [(finish(frame_body, frame), None), (finish(top_strap, frame), None)]

    # The guard: a narrow loop under the frame, open in the barrel's plane for the trigger finger.
    # Its back curves up under the guard-side of the middle finger, its bottom drops away under
    # the trigger finger, so a finger hooked through it on SPIN_AT never touches it as it spins.
    guard = prism_x(
        "Guard",
        [(16, 7), (16, -4), (17.5, -8), (20.5, -10.5), (25, -11.6), (30, -11.9), (35, -12.4), (40, -13.3), (42, -15.0), (44, -17.4), (47, -19.2), (52, -19.8), (56, -20.4), (64, -20.4), (71, -17.6), (76.5, -12.5), (80, -5), (81, 2), (81, 7)],
        9,
    )
    bevel(guard, 0.0012, 2, 50)
    cut(guard, prism_x("GuardOpening", [(27.5, 5), (27.5, -3), (29, -6.6), (32, -8.4), (36, -9.4), (40, -10.8), (42, -12.6), (44, -15.0), (47, -16.8), (52, -17.0), (57, -17.6), (63, -17.0), (69, -14.6), (73.5, -10), (76, -4), (76.8, 1), (76.8, 5)], 12))
    body.append((finish(guard, frame), None))

    # The barrel: a real tube, its bore recessed into the muzzle, on a full-length underlug that
    # houses the ejector rod, under a ventilated rib.
    bore_y = m["bore_y"]
    barrel = zcyl("Barrel", 11, 66, muzzle, 0, bore_y, verts=32)
    bevel(barrel, 0.0012, 2, 50)
    cut(barrel, zcyl("Bore", 5.6, muzzle - 16, muzzle + 1, 0, bore_y, verts=20))
    body.append((finish(barrel, steel), None))
    body.append((attach(zdisc("BoreEnd", 5.6, 0, bore_y, muzzle - 15.9, verts=20), dark), None))
    lug = prism_x("Underlug", [(72, 54), (233, 54), (234.5, 51), (234, 46), (231, 41), (225, 38.5), (100, 38), (72, 38)], 17)
    bevel(lug, 0.0022, 3, 50)
    cut(lug, swept_disc((dx, dy), 4.0, 60, 112))
    body.append((finish(lug, steel), None))
    rib = mmbox("Rib", (10, 9.5, 162), (0, 76.75, 153), bevel_w=0.8)
    cut(rib, *[mmbox(f"Vent{i}", (14, 4, 8.5), (0, 76.5, 88 + 17 * i)) for i in range(8)])
    body.append((finish(rib, steel), None))

    # Sights: a ramped front blade with an orange insert facing you, a notched rear on the strap.
    body.append((finish(prism_x("FrontSight", [(212, 81.3), (232.5, 81.3), (232.5, 88), (230.8, 90.4), (227.5, 90.6)], 3.4), steel, 0.4, 1), None))
    body.append((finish(prism_x("SightInsert", [(218.35, 85.46), (226.15, 90.16), (226.81, 89.04), (219.01, 84.34)], 3.6), orange), None))
    rear = mmbox("RearSight", (15, 4.8, 11), (0, 84.4, -7), bevel_w=0.6)
    cut(rear, mmbox("Notch", (3.4, 4, 14), (0, 87, -7)))
    body.append((finish(rear, dark), None))

    # The action: the hammer in its slot with its spur back over the web of the hand, the trigger
    # at the back of the guard, and the cylinder latch on the frame's left behind the cylinder.
    hammer = prism_x("Hammer", [(-12, 46), (-11.5, 73), (-13.5, 78.5), (-19, 82), (-26, 81.5), (-28, 76), (-27.5, 62), (-28.5, 46)], 8)
    body.append((finish(hammer, dark, 0.8, 2), None))
    # A wide target spur, its top grooved for the thumb that cocks it.
    spur = prism_x("Spur", [(-17, 81.5), (-30, 85.4), (-40, 87.6), (-46, 87.6), (-48.6, 85.6), (-47.2, 83.0), (-38, 81.4), (-30, 79.4), (-22, 77.4)], 12)
    bevel(spur, 0.001, 2, 50)
    spur_top = [(-46, 87.6), (-40, 87.6), (-30, 85.4)]
    cut(spur, *[mmbox(f"Groove{i}", (16, 1.6, 1.4), (0, lerp_table(spur_top, -31 - 3.6 * i), -31 - 3.6 * i)) for i in range(4)])
    body.append((finish(spur, dark), None))
    trigger = prism_x("Trigger", [(33.8, 7), (40.2, 7), (40.6, 1), (40.6, -4.2), (40.0, -6.6), (38.8, -8.3), (37.2, -8.0), (36.9, -6.0), (36.6, -3), (35.6, 2)], 6.8)
    body.append((finish(trigger, dark, 0.6, 2), None))
    body.append((finish(mmbox("Latch", (2.8, 7, 9), (15.2, 52.5, -8.5), bevel_w=0.8), dark), None))
    for i, (z, y) in enumerate(((4, 14), (46, 14), (-18, 36))):
        body.append((finish(xcyl(f"Screw{i}", 2.7, -14.8, -13.8, y, z), steel), None))

    body.append((finish(walnut_grip(), walnut), None))

    # The cylinder, round its own middle: fluted between six loaded chambers, brass case heads
    # and primers on its back face, the ejector star, and the ejector rod out in front.
    half = dl / 2
    drum = zcyl("Cylinder", dr, -half, half, verts=30)
    bevel(drum, 0.0015, 2, 50)
    flutes = []
    for i in range(6):
        a = math.radians(60 * i)
        bpy.ops.mesh.primitive_uv_sphere_add(radius=1, segments=12, ring_count=8, location=(math.cos(a) * 0.0264, math.sin(a) * 0.0264, 0))
        flute = bpy.context.active_object
        flute.scale = (0.0048, 0.0048, 0.021)
        flutes.append(flute)
    chambers = [(math.cos(math.radians(30 + 60 * i)) * m["chamber_at"], math.sin(math.radians(30 + 60 * i)) * m["chamber_at"]) for i in range(6)]
    cut(drum, *flutes, *[zcyl(f"Chamber{i}", 5.7, half - 8, half + 1, x, y, verts=16) for i, (x, y) in enumerate(chambers)])
    drum_parts = [(finish(drum, steel), None)]
    for i, (x, y) in enumerate(chambers):
        drum_parts.append((attach(zdisc(f"Mouth{i}", 5.7, x, y, half - 7.95), dark), None))
        drum_parts.append((finish(zcyl(f"Case{i}", 6.3, -half - 0.7, -half + 0.5, x, y, verts=14), brass), None))
        drum_parts.append((attach(zdisc(f"Primer{i}", 2.0, x, y, -half - 0.75, back=True, verts=10), dark), None))
    drum_parts.append((finish(zcyl("Star", 7.5, -half - 0.5, -half + 0.2, verts=16), steel), None))
    drum_parts.append((finish(zcyl("EjectorRod", 3.1, half - 1, half + 40, verts=12), steel), None))
    drum_parts.append((finish(zcyl("EjectorHead", 3.6, half + 38, half + 46, verts=12), steel, 0.6, 1), None))

    # The crane, round its hinge: the arm out to the cylinder's front, the yoke the rod runs
    # through, and the hinge knuckle down in the frame.
    reach = math.hypot(dx - hx, dy - hy)
    angle = math.atan2(dy - hy, dx - hx)
    arm = mmbox("CraneArm", (reach, 9, 3.2), (0, 0, 64.1), bevel_w=0.6)
    arm.data.transform(Matrix.Translation((reach / 2000, 0, 0)))
    arm.rotation_euler = (0, 0, angle)
    crane_parts = [
        (finish(arm, steel), None),
        (finish(zcyl("Yoke", 6.5, 62.5, 65.7, dx - hx, dy - hy, verts=16), steel, 0.5, 1), None),
        (finish(zcyl("Knuckle", 4.5, 42, 65.7, verts=12), steel), None),
    ]

    def node(parts):
        obj = assemble(parts, recenter=False)
        obj.data.transform(Matrix.Rotation(math.radians(-90), 4, "X"))
        return obj

    return body, [("gun-crane-arm", node(crane_parts), None), ("gun-drum", node(drum_parts), None)]


# The droid wand
# --------------------------------------------------------------------------------------

# Wand space, in millimetres here and metres in the GLB: the shaft along +Z, +Y up, and the
# origin in the middle of the grip, where the fist closes. Must match src/client/world/wand.ts.
WAND = {
    # Back of the pommel and the tip of the emitter.
    "back_z": -64.0,
    "tip_z": 284.0,
    # The grip the fist closes round: an octagon this far to a corner, from its back to its front.
    "grip_r": 9.3,
    "grip_z": (-48.6, 37.0),
    # The rotor (the pinwheel at the tip) spins on the shaft's axis here, inside its guard ring.
    "rotor_z": 274.5,
    "rotor_d": 16.0,
    "guard_r": 8.4,
    # The orange emitter in front of the rotor's hub, where a spell leaves the wand.
    "core_z": 278.2,
    "core_r": 2.3,
    # The progress bar along the first stage: how many segments, where the first starts, each one's length and the gap after it.
    "segments": 10,
    "segments_z": 66.0,
    "segment_len": 4.6,
    "segment_gap": 2.2,
}


def lathe(name, profile, sides=24, closed=False, phase=0.0):
    """A solid turned about +Z from a profile of (z, r) in mm. An open profile is capped at each end
    (an r of 0 comes to a point); a closed one is a loop in (z, r), turned into a ring."""
    bm = bmesh.new()
    rings = []
    for z, r in profile:
        if r <= 1e-6:
            rings.append([bm.verts.new((0.0, 0.0, z / 1000))])
            continue
        rings.append([bm.verts.new((r / 1000 * math.cos(phase + math.tau * i / sides), r / 1000 * math.sin(phase + math.tau * i / sides), z / 1000)) for i in range(sides)])
    pairs = list(zip(rings, rings[1:]))
    if closed:
        pairs.append((rings[-1], rings[0]))
    for a, b in pairs:
        if len(a) == 1 and len(b) == 1:
            continue
        if len(a) == 1:
            for i in range(sides):
                bm.faces.new((a[0], b[i], b[(i + 1) % sides]))
        elif len(b) == 1:
            for i in range(sides):
                bm.faces.new((a[i], a[(i + 1) % sides], b[0]))
        else:
            for i in range(sides):
                j = (i + 1) % sides
                bm.faces.new((a[i], a[j], b[j], b[i]))
    if not closed:
        if len(rings[0]) > 1:
            bm.faces.new(rings[0])
        if len(rings[-1]) > 1:
            bm.faces.new(rings[-1])
    return link_bmesh(name, bm)


def inlay(name, z0, z1, radius, half_width, proud, columns=4):
    """A strip laid along the top (+Y) of a turned part from z0 to z1 mm, `half_width` mm either
    side of the top, curved to the surface `radius(z)` and standing `proud` mm off it, with walls
    down below the surface so no edge floats."""
    bm = bmesh.new()
    rows = [z0, z1]
    grid = []
    for z in rows:
        r = radius(z)
        span = half_width / r
        top, low = [], []
        for i in range(columns + 1):
            a = math.pi / 2 - span + 2 * span * i / columns
            top.append(bm.verts.new(((r + proud) * math.cos(a) / 1000, (r + proud) * math.sin(a) / 1000, z / 1000)))
            low.append(bm.verts.new(((r - 0.25) * math.cos(a) / 1000, (r - 0.25) * math.sin(a) / 1000, z / 1000)))
        grid.append((top, low))
    (t0, l0), (t1, l1) = grid
    for i in range(columns):
        bm.faces.new((t0[i], t0[i + 1], t1[i + 1], t1[i]))
        bm.faces.new((l0[i + 1], l0[i], l1[i], l1[i + 1]))
    bm.faces.new((t0[0], t1[0], l1[0], l0[0]))
    bm.faces.new((t0[-1], l0[-1], l1[-1], t1[-1]))
    bm.faces.new(list(reversed(t0)) + l0)
    bm.faces.new(t1 + list(reversed(l1)))
    return link_bmesh(name, bm)


def factory_glyph_path():
    """The pinwheel's SVG path and viewBox, read from the client so the two never drift."""
    src = open(os.path.join(REPO, "src", "client", "world", "glyph.ts")).read()
    box = [float(v) for v in src.split("FACTORY_GLYPH_VIEWBOX = [", 1)[1].split("]", 1)[0].split(",")]
    path = src.split("FACTORY_GLYPH_PATH =", 1)[1].split("'", 2)[1]
    return path, box


def glyph_solid(name, diameter, depth, curve=5):
    """The Factory pinwheel as a solid `diameter` mm across and `depth` mm thick, centred on the
    origin and facing +Z with +Y up (the SVG's y flipped), its eight cut-outs open."""
    import re

    path, (vx, vy, vw, vh) = factory_glyph_path()
    size = max(vw, vh)
    cx, cy = vx + vw / 2, vy + vh / 2
    k = diameter / 1000 / size

    def at(x, y):
        return Vector(((x - cx) * k, -(y - cy) * k, 0.0))

    tokens = re.findall(r"[MCHZ]|-?\d*\.?\d+(?:e-?\d+)?", path, re.I)
    subpaths, cur, i, cmd = [], None, 0, ""
    x = y = 0.0
    while i < len(tokens):
        if re.match(r"[MCHZ]", tokens[i], re.I):
            cmd = tokens[i].upper()
            i += 1
        if cmd == "M":
            x, y = float(tokens[i]), float(tokens[i + 1])
            i += 2
            cur = [[at(x, y), None, None]]
            subpaths.append(cur)
            cmd = "L"
        elif cmd == "L":
            x, y = float(tokens[i]), float(tokens[i + 1])
            i += 2
            cur.append([at(x, y), None, None])
        elif cmd == "C":
            x1, y1, x2, y2, x, y = (float(t) for t in tokens[i : i + 6])
            i += 6
            cur[-1][2] = at(x1, y1)
            cur.append([at(x, y), at(x2, y2), None])
        elif cmd == "H":
            x = float(tokens[i])
            i += 1
            cur.append([at(x, y), None, None])
        elif cmd == "Z":
            # The last point lands back on the first: fold its incoming handle onto the first.
            if len(cur) > 1 and (cur[-1][0] - cur[0][0]).length < 1e-7:
                cur[0][1] = cur[-1][1]
                cur.pop()
            cmd = ""
        else:
            i += 1
    data = bpy.data.curves.new(name, "CURVE")
    data.dimensions = "2D"
    data.fill_mode = "BOTH"
    data.resolution_u = curve
    data.extrude = depth / 2000
    for sub in subpaths:
        spline = data.splines.new("BEZIER")
        spline.bezier_points.add(len(sub) - 1)
        for point, (co, left, right) in zip(spline.bezier_points, sub):
            point.co = co
            point.handle_left_type = point.handle_right_type = "FREE"
            point.handle_left = left if left is not None else co
            point.handle_right = right if right is not None else co
        spline.use_cyclic_u = True
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.active_object
    weld(obj, 1e-6)
    return obj


def grip_profile():
    """The grip's (z, r): an octagon with a slight belly where the palm sits, ringed with
    machined grooves fore and aft of the fist so it reads as a tool, not a stick."""
    z0, z1 = WAND["grip_z"]
    r0 = WAND["grip_r"]

    def r_at(z):
        # A gentle swell under the palm, easing down toward the ferrule.
        u = (z - z0) / (z1 - z0)
        return r0 + 0.45 * math.sin(math.pi * min(1, u * 1.15)) - 0.6 * u

    grooves = [z0 + 4.5 + 5.2 * n for n in range(4)] + [z1 - 4.5 - 5.2 * n for n in range(4)][::-1]
    pts = [(z0, r_at(z0) - 0.5), (z0 + 0.6, r_at(z0))]
    for g in grooves:
        r = r_at(g)
        pts += [(g - 0.9, r), (g - 0.45, r - 0.75), (g + 0.45, r - 0.75), (g + 0.9, r)]
    # Mid-grip, under the palm: plain, with the belly.
    mid = [z for z in (-20.0, -10.0, 0.0, 10.0) if grooves[3] + 1 < z < grooves[4] - 1]
    pts += [(z, r_at(z)) for z in mid]
    pts += [(z1 - 0.6, r_at(z1)), (z1, r_at(z1) - 0.5)]
    pts.sort()
    return pts


@prop("wand", "hand", recenter=False, multipart=True, draco=False)
def build_wand():
    """The droid wand: a vibe-coding wizard's wand built like a Factory tool. A machined steel
    pommel with the pinwheel inlaid in its end, an orange signal ring, a grooved octagonal
    graphite grip, a steel ferrule, a three-stage telescoping graphite shaft with steel collars,
    and at the tip a ducted Factory rotor (the pinwheel itself) on its hub, in front of which an
    orange emitter glows when a spell leaves the wand.

    The body is one mesh in wand space. `wand-rotor` (the pinwheel) and `wand-core` (the emitter)
    are authored round their own middles on the shaft's axis, so the client hangs them where
    WAND has them and spins the rotor and lights the core (wand.ts).
    """
    graphite = material("WandGraphite", "#1c1c1c", roughness=0.42, metallic=0.35)
    grip = material("WandGrip", "#0d0d0d", roughness=0.85)
    steel = material("WandSteel", "#4a4a4a", roughness=0.32, metallic=0.85)
    light = material("WandLight", "#e8e8e8", roughness=0.3, metallic=0.6)
    orange = material("WandOrange", "#ee6018", roughness=0.5, emission="#ee6018", emission_strength=0.35)
    w = WAND
    back = w["back_z"]
    body = []

    # Pommel: a machined cap with a chamfered back edge and a hairline groove, the pinwheel
    # inlaid in light steel across its end, and the orange signal ring where it meets the grip.
    pommel = lathe("Pommel", [(back, 0.0), (back, 7.4), (back + 0.5, 8.7), (back + 1.6, 9.6), (back + 3.2, 10.1), (back + 6.4, 10.1), (back + 6.8, 9.6), (back + 7.6, 9.6), (back + 8.0, 10.1), (back + 12.6, 10.1), (back + 13.4, 9.7), (-49.8, 9.7)], sides=32)
    body.append((finish(pommel, steel), None))
    emblem = glyph_solid("PommelGlyph", 12.8, 0.8)
    emblem.data.transform(Matrix.Rotation(math.pi, 4, "Y"))
    emblem.location = (0, 0, (back - 0.25) / 1000)
    body.append((finish(emblem, light), None))
    ring = lathe("SignalRing", [(-49.9, 8.9), (-49.9, 9.9), (-48.5, 9.9), (-48.5, 8.9)], sides=32, closed=True)
    body.append((finish(ring, orange), None))

    # Grip: eight flats (one facing up, so the hand reads its angle), grooved fore and aft.
    body.append((finish(lathe("Grip", grip_profile(), sides=8, phase=math.pi / 8), grip), None))

    # Ferrule: a steel neck stepping down from the grip to the shaft, with two hairline grooves,
    # and the orange power ring where the shaft goes in.
    z1 = w["grip_z"][1]
    ferrule = lathe(
        "Ferrule",
        [(z1 - 0.3, 0.0), (z1 - 0.3, 8.2), (z1 + 0.6, 8.9), (z1 + 6.0, 8.9), (z1 + 6.3, 8.3), (z1 + 7.1, 8.3), (z1 + 7.4, 8.8), (z1 + 10.0, 8.6), (z1 + 16.5, 6.4), (z1 + 17.0, 6.0), (z1 + 19.0, 6.0)],
        sides=32,
    )
    body.append((finish(ferrule, steel), None))
    body.append((finish(lathe("PowerRing", [(z1 + 19.0, 5.2), (z1 + 19.0, 6.1), (z1 + 20.4, 6.1), (z1 + 20.4, 5.2)], sides=32, closed=True), orange), None))

    # Shaft: three telescoping graphite stages, each stepping into the next through a steel collar,
    # with a light hairline ring partway down each stage.
    stages = [(z1 + 20.4, 141.0, 5.5, 4.7), (141.0, 210.0, 4.2, 3.6), (210.0, 258.0, 3.25, 2.75)]
    for n, (za, zb, ra, rb) in enumerate(stages):
        body.append((finish(lathe(f"Stage{n}", [(za, 0.0), (za, ra), (zb, rb), (zb, 0.0)], sides=24), graphite), None))
        # Clear of the progress bar on the first stage, partway down the others.
        u = 0.045 if n == 0 else 0.55
        mid = za + (zb - za) * u
        rm = ra + (rb - ra) * u
        body.append((finish(lathe(f"Hairline{n}", [(mid - 0.3, rm - 0.2), (mid - 0.3, rm + 0.18), (mid + 0.3, rm + 0.18), (mid + 0.3, rm - 0.2)], sides=24, closed=True), light), None))
    for n, (z, r) in enumerate(((141.0, 5.1), (210.0, 3.95))):
        collar = lathe(f"Collar{n}", [(z - 3.2, 0.0), (z - 3.2, r - 0.3), (z - 2.8, r), (z + 1.6, r), (z + 2.2, r - 0.45), (z + 2.2, 0.0)], sides=24)
        body.append((finish(collar, steel), None))

    # The progress bar: ten orange segments inlaid along the top of the first stage, which the
    # client lights one after another as a spell charges, like a build ticking along.
    za, zb, ra, rb = stages[0]
    seg_z0, seg_len, seg_gap = w["segments_z"], w["segment_len"], w["segment_gap"]
    segments = []
    for n in range(w["segments"]):
        z0 = seg_z0 + n * (seg_len + seg_gap)
        segments.append((f"wand-segment-{n}", inlay(f"Segment{n}", z0, z0 + seg_len, lambda z: ra + (rb - ra) * (z - za) / (zb - za), 0.6, 0.22), orange))
    # Its track: a graphite channel the segments sit in, a hair proud of the shaft.
    track_z1 = seg_z0 + w["segments"] * (seg_len + seg_gap) - seg_gap
    body.append((finish(inlay("Track", seg_z0 - 1.4, track_z1 + 1.4, lambda z: ra + (rb - ra) * (z - za) / (zb - za), 0.95, 0.1), steel), None))

    # Tip: a flared steel neck into the hub, the rotor's axle, and a thin guard ring round the
    # rotor on three struts, like a droid's ducted fan.
    rz = w["rotor_z"]
    neck = lathe("Neck", [(257.0, 0.0), (257.0, 2.8), (262.0, 2.9), (265.5, 3.7), (267.5, 3.7), (268.4, 3.2), (269.0, 2.0), (rz - 1.3, 1.45), (rz - 1.0, 1.05), (w["core_z"] - 0.6, 0.95), (w["core_z"] - 0.6, 0.0)], sides=24)
    body.append((finish(neck, steel), None))
    guard_r = w["guard_r"]
    guard = lathe("Guard", [(rz - 1.25, guard_r - 0.42), (rz - 1.25, guard_r + 0.42), (rz + 1.25, guard_r + 0.42), (rz + 1.25, guard_r - 0.42)], sides=48, closed=True)
    body.append((finish(guard, steel), None))
    for n in range(3):
        a = math.pi / 2 + math.tau * n / 3
        c, s = math.cos(a), math.sin(a)
        strut = tube_path(f"Strut{n}", [(3.4 * c / 1000, 3.4 * s / 1000, 266.5 / 1000), ((guard_r - 0.3) * c / 1000, (guard_r - 0.3) * s / 1000, (rz - 0.9) / 1000)], 0.42 / 1000, sides=6)
        body.append((finish(strut, steel), None))

    rotor = glyph_solid("Rotor", w["rotor_d"], 1.6)
    # The emitter: a six-sided crystal pointing down the shaft, in front of the rotor's hub.
    cr = w["core_r"]
    core = lathe("Core", [(-cr * 0.9, 0.0), (-cr * 0.35, cr), (cr * 0.55, cr), (w["tip_z"] - w["core_z"], 0.0)], sides=6, phase=math.pi / 6)
    loose_parts = [("wand-rotor", rotor, light), ("wand-core", core, orange)]
    return body, loose_parts + segments


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


def export(objs, name: str, draco: bool = True) -> str:
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
        export_draco_mesh_compression_enable=draco,
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
        # A joined body keeps its first part's name; give it the prop's instead.
        objs[0].name = entry.name
    return objs


def export_prop(entry: Prop) -> dict:
    """Build one prop, export its GLB, and return its manifest row."""
    objs = build_prop(entry)
    before, after = decimate_prop(objs, TRI_BUDGET)
    path = export(objs, entry.name, entry.draco)
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
