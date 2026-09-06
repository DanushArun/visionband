"""
Material library.

Five materials and one accent, applied by role and never mixed arbitrarily.
A product reads as considered when its material vocabulary is small and its
assignments are consistent; it reads as a student project when every part gets
its own colour.
"""

import bpy

# Roughness is doing most of the work here. The shell and the liner are almost
# the same value in lightness terms — what separates them is that one is a
# moulded polycarbonate (semi-matte, slight sheen) and the other is a soft
# elastomer against skin (fully matte).
SPECS = {
    "shell": {
        "base": (0.62, 0.62, 0.635, 1.0),   # neutral light grey, faint cool cast
        "roughness": 0.35,
        "metallic": 0.0,
        "note": "polycarbonate, outer arc",
    },
    "liner": {
        "base": (0.055, 0.057, 0.065, 1.0),
        "roughness": 0.92,
        "metallic": 0.0,
        "note": "TPE, skin contact",
    },
    "window": {
        # Near-black and glossy: an IR window has to pass 940 nm while reading as
        # opaque to the eye, which is exactly how it looks on real hardware.
        "base": (0.018, 0.019, 0.024, 1.0),
        "roughness": 0.06,
        "metallic": 0.0,
        "note": "IR-transparent ToF aperture",
    },
    "accent": {
        "base": (0.68, 0.69, 0.72, 1.0),
        "roughness": 0.28,
        "metallic": 1.0,
        "note": "anodised aluminium, temple ring",
    },
    "strap": {
        "base": (0.145, 0.150, 0.168, 1.0),
        "roughness": 0.96,
        "metallic": 0.0,
        "note": "knit elastic, rear band",
    },
    "skin": {
        "base": (0.52, 0.40, 0.34, 1.0),
        "roughness": 0.62,
        "metallic": 0.0,
        "note": "head reference",
    },
}


def make(name):
    spec = SPECS[name]
    mat_name = f"VB_{name}"
    mat = bpy.data.materials.get(mat_name) or bpy.data.materials.new(mat_name)

    # Blender 5 gives new materials a node tree already, and `use_nodes` is
    # deprecated for removal in 6.0 — only reach for it on older builds.
    if not mat.node_tree and hasattr(mat, "use_nodes"):
        mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF") if mat.node_tree else None
    if bsdf:
        bsdf.inputs["Base Color"].default_value = spec["base"]
        bsdf.inputs["Roughness"].default_value = spec["roughness"]
        bsdf.inputs["Metallic"].default_value = spec["metallic"]
    return mat


def all_materials():
    return {name: make(name) for name in SPECS}
