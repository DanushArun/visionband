"""
Studio renders of the prototype, headless.

    Blender --background --factory-startup --python cad/render_preview.py

Writes cad/preview/*.png — five product angles plus a worn view, which is the
only shot that actually proves the fit.

Runs in CI as well as by hand: if a parameter change breaks placement, it shows
up in an image rather than three milestones later.
"""

import math
import os
import runpy
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "preview")
sys.path.insert(0, HERE)

# name, azimuth°, elevation°, distance mm, show head
# Azimuth 0 looks at the face; the band's front is +Y.
VIEWS = [
    ("hero", 38, 14, 620, False),
    ("front", 0, 6, 560, False),
    ("side", 90, 4, 560, False),
    ("rear", 180, 10, 560, False),
    ("top", 0, 84, 620, False),
    ("worn", 34, 8, 760, True),
    ("worn-side", 96, 2, 760, True),
]


def purge_foreign_objects():
    """
    Drop anything that is not part of the model.

    headband.py deliberately leaves the rest of the scene alone so it is safe to
    run inside a file you are working in. That means Blender's startup Cube,
    Light and Camera survive — and a 2 m cube around a 150 mm headband fills
    every frame with white. This script owns its scene, so it cleans up.
    """
    keep = set()
    for coll in bpy.data.collections:
        if coll.name.startswith("VisionBand"):
            keep.update(coll.objects)
    for obj in list(bpy.data.objects):
        if obj not in keep:
            bpy.data.objects.remove(obj, do_unlink=True)


def build_model():
    mod = runpy.run_path(os.path.join(HERE, "headband.py"), run_name="vb_build")
    head = mod["build"](show_head=True)
    purge_foreign_objects()
    return head


def make_backdrop():
    """A large, gently curved sweep so the background falls off instead of
    ending in a visible horizon line."""
    bpy.ops.mesh.primitive_plane_add(size=4.0, location=(0, 0.9, -0.35))
    obj = bpy.context.active_object
    obj.name = "VB_Backdrop"
    obj.rotation_euler = (math.radians(74), 0, 0)

    sub = obj.modifiers.new("Sub", "SUBSURF")
    sub.levels = sub.render_levels = 3

    mat = bpy.data.materials.new("VB_Backdrop")
    if not mat.node_tree and hasattr(mat, "use_nodes"):
        mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (0.14, 0.145, 0.16, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.85
    obj.data.materials.append(mat)
    return obj


def setup_lighting():
    world = bpy.data.worlds.new("VB_World")
    bpy.context.scene.world = world
    # A new world has a node tree but, unlike a material, `use_nodes` is off — so
    # the renderer ignores the Background node and falls back to world.color.
    # Set both and it is right either way.
    world.color = (0.045, 0.048, 0.055)
    try:
        world.use_nodes = True
    except Exception:
        pass
    bg = world.node_tree.nodes.get("Background") if world.node_tree else None
    if bg:
        bg.inputs["Color"].default_value = (0.045, 0.048, 0.055, 1.0)
        bg.inputs["Strength"].default_value = 1.0

    # Large, close and soft: a 15 cm object needs broad sources or every curved
    # surface collapses into a hard specular line. Energies suit ~0.6 m throw.
    for name, loc, energy, size in [
        ("Key", (0.45, -0.55, 0.55), 42, 1.10),
        ("Fill", (-0.65, -0.25, 0.10), 14, 1.30),
        ("Rim", (-0.15, 0.70, 0.45), 26, 0.80),
        ("Kick", (0.70, 0.25, -0.15), 10, 0.70),
    ]:
        light = bpy.data.lights.new(name, type="AREA")
        light.energy = energy
        light.size = size
        obj = bpy.data.objects.new(name, light)
        obj.location = loc
        obj.rotation_euler = (Vector((0, 0, 0)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        bpy.context.scene.collection.objects.link(obj)


def setup_camera():
    cam_data = bpy.data.cameras.new("VB_Cam")
    # A long lens keeps the perspective flat, which is how products are shot.
    cam_data.lens = 95
    cam = bpy.data.objects.new("VB_Cam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    return cam


def aim(cam, azimuth_deg, elevation_deg, distance_mm, target):
    az = math.radians(azimuth_deg)
    el = math.radians(elevation_deg)
    d = distance_mm * 0.001
    cam.location = (
        target.x + math.sin(az) * math.cos(el) * d,
        target.y - math.cos(az) * math.cos(el) * d,
        target.z + math.sin(el) * d,
    )
    cam.rotation_euler = (target - Vector(cam.location)).to_track_quat("-Z", "Y").to_euler()


def configure_render(scene):
    # The EEVEE identifier has moved across releases (BLENDER_EEVEE →
    # BLENDER_EEVEE_NEXT → back again), so pick whatever this build offers.
    available = {e.identifier for e in
                 type(scene.render).bl_rna.properties["engine"].enum_items}
    for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"):
        if engine in available:
            scene.render.engine = engine
            break

    scene.render.resolution_x = 1400
    scene.render.resolution_y = 1000
    scene.render.image_settings.file_format = "PNG"

    ee = getattr(scene, "eevee", None)
    if ee is not None:
        for attr, value in (("taa_render_samples", 96), ("use_gtao", True),
                            ("use_raytracing", True), ("use_shadows", True)):
            if hasattr(ee, attr):
                setattr(ee, attr, value)

    # Blender 5 defaults to AgX, which desaturates hard. The parts are colour-
    # coded by material and the palette should read as authored.
    try:
        scene.view_settings.view_transform = "Standard"
    except (TypeError, AttributeError):
        pass
    try:
        scene.view_settings.look = "None"
    except (TypeError, AttributeError):
        pass
    # Without this the shell's 0.62 albedo blows out and every part reads white.
    scene.view_settings.exposure = -1.45


def main():
    build_model()
    make_backdrop()
    setup_lighting()
    cam = setup_camera()
    configure_render(bpy.context.scene)

    head = bpy.data.objects.get("HeadReference")
    scene = bpy.context.scene
    os.makedirs(OUT, exist_ok=True)

    for name, az, el, dist, show_head in VIEWS:
        if head:
            head.hide_render = not show_head
        # Frame the band, not the head: the crown is 90 mm above the band plane
        # and centring on it would push the product to the bottom of every shot.
        target = Vector((0.0, 0.0, 0.012 if not show_head else 0.03))
        aim(cam, az, el, dist, target)
        scene.render.filepath = os.path.join(OUT, f"{name}.png")
        bpy.ops.render.render(write_still=True)
        print(f"wrote {scene.render.filepath}")


if __name__ == "__main__":
    main()
