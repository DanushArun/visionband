"""
Opens Blender with the prototype built and ready to iterate on.

    /Applications/Blender.app/Contents/MacOS/Blender --python cad/launch.py

Builds the model, clears Blender's startup Cube/Light/Camera, frames the
viewport in material preview, and loads headband.py into the Text Editor.

To see a change: edit cad/headband.py, then in Blender's Scripting tab press
Alt+P (Run Script). The build is idempotent — it removes its own collections
first — so re-running rebuilds in place rather than stacking duplicates.
"""

import os
import runpy
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "headband.py")


def purge_foreign_objects():
    """
    headband.py deliberately leaves the rest of the scene alone so it is safe to
    run inside a file you are working in. That leaves Blender's startup Cube,
    Light and Camera behind — and a 2 m cube around a 15 cm headband hides it
    completely. This launcher owns its scene, so it can clean up.
    """
    keep = set()
    for coll in bpy.data.collections:
        if coll.name.startswith("VisionBand"):
            keep.update(coll.objects)
    for obj in list(bpy.data.objects):
        if obj not in keep:
            bpy.data.objects.remove(obj, do_unlink=True)


def load_into_text_editor():
    """
    Put the sources in front of the user so Alt+P rebuilds immediately.

    All four modules are loaded, not just headband.py: the numbers worth
    changing live in profile.py (section sizes, bearings, bias) and head.py
    (target circumference, band drop, tilt).
    """
    for text in list(bpy.data.texts):
        bpy.data.texts.remove(text)

    loaded = []
    for name in ("headband.py", "profile.py", "head.py", "materials.py"):
        path = os.path.join(HERE, name)
        if os.path.exists(path):
            loaded.append(bpy.data.texts.load(path))

    for area in bpy.context.screen.areas:
        if area.type == "TEXT_EDITOR":
            area.spaces[0].text = loaded[0]
    return loaded


def frame_viewport():
    for area in bpy.context.screen.areas:
        if area.type != "VIEW_3D":
            continue
        space = area.spaces[0]
        space.shading.type = "MATERIAL"
        space.clip_start = 0.001   # millimetre-scale parts clip away at the default 0.1 m
        space.clip_end = 100.0
        for region in area.regions:
            if region.type == "WINDOW":
                with bpy.context.temp_override(area=area, region=region):
                    bpy.ops.object.select_all(action="SELECT")
                    bpy.ops.view3d.view_selected()
                    bpy.ops.object.select_all(action="DESELECT")


def main():
    sys.path.insert(0, HERE)
    runpy.run_path(SCRIPT, run_name="__main__")
    purge_foreign_objects()
    load_into_text_editor()
    frame_viewport()
    print("\nVisionBand loaded on the CC0 head. Edit any of the loaded scripts, "
          "then Alt+P in the Scripting tab to rebuild in place.\n"
          "Dimensions live in profile.py; head sizing and band seating in head.py.\n")


if __name__ == "__main__":
    main()
