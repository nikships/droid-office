#!/usr/bin/env python3
"""Convert the pinned Samsung controller GLBs to bounded native draw data.

Uses Python's standard library. Geometry, authored transforms, UVs and PNG pixels
remain unchanged; the two controllers share their identical texture images.
"""

import argparse
import hashlib
import json
from pathlib import Path
import struct
import urllib.request

COMMIT = "f4992299601614adbfefd398dc8e281556bb7444"
BASE = f"https://raw.githubusercontent.com/immersive-web/webxr-input-profiles/{COMMIT}/"
HASHES = {
    "left": "421c6810f0ded2a4e6f01cae03bc46a0828322f0c5219e80ab7ca77d37995b53",
    "right": "6bb28b3e3c69890dd40496df820746d385f101c67b69ae8564b17107a4b318c7",
}
KINDS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}
COMPONENTS = {5123: ("H", 2), 5126: ("f", 4)}


def source_bytes(hand, source_dir):
    if source_dir:
        data = (source_dir / f"{hand}.glb").read_bytes()
    else:
        with urllib.request.urlopen(BASE + f"packages/assets/profiles/samsung-galaxyxr/{hand}.glb", timeout=60) as response:
            data = response.read(8 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != HASHES[hand]:
        raise ValueError(f"{hand}.glb does not match the pinned SHA-256")
    return data


def parse_glb(data):
    magic, version, length = struct.unpack_from("<III", data)
    if magic != 0x46546C67 or version != 2 or length != len(data):
        raise ValueError("Invalid GLB header")
    offset, chunks = 12, {}
    while offset < len(data):
        size, kind = struct.unpack_from("<II", data, offset)
        offset += 8
        if offset + size > len(data) or kind in chunks:
            raise ValueError("Invalid GLB chunk")
        chunks[kind] = data[offset:offset + size]
        offset += size
    return json.loads(chunks[0x4E4F534A]), chunks[0x004E4942]


def accessor(gltf, binary, index):
    a = gltf["accessors"][index]
    if a.get("sparse") or a.get("normalized"):
        raise ValueError("Unexpected accessor layout")
    view = gltf["bufferViews"][a["bufferView"]]
    fmt, width = COMPONENTS[a["componentType"]]
    dims = KINDS[a["type"]]
    stride = view.get("byteStride", dims * width)
    offset = view.get("byteOffset", 0) + a.get("byteOffset", 0)
    end = view.get("byteOffset", 0) + view["byteLength"]
    if a["count"] > 16384 or offset + (a["count"] - 1) * stride + dims * width > end:
        raise ValueError("Accessor exceeds its bounds")
    return [struct.unpack_from("<" + fmt * dims, binary, offset + i * stride) for i in range(a["count"])]


def pose(node):
    if "matrix" in node:
        raise ValueError("Unexpected matrix node")
    return {
        "position": node.get("translation", [0, 0, 0]),
        "rotation": node.get("rotation", [0, 0, 0, 1]),
        "scale": node.get("scale", [1, 1, 1]),
    }


def convert(hand, data, destination):
    gltf, binary = parse_glb(data)
    old_nodes, nodes, remap = gltf["nodes"], [], {}

    def visit(index, parent):
        if index in remap or len(nodes) >= 128:
            raise ValueError("Non-tree or oversized controller hierarchy")
        mapped = len(nodes)
        remap[index] = mapped
        old = old_nodes[index]
        nodes.append({"name": old["name"], "parent": parent, **pose(old)})
        for child in old.get("children", []):
            visit(child, mapped)

    for root in gltf["scenes"][gltf.get("scene", 0)]["nodes"]:
        visit(root, -1)
    vertices, indices, draws = [], [], []
    for old_index, mapped in remap.items():
        old = old_nodes[old_index]
        if "mesh" not in old:
            continue
        for primitive in gltf["meshes"][old["mesh"]]["primitives"]:
            if primitive.get("mode", 4) != 4:
                raise ValueError("Controller primitive is not triangles")
            attributes = primitive["attributes"]
            positions = accessor(gltf, binary, attributes["POSITION"])
            normals = accessor(gltf, binary, attributes["NORMAL"])
            uvs = accessor(gltf, binary, attributes["TEXCOORD_0"])
            elements = [v[0] for v in accessor(gltf, binary, primitive["indices"])]
            if len(positions) != len(normals) or len(positions) != len(uvs) or max(elements) >= len(positions):
                raise ValueError("Invalid controller geometry")
            draws.append({"node": mapped, "material": primitive["material"], "firstVertex": len(vertices),
                          "vertexCount": len(positions), "firstIndex": len(indices), "indexCount": len(elements)})
            vertices.extend([*p, *n, *uv] for p, n, uv in zip(positions, normals, uvs))
            indices.extend(elements)
    images = []
    for image in gltf["images"]:
        view = gltf["bufferViews"][image["bufferView"]]
        pixels = binary[view.get("byteOffset", 0):view.get("byteOffset", 0) + view["byteLength"]]
        if image["mimeType"] != "image/png":
            raise ValueError("Unexpected controller image encoding")
        key = hashlib.sha256(pixels).hexdigest()
        name = f"texture-{key[:16]}.png"
        existing = destination / name
        if existing.exists() and existing.read_bytes() != pixels:
            raise ValueError("Texture hash collision")
        existing.write_bytes(pixels)
        images.append({"file": name, "sha256": key, "width": struct.unpack_from(">I", pixels, 16)[0],
                       "height": struct.unpack_from(">I", pixels, 20)[0]})

    def image_id(texture):
        return gltf["textures"][texture["index"]]["source"] if texture else -1

    materials = []
    for m in gltf["materials"]:
        pbr = m.get("pbrMetallicRoughness", {})
        materials.append({"base": image_id(pbr.get("baseColorTexture")), "normal": image_id(m.get("normalTexture")),
                          "metallicRoughness": image_id(pbr.get("metallicRoughnessTexture")),
                          "emissive": image_id(m.get("emissiveTexture")), "color": pbr.get("baseColorFactor", [1, 1, 1, 1]),
                          "emissiveFactor": m.get("emissiveFactor", [0, 0, 0]),
                          "metallic": pbr.get("metallicFactor", 1), "roughness": pbr.get("roughnessFactor", 1),
                          "transparent": m.get("alphaMode", "OPAQUE") == "BLEND", "doubleSided": m.get("doubleSided", False)})
    named = {node["name"]: i for i, node in enumerate(nodes)}
    response_names = {"xr_standard_trigger": "trigger", "xr_standard_squeeze": "squeeze",
                      "xr_standard_thumbstick": "stickClick", "xr_standard_thumbstick_xaxis": "stickX",
                      "xr_standard_thumbstick_yaxis": "stickY", "x_button": "primary", "a_button": "primary",
                      "y_button": "secondary", "b_button": "secondary", "menu": "menu"}
    responses = []
    original_names = {node["name"]: node for node in old_nodes}
    for name, channel in response_names.items():
        value = name + "_pressed_value"
        if value not in named:
            continue
        responses.append({"node": named[value], "channel": channel, "min": pose(original_names[name + "_pressed_min"]),
                          "max": pose(original_names[name + "_pressed_max"])})
    packed = struct.pack("<4sIII", b"DXRC", 1, len(vertices), len(indices))
    packed += b"".join(struct.pack("<8f", *v) for v in vertices)
    packed += struct.pack("<" + "H" * len(indices), *indices)
    (destination / f"{hand}.bin").write_bytes(packed)
    manifest = {"version": 1, "sourceCommit": COMMIT, "sourceSha256": HASHES[hand], "hand": hand,
                "geometry": f"{hand}.bin", "geometrySha256": hashlib.sha256(packed).hexdigest(),
                "nodes": nodes, "draws": draws, "materials": materials, "images": images, "responses": responses}
    (destination / f"{hand}.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=True) + "\n")
    return {"hand": hand, "vertices": len(vertices), "triangles": len(indices) // 3,
            "draws": len(draws), "geometryBytes": len(packed)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, help="Use verified downloaded GLBs instead of fetching them")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "android/app/src/main/assets/controllers/samsung-galaxyxr")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    for hand in ("left", "right"):
        print(json.dumps(convert(hand, source_bytes(hand, args.source_dir), args.output)))


if __name__ == "__main__":
    main()
