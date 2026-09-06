"""
VisionBand — industrial design model, built around a real head.

    Blender --background --factory-startup --python cad/headband.py

The band's path is derived by raycasting onto Blender Studio's CC0 head mesh, so
it follows the actual skull rather than an idealised ellipse: above the brow at
the front, tucked under the occipital bulge at the back. The shell is a single
swept surface whose section grows where a sensor or a battery has to fit — see
cad/profile.py for why that matters.

Architecture: rigid front arc (±125°) + a small rigid pod at the occiput +
soft strap segments between. The rear pod is not decoration. A rear-facing ToF
mounted on the front arc would be aimed straight into the wearer's own head, so
360° coverage (requirement F3) forces a rigid mount at the back.

What this is NOT: manufacturing surfaces. No wall thicknesses, draft angles or
fastener bosses, and Blender's smooth shading is not curvature continuity. This
is an industrial-design study and a printable form. Class-A surfacing is Fusion,
Alias or Plasticity, and that is M4 work.
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import head as head_mod            # noqa: E402
import materials as materials_mod  # noqa: E402
import profile as prof             # noqa: E402

MM = 0.001

# Datasheet dimensions, mm. Same parts as the earlier placement study.
PARTS = {
    "tof_pcb": (13.0, 11.0, 1.6),      # VL53L5CX breakout
    "tof_window": (11.0, 9.0),          # visible aperture
    "transducer_dia": 18.0,             # bone-conduction exciter
    "mcu": (25.5, 18.0, 3.1),           # ESP32-S3-WROOM-1
    "imu": (12.7, 12.7, 3.0),           # BNO085
    "cell": (34.0, 25.0, 5.0),          # ~500 mAh LiPo, one behind each ear
}

# Grams. Two cells now, one per side, instead of a single rear brick.
MASSES = {
    "shell": 22.0, "liner": 9.0, "strap": 14.0, "tof": 1.0, "imu": 1.0,
    "transducer": 8.0, "lra": 1.2, "mcu": 3.0, "pcb": 6.0, "cell": 11.0,
}

GROUND_SENSOR_PITCH = -35.0  # degrees, requirement F6


# ---------------------------------------------------------------- scene utils

def clear_scene():
    """
    Remove only this model's collections.

    Deliberately non-destructive to the rest of the file, so the script is safe
    to run inside a scene you are working in. cad/launch.py and
    cad/render_preview.py own their scenes and clean up the rest themselves.
    """
    for coll in list(bpy.data.collections):
        if coll.name.startswith("VisionBand"):
            for obj in list(coll.objects):
                bpy.data.objects.remove(obj, do_unlink=True)
            bpy.data.collections.remove(coll)
    for obj in list(bpy.data.objects):
        if obj.name.startswith(("HeadReference", "VB_")):
            bpy.data.objects.remove(obj, do_unlink=True)


def setup_units():
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "MILLIMETERS"


def collection(name, parent=None):
    coll = bpy.data.collections.new(name)
    (parent or bpy.context.scene.collection).children.link(coll)
    return coll


def shade_smooth(obj, angle_deg=42.0):
    """
    Smooth shading with a sharp-edge cutoff.

    Chosen over Subdivision Surface on purpose: subsurf shrinks a capped tube
    away from its control cage, which would silently break the fit measurements
    this model exists to produce. The section is sampled densely enough
    (48 points) that smooth shading alone reads as a continuous surface.
    """
    for poly in obj.data.polygons:
        poly.use_smooth = True
    mod = obj.modifiers.new("Smooth", "SMOOTH_BY_ANGLE") if \
        "SMOOTH_BY_ANGLE" in {i.identifier for i in
                              bpy.types.Modifier.bl_rna.properties["type"].enum_items} else None
    if mod and hasattr(mod, "angle"):
        mod.angle = math.radians(angle_deg)


# ---------------------------------------------------------------- sweeping

def _frames(ring, gap_fn):
    """
    Per-sample coordinate frames along the band path.

    Each frame is (origin, outward, up, bearing). `outward` starts as the head's
    true surface normal, then has any component along the path removed — a raw
    normal is not perpendicular to the tangent on a lumpy mesh, and a section
    built on a skewed frame shears the sweep.
    """
    n = len(ring)
    out = []
    for i, (pt, nrm, bearing) in enumerate(ring):
        nxt = ring[(i + 1) % n][0]
        prv = ring[(i - 1) % n][0]
        tangent = (nxt - prv).normalized()

        outward = Vector((nrm.x, nrm.y, nrm.z))
        outward -= tangent * outward.dot(tangent)
        if outward.length < 1e-6:
            outward = Vector((pt.x, pt.y, 0.0)).normalized()
        outward.normalize()

        up = tangent.cross(outward)
        if up.z < 0:
            up = -up
        up.normalize()

        gap = gap_fn(math.degrees(bearing)) if callable(gap_fn) else gap_fn
        origin = pt + outward * (gap * MM)
        out.append((origin, outward, up, bearing))
    return out


def _arc_slice(frames, lo_deg, hi_deg):
    """
    Frames whose bearing falls in [lo, hi], ordered along the path.

    Bearings run 0..360 around the ring, but an arc through the front wraps
    across 0 — so the slice is taken on the signed difference from the arc's
    centre rather than by comparing raw angles.
    """
    centre = (lo_deg + hi_deg) / 2.0
    half = (hi_deg - lo_deg) / 2.0
    picked = []
    for f in frames:
        deg = math.degrees(f[3])
        d = (deg - centre + 180.0) % 360.0 - 180.0
        if abs(d) <= half:
            picked.append((d, f))
    picked.sort(key=lambda x: x[0])
    return [f for _, f in picked]


def tapered(dims_fn, lo_deg, hi_deg, run_deg=16.0, end_dims=None):
    """
    Wrap a dims function so the section shrinks toward the strap at each end.

    A swept tube that simply stops leaves a flat disc facing the strap, and the
    two parts read as jammed together rather than as one continuing form. Ramping
    the section down to the strap's own dimensions over the last few degrees
    makes the shell hand off to the strap instead of butting against it.
    """
    end = end_dims if end_dims is not None else prof.strap_dims(0.0)

    def wrapped(bearing):
        h, t, off = dims_fn(bearing)
        d_lo = abs((bearing - lo_deg + 180.0) % 360.0 - 180.0)
        d_hi = abs((bearing - hi_deg + 180.0) % 360.0 - 180.0)
        k = prof.smoothstep(0.0, run_deg, min(d_lo, d_hi))
        return (
            end[0] + (h - end[0]) * k,
            end[1] + (t - end[1]) * k,
            off * k,
        )
    return wrapped


def build_sweep(name, coll, material, frames, dims_fn, segments=48, cap=True):
    """Sweep a varying cross-section along a run of frames."""
    if len(frames) < 2:
        raise ValueError(f"{name}: need at least two frames, got {len(frames)}")

    bm = bmesh.new()
    rings = []
    for origin, outward, up, bearing in frames:
        h, t, voff = dims_fn(math.degrees(bearing))
        loop = prof.section_loop(h, t, segments)
        rings.append([
            bm.verts.new(origin + outward * (u * MM) + up * ((v + voff) * MM))
            for (u, v) in loop
        ])
    bm.verts.ensure_lookup_table()

    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        for k in range(segments):
            k2 = (k + 1) % segments
            bm.faces.new((a[k], a[k2], b[k2], b[k]))

    if cap:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])

    bm.normal_update()
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(material)

    obj = bpy.data.objects.new(name, mesh)
    coll.objects.link(obj)
    shade_smooth(obj)
    return obj


# ---------------------------------------------------------------- features

def _frame_at(frames, bearing_deg):
    """Nearest frame to a bearing."""
    return min(frames, key=lambda f: abs(
        (math.degrees(f[3]) - bearing_deg + 180.0) % 360.0 - 180.0))


def _orient(outward, up):
    right = up.cross(outward).normalized()
    return Matrix((right, up, outward)).transposed().to_4x4()


def add_panel(name, coll, material, frame, size_mm, dims_fn, depth_mm=1.2,
              pitch_deg=0.0, inset_mm=0.4, corner=0.35):
    """
    A flush window panel on the shell surface.

    Sunk slightly into the shell rather than boolean-cut: a boolean through a
    swept, smooth-shaded tube produces ragged n-gons exactly where the eye is
    drawn, and the visual result — a dark inset panel — is identical.
    """
    origin, outward, up, bearing = frame
    _, t, voff = dims_fn(math.degrees(bearing))
    w, hgt = size_mm

    bpy.ops.mesh.primitive_cube_add(size=1.0)
    obj = bpy.context.active_object
    obj.name = name
    bpy.context.collection.objects.unlink(obj)
    coll.objects.link(obj)

    # Round the panel's edges so it does not read as a sticker.
    bev = obj.modifiers.new("Bevel", "BEVEL")
    bev.width = corner * MM
    bev.segments = 3
    bev.limit_method = "ANGLE"

    rot = _orient(outward, up)
    if pitch_deg:
        rot = rot @ Matrix.Rotation(math.radians(pitch_deg), 4, "X")

    surface = origin + outward * ((t - inset_mm) * MM) + up * (voff * MM)
    obj.matrix_world = (
        Matrix.Translation(surface)
        @ rot
        @ Matrix.Diagonal(Vector((w, hgt, depth_mm)) * MM).to_4x4()
    )
    obj.data.materials.append(material)
    shade_smooth(obj, 30.0)
    return obj


def add_accent_ring(name, coll, material, frame, dia_mm, dims_fn, depth_mm=1.4):
    """Anodised ring around each transducer — the one accent in the design."""
    origin, outward, up, bearing = frame
    _, t, voff = dims_fn(math.degrees(bearing))

    bpy.ops.mesh.primitive_torus_add(
        major_radius=dia_mm * 0.5 * MM,
        minor_radius=0.9 * MM,
        major_segments=64,
        minor_segments=12,
    )
    obj = bpy.context.active_object
    obj.name = name
    bpy.context.collection.objects.unlink(obj)
    coll.objects.link(obj)

    # The torus lies in XY with its axis on +Z, which _orient maps to `outward`.
    obj.matrix_world = (
        Matrix.Translation(origin + outward * ((t - depth_mm * 0.4) * MM)
                           + up * (voff * MM))
        @ _orient(outward, up)
    )
    obj.data.materials.append(material)
    shade_smooth(obj)
    return obj


# ---------------------------------------------------------------- measurement

def measure_fit(head, frames, arc_lo, arc_hi):
    """
    Fit, measured rather than eyeballed.

    Reports the shell's inner face against the head along the rigid arc. A
    negative minimum means the shell is inside the skull; a large maximum means
    it is floating off it. Both are invisible in a render at this scale and both
    make the model a lie.
    """
    gaps = []
    for f in _arc_slice(frames, arc_lo, arc_hi):
        origin, outward, _, bearing = f
        hit = head.surface(bearing, origin.z)
        if hit is None:
            continue
        gaps.append((origin - hit[0]).length / MM)
    return min(gaps), max(gaps), sum(gaps) / len(gaps)


def mass_budget():
    items = [
        ("Shell (PC)", 1, MASSES["shell"]),
        ("Liner (TPE)", 1, MASSES["liner"]),
        ("Rear strap", 1, MASSES["strap"]),
        ("ToF modules", len(prof.TOF_BEARINGS) + 1, MASSES["tof"]),
        ("IMU", 1, MASSES["imu"]),
        ("Bone transducers", 2, MASSES["transducer"]),
        ("LRA motors", 4, MASSES["lra"]),
        ("MCU module", 1, MASSES["mcu"]),
        ("PCBs", 2, MASSES["pcb"]),
        ("Cells (500 mAh)", 2, MASSES["cell"]),
    ]
    return items, sum(n * m for _, n, m in items)


# ---------------------------------------------------------------- build

def build(show_head=True, target_circumference=head_mod.TARGET_CIRCUMFERENCE):
    setup_units()
    clear_scene()

    root = collection("VisionBand")
    c_shell = collection("VisionBand.Shell", root)
    c_soft = collection("VisionBand.Soft", root)
    c_detail = collection("VisionBand.Detail", root)
    c_ref = collection("VisionBand.Reference", root)

    mats = materials_mod.all_materials()

    head = head_mod.load(target_circumference=target_circumference)
    bpy.context.scene.collection.objects.unlink(head.obj)
    c_ref.objects.link(head.obj)
    head.obj.data.materials.clear()
    head.obj.data.materials.append(mats["skin"])
    head.obj.hide_render = not show_head
    head.obj.hide_viewport = not show_head

    ring = head.band_ring(n=288, tilt_deg=10.0)
    shell_frames = _frames(ring, prof.liner_gap)
    liner_frames = _frames(ring, 0.2)

    arc_lo, arc_hi = -prof.ARC_HALF_SPAN, prof.ARC_HALF_SPAN
    rear_lo = 180.0 - prof.REAR_POD_HALF_SPAN
    rear_hi = 180.0 + prof.REAR_POD_HALF_SPAN

    # --- rigid front arc
    arc = _arc_slice(shell_frames, arc_lo, arc_hi)
    shell_dims = tapered(prof.shell_dims, arc_lo, arc_hi)
    build_sweep("VB_Shell", c_shell, mats["shell"], arc, shell_dims)
    build_sweep("VB_Liner", c_soft, mats["liner"],
                _arc_slice(liner_frames, arc_lo + 1, arc_hi - 1),
                tapered(prof.liner_dims, arc_lo + 1, arc_hi - 1,
                        end_dims=(prof.STRAP_HEIGHT - 3.0, 1.4, 0.0)))

    # --- rear pod at the occiput
    rear = _arc_slice(shell_frames, rear_lo, rear_hi)
    rear_dims = tapered(prof.rear_pod_dims, rear_lo, rear_hi, run_deg=13.0)
    build_sweep("VB_RearPod", c_shell, mats["shell"], rear, rear_dims)

    # --- soft strap, one segment each side, bridging arc to rear pod
    g = prof.STRAP_GAP_DEG
    for side, (lo, hi) in (
        ("R", (arc_hi - g, rear_lo + g)),
        ("L", (rear_hi - g, 360.0 + arc_lo + g)),
    ):
        seg = _arc_slice(shell_frames, lo, hi)
        build_sweep(f"VB_Strap_{side}", c_soft, mats["strap"], seg, prof.strap_dims)

    # --- ToF windows, one per bearing; the front one also carries the
    #     down-pitched ground sensor that makes drop-offs visible (F6).
    for bearing in prof.TOF_BEARINGS:
        on_rear = abs(abs(bearing) - 180.0) < prof.REAR_POD_HALF_SPAN
        pool, dims = (rear, rear_dims) if on_rear else (arc, shell_dims)
        add_panel(f"VB_ToF_{int(bearing):+04d}", c_detail, mats["window"],
                  _frame_at(pool, bearing), PARTS["tof_window"], dims)

    ground = _frame_at(arc, 0.0)
    add_panel("VB_ToF_ground", c_detail, mats["window"], ground,
              (PARTS["tof_window"][0], 7.0), shell_dims,
              pitch_deg=GROUND_SENSOR_PITCH, inset_mm=2.2)

    # --- transducers and their accent rings
    for bearing in prof.TRANSDUCER_BEARINGS:
        frame = _frame_at(arc, bearing)
        add_accent_ring(f"VB_Accent_{int(bearing):+04d}", c_detail,
                        mats["accent"], frame, PARTS["transducer_dia"] + 3.0,
                        shell_dims)

    report(head, shell_frames, arc_lo, arc_hi, arc)
    return head


def report(head, frames, arc_lo, arc_hi, arc):
    head.report()

    print("\n--- profile ---")
    print(prof.summary())

    lo, hi, avg = measure_fit(head, frames, arc_lo + 2, arc_hi - 2)
    print("\n--- fit ---")
    print(f"  shell inner face to head:  min {lo:.1f}  mean {avg:.1f}  max {hi:.1f} mm")
    ok = lo >= -0.01 and hi <= 6.0
    print(f"  {'OK' if ok else 'FAIL'} — must be ≥0 (no interpenetration) and ≤6 mm (not floating)")

    # Interference, signed by the head's surface normal — the only test that can
    # tell a pod resting *on* the pinna from one tucked *behind* it.
    #
    # Rigid and compliant parts are judged differently on purpose. The shell must
    # never touch. The liner is *supposed* to: one floating 3 mm off the skin
    # does nothing, so a small contact depth there is the design working, not a
    # fault.
    def _points(prefixes):
        return [o.matrix_world @ v.co
                for o in bpy.data.objects if o.name.startswith(prefixes)
                for v in o.data.vertices]

    def _describe(where):
        if where is None:
            return ""
        return (f" (at {math.degrees(math.atan2(where.x, where.y)):+.0f}°, "
                f"z {where.z / MM:+.0f} mm)")

    worst, where = head.interference(_points(("VB_Shell", "VB_RearPod")))
    verdict = "OK" if worst is not None and worst >= -0.05 else "FAIL — shell is inside the head"
    print(f"  rigid shell closest approach: {worst:+.1f} mm{_describe(where)}  {verdict}")

    lworst, lwhere = head.interference(_points(("VB_Liner",)))
    if lworst is not None:
        comp = max(0.0, -lworst)
        ok = comp <= 1.5
        print(f"  liner contact depth: {comp:.1f} mm{_describe(lwhere)}  "
              f"{'OK' if ok else 'FAIL — liner compresses too hard'} "
              f"(expected 0–1.5 mm)")

    ear_z = head.ear_top_z()
    if ear_z is not None:
        print(f"  ear top at z {ear_z / MM:+.0f} mm; band at 117° sits at "
              f"z {_frame_at(arc, 117.0)[0].z / MM:+.0f} mm")

    gap = max(0.0, 360.0 / len(prof.TOF_BEARINGS) - 63.0 * (1 - 1 / 8))
    print(f"  widest blind gap {gap:.0f}°  {'OK' if gap <= 15 else 'FAIL'} (F3 allows ≤15°)")

    items, total = mass_budget()
    print("\n--- mass ---")
    for name, n, m in items:
        print(f"  {name:<20} {n:>2} × {m:>5.1f} g = {n * m:>6.1f} g")
    print(f"  {'TOTAL':<20} {'':>2}   {'':>5}   {total:>6.1f} g  "
          f"{'OK' if total <= 200 else 'FAIL'} (N3 allows ≤200 g)")
    print()


if __name__ == "__main__":
    build()
