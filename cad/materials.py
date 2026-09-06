"""
Material library — physically-based node graphs for Cycles.

Five materials and one accent, applied by role and never mixed arbitrarily.
A product reads as considered when its material vocabulary is small and its
assignments are consistent.

Three things separate a render that reads as photographed from one that reads as
computed, and all three are here:

1. **Micro-bevelled edges.** Nothing real has a perfectly sharp edge; every one
   catches a thin highlight. The Bevel node rounds shading normals without
   touching geometry. This is Cycles-only and is the single largest gain.
2. **Roughness that varies.** A uniform roughness value is the giveaway of CG
   plastic. Real mouldings vary across the surface, so every material gets a
   little procedural noise on its roughness.
3. **A clear coat where the material has one.** Moulded polycarbonate has a
   distinct surface layer over its pigment; one specular lobe cannot express it.
"""

import bpy

MM = 0.001

SPECS = {
    "shell": {
        "base": (0.60, 0.605, 0.625, 1.0),
        "roughness": 0.34, "rough_var": 0.07, "rough_scale": 26.0,
        "coat": 0.35, "coat_roughness": 0.09,
        "bevel": 0.35,
        "note": "polycarbonate, outer arc",
    },
    "liner": {
        "base": (0.048, 0.050, 0.058, 1.0),
        "roughness": 0.88, "rough_var": 0.06, "rough_scale": 60.0,
        "bump": 0.35, "bump_scale": 320.0,
        "bevel": 0.30,
        "note": "TPE, skin contact",
    },
    "window": {
        # Near-black and glossy: an IR window passes 940 nm while reading opaque
        # to the eye, which is how it looks on real hardware.
        "base": (0.014, 0.015, 0.019, 1.0),
        "roughness": 0.055, "rough_var": 0.015, "rough_scale": 90.0,
        "coat": 1.0, "coat_roughness": 0.02,
        "bevel": 0.18,
        "note": "IR-transparent ToF aperture",
    },
    "accent": {
        "base": (0.66, 0.67, 0.70, 1.0),
        "metallic": 1.0,
        "roughness": 0.23, "rough_var": 0.05, "rough_scale": 120.0,
        "anisotropic": 0.45,
        "bevel": 0.20,
        "note": "anodised aluminium, temple ring",
    },
    "strap": {
        "base": (0.030, 0.032, 0.038, 1.0),
        "roughness": 0.95, "rough_var": 0.05, "rough_scale": 90.0,
        "sheen": 0.55, "sheen_roughness": 0.35,
        "bump": 0.9, "bump_scale": 900.0,
        "bevel": 0.4,
        "note": "knit elastic, rear band",
    },
    "skin": {
        "base": (0.60, 0.44, 0.37, 1.0),
        "roughness": 0.52, "rough_var": 0.10, "rough_scale": 45.0,
        "subsurface": 0.16, "subsurface_radius": (0.012, 0.006, 0.004),
        "bump": 0.12, "bump_scale": 700.0,
        "note": "head reference",
    },
}


def _clear(mat):
    if not mat.node_tree and hasattr(mat, "use_nodes"):
        mat.use_nodes = True
    nt = mat.node_tree
    for node in list(nt.nodes):
        if node.type not in {"BSDF_PRINCIPLED", "OUTPUT_MATERIAL"}:
            nt.nodes.remove(node)
    return nt, nt.nodes.get("Principled BSDF")


def _set(bsdf, name, value):
    """Set a socket only if this Blender build has it."""
    if name in bsdf.inputs:
        bsdf.inputs[name].default_value = value
        return True
    return False


def _noise(nt, scale, detail=6.0, location=(-800, 0)):
    node = nt.nodes.new("ShaderNodeTexNoise")
    node.location = location
    node.inputs["Scale"].default_value = scale
    if "Detail" in node.inputs:
        node.inputs["Detail"].default_value = detail
    return node


def _roughness_variation(nt, bsdf, base, amount, scale):
    """Drive Roughness from noise remapped into [base-amount, base+amount]."""
    noise = _noise(nt, scale, location=(-900, -200))
    remap = nt.nodes.new("ShaderNodeMapRange")
    remap.location = (-620, -200)
    remap.inputs["From Min"].default_value = 0.35
    remap.inputs["From Max"].default_value = 0.65
    remap.inputs["To Min"].default_value = max(0.0, base - amount)
    remap.inputs["To Max"].default_value = min(1.0, base + amount)
    remap.clamp = True
    nt.links.new(noise.outputs["Fac"], remap.inputs["Value"])
    nt.links.new(remap.outputs["Result"], bsdf.inputs["Roughness"])


def _surface_normal(nt, bsdf, bevel_mm=0.0, bump=0.0, bump_scale=200.0):
    """
    Build the Normal input: an optional fine bump, fed through a Bevel node.

    Order matters — the bevel has to be last so the rounded edge normal is what
    reaches the BSDF. Chaining them the other way lets the bump overwrite it and
    the edges go sharp again.
    """
    source = None
    if bump:
        noise = _noise(nt, bump_scale, detail=8.0, location=(-900, -520))
        bump_node = nt.nodes.new("ShaderNodeBump")
        bump_node.location = (-620, -520)
        bump_node.inputs["Strength"].default_value = bump
        bump_node.inputs["Distance"].default_value = 0.0004
        nt.links.new(noise.outputs["Fac"], bump_node.inputs["Height"])
        source = bump_node.outputs["Normal"]

    if bevel_mm:
        bevel = nt.nodes.new("ShaderNodeBevel")
        bevel.location = (-380, -420)
        bevel.samples = 8
        bevel.inputs["Radius"].default_value = bevel_mm * MM
        if source is not None:
            nt.links.new(source, bevel.inputs["Normal"])
        source = bevel.outputs["Normal"]

    if source is not None:
        nt.links.new(source, bsdf.inputs["Normal"])


def make(name):
    spec = SPECS[name]
    mat_name = f"VB_{name}"
    mat = bpy.data.materials.get(mat_name) or bpy.data.materials.new(mat_name)
    nt, bsdf = _clear(mat)
    if bsdf is None:
        return mat

    _set(bsdf, "Base Color", spec["base"])
    _set(bsdf, "Metallic", spec.get("metallic", 0.0))
    _set(bsdf, "Roughness", spec["roughness"])
    _set(bsdf, "IOR", spec.get("ior", 1.48))

    if spec.get("coat"):
        _set(bsdf, "Coat Weight", spec["coat"])
        _set(bsdf, "Coat Roughness", spec.get("coat_roughness", 0.05))
    if spec.get("sheen"):
        _set(bsdf, "Sheen Weight", spec["sheen"])
        _set(bsdf, "Sheen Roughness", spec.get("sheen_roughness", 0.3))
    if spec.get("anisotropic"):
        _set(bsdf, "Anisotropic", spec["anisotropic"])
    if spec.get("subsurface"):
        _set(bsdf, "Subsurface Weight", spec["subsurface"])
        _set(bsdf, "Subsurface Radius", spec.get("subsurface_radius", (0.01, 0.005, 0.003)))
        _set(bsdf, "Subsurface Scale", 0.02)

    if spec.get("rough_var"):
        _roughness_variation(nt, bsdf, spec["roughness"],
                             spec["rough_var"], spec.get("rough_scale", 40.0))

    _surface_normal(nt, bsdf, spec.get("bevel", 0.0),
                    spec.get("bump", 0.0), spec.get("bump_scale", 200.0))
    return mat


def all_materials():
    return {name: make(name) for name in SPECS}
