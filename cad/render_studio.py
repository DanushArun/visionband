"""
Photoreal product renders — Cycles, GPU, HDRI studio.

    Blender --background --factory-startup --python cad/render_studio.py
    Blender --background --factory-startup --python cad/render_studio.py -- --views hero worn --samples 128

Writes cad/studio/*.png.

cad/render_preview.py stays as the fast EEVEE loop for checking geometry while
iterating. This is the deliverable: real path tracing, so reflections, shadows
and bounced light are computed rather than approximated.

Requires the HDRI: `python3 cad/fetch_hdri.py`. It falls back to emissive
softboxes if that is missing, which still works but reflects flat white
rectangles instead of a room.
"""

import math
import os
import runpy
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "studio")
HDRI = os.path.join(HERE, "assets", "brown_photostudio_02_2k.hdr")
sys.path.insert(0, HERE)

# name, azimuth°, elevation°, distance mm, show head, focal mm
VIEWS = {
    "hero":      (38, 14, 620, False, 105),
    "front":     (0, 6, 560, False, 105),
    "side":      (90, 4, 560, False, 105),
    "rear":      (180, 10, 560, False, 105),
    "top":       (0, 84, 640, False, 85),
    "detail":    (62, 6, 300, False, 135),   # temple pod and accent ring
    "worn":      (34, 8, 780, True, 105),
    "worn-side": (96, 2, 780, True, 105),
}
DEFAULT_VIEWS = ["hero", "front", "side", "rear", "top", "detail", "worn", "worn-side"]


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    views, samples = list(DEFAULT_VIEWS), 400
    if "--views" in argv:
        i = argv.index("--views") + 1
        views = []
        while i < len(argv) and not argv[i].startswith("--"):
            views.append(argv[i])
            i += 1
    if "--samples" in argv:
        samples = int(argv[argv.index("--samples") + 1])
    return views, samples


def purge_foreign_objects():
    keep = set()
    for coll in bpy.data.collections:
        if coll.name.startswith("VisionBand"):
            keep.update(coll.objects)
    for obj in list(bpy.data.objects):
        if obj not in keep:
            bpy.data.objects.remove(obj, do_unlink=True)


def build_model():
    mod = runpy.run_path(os.path.join(HERE, "headband.py"), run_name="vb_build")
    mod["build"](show_head=True)
    purge_foreign_objects()


def setup_world():
    """
    HDRI environment.

    This is what makes glossy plastic look photographed: it reflects a real room
    with real softbox shapes and real falloff. Point and area lights alone give
    reflections that read as CG because nothing in a real studio is a bare
    white rectangle on black.
    """
    world = bpy.data.worlds.new("VB_Studio")
    bpy.context.scene.world = world
    world.color = (0.05, 0.05, 0.055)
    try:
        world.use_nodes = True
    except Exception:
        pass

    nt = world.node_tree
    bg = nt.nodes.get("Background")
    if bg is None:
        return False

    if not os.path.exists(HDRI):
        print(f"HDRI not found at {HDRI} — falling back to softboxes only.\n"
              "Run `python3 cad/fetch_hdri.py` for the studio environment.")
        bg.inputs["Color"].default_value = (0.05, 0.05, 0.055, 1.0)
        bg.inputs["Strength"].default_value = 1.0
        return False

    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(HDRI)
    env.location = (-600, 0)

    # The studio is warm-toned; pull the saturation back so it lights the scene
    # without tinting a product whose materials are deliberately neutral.
    hsv = nt.nodes.new("ShaderNodeHueSaturation")
    hsv.location = (-320, 0)
    hsv.inputs["Saturation"].default_value = 0.35
    hsv.inputs["Value"].default_value = 1.0

    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.location = (-820, 0)
    mapping.inputs["Rotation"].default_value = (0.0, 0.0, math.radians(115))
    texco = nt.nodes.new("ShaderNodeTexCoord")
    texco.location = (-1030, 0)

    nt.links.new(texco.outputs["Generated"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], env.inputs["Vector"])
    nt.links.new(env.outputs["Color"], hsv.inputs["Color"])
    nt.links.new(hsv.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.55
    return True


def add_softboxes():
    """
    Two large area lights on top of the HDRI.

    The environment supplies believable ambient and reflections; these give the
    crisp, shaped highlight along the shell that says "product photograph"
    rather than "lit by a room". In Cycles they appear in glossy reflections as
    the rectangles they are, which is exactly what a real softbox does.
    """
    for name, loc, energy, size, rot in [
        ("Key", (0.42, -0.48, 0.52), 13, 0.90, None),
        ("Rim", (-0.34, 0.52, 0.30), 8, 0.55, None),
    ]:
        light = bpy.data.lights.new(name, type="AREA")
        light.energy = energy
        light.size = size
        light.shape = "RECTANGLE" if hasattr(light, "shape") else light.shape
        if hasattr(light, "size_y"):
            light.size_y = size * 0.55
        obj = bpy.data.objects.new(name, light)
        obj.location = loc
        obj.rotation_euler = rot or (
            Vector((0, 0, 0.01)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        bpy.context.scene.collection.objects.link(obj)


def add_ground():
    """
    A large soft-reflective floor.

    Products are photographed on a surface, and the contact shadow plus the faint
    reflection under the object is most of what tells the eye it has weight and
    sits somewhere. Floating in a void reads as a 3D model every time.
    """
    bpy.ops.mesh.primitive_plane_add(size=6.0, location=(0, 0, -0.075))
    obj = bpy.context.active_object
    obj.name = "VB_Ground"

    mat = bpy.data.materials.new("VB_Ground")
    if not mat.node_tree and hasattr(mat, "use_nodes"):
        mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (0.035, 0.036, 0.042, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.28
        if "Coat Weight" in bsdf.inputs:
            bsdf.inputs["Coat Weight"].default_value = 0.2
    obj.data.materials.append(mat)
    return obj


def setup_camera():
    cam_data = bpy.data.cameras.new("VB_Cam")
    cam_data.lens = 105
    cam_data.dof.use_dof = True
    # f/14 keeps the whole 190 mm depth of the band sharp while still softening
    # the backdrop. f/5.6 at 105 mm and 620 mm was shallow enough to blur the
    # far side of the product, which reads as a mistake rather than a choice.
    cam_data.dof.aperture_fstop = 14.0
    cam = bpy.data.objects.new("VB_Cam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    return cam


def aim(cam, azimuth_deg, elevation_deg, distance_mm, target, focal):
    az, el = math.radians(azimuth_deg), math.radians(elevation_deg)
    d = distance_mm * 0.001
    cam.data.lens = focal
    cam.location = (
        target.x + math.sin(az) * math.cos(el) * d,
        target.y - math.cos(az) * math.cos(el) * d,
        target.z + math.sin(el) * d,
    )
    cam.rotation_euler = (target - Vector(cam.location)).to_track_quat("-Z", "Y").to_euler()
    cam.data.dof.focus_distance = (target - Vector(cam.location)).length


def configure_cycles(scene, samples):
    scene.render.engine = "CYCLES"

    prefs = bpy.context.preferences.addons.get("cycles")
    if prefs:
        cp = prefs.preferences
        for backend in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
            try:
                cp.compute_device_type = backend
                break
            except TypeError:
                continue
        cp.get_devices()
        for device in cp.devices:
            device.use = device.type != "CPU"
        scene.cycles.device = "GPU"

    scene.cycles.samples = samples
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.01
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 12
    scene.cycles.transmission_bounces = 8
    scene.cycles.caustics_reflective = True

    scene.render.resolution_x = 1600
    scene.render.resolution_y = 1200
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"

    # AgX here, unlike the EEVEE previews. Those wanted Standard so the palette
    # read as authored; a photoreal render wants filmic highlight rolloff,
    # because clipped white highlights are what make CG look like CG.
    try:
        scene.view_settings.view_transform = "AgX"
    except (TypeError, AttributeError):
        pass
    try:
        scene.view_settings.look = "AgX - Medium Contrast"
    except (TypeError, AttributeError):
        pass
    # Metered against the shell, whose 0.60 albedo should read as light grey.
    # At +0.35 the HDRI plus both softboxes blew shell, strap and ground to the
    # same white, which is the fastest way to lose a material palette.
    scene.view_settings.exposure = -0.9


def main():
    views, samples = parse_args()
    build_model()
    setup_world()
    add_softboxes()
    add_ground()
    cam = setup_camera()
    configure_cycles(bpy.context.scene, samples)

    head = bpy.data.objects.get("HeadReference")
    scene = bpy.context.scene
    os.makedirs(OUT, exist_ok=True)

    for name in views:
        if name not in VIEWS:
            print(f"unknown view {name!r}; known: {', '.join(VIEWS)}")
            continue
        az, el, dist, show_head, focal = VIEWS[name]
        if head:
            head.hide_render = not show_head
        target = Vector((0.0, 0.0, 0.012 if not show_head else 0.03))
        aim(cam, az, el, dist, target, focal)
        scene.render.filepath = os.path.join(OUT, f"{name}.png")
        bpy.ops.render.render(write_still=True)
        print(f"wrote {scene.render.filepath}")


if __name__ == "__main__":
    main()
