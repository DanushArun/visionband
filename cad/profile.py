"""
The cross-section vocabulary — the part that decides whether this reads as a
product or as boxes glued to a hoop.

The band is one swept surface whose section *grows* where something has to fit
inside it and returns to its base profile between. Nothing is attached; the form
contains. That is also the pragmatic choice: boolean-union-then-fillet between a
sweep and a box is fragile in Blender and produces the pinched, lumpy junctions
that make a model look amateur.

All dimensions in millimetres, all bearings in degrees clockwise from straight
ahead (+Y) viewed from above — the same convention as the sonification encoder.
"""

import math

# ---------------------------------------------------------------- layout
#
# Bearings are constrained by anatomy and by requirement F3, not chosen freely:
#
#   ±60°   ToF. Even 60° spacing is what gives ≤15° blind gaps with six sensors.
#   ±78°   Temples. Bone-conduction transducers sit in front of the ear, on the
#          temporal bone. Two of them, never eight — see ADR 0001.
#   ±117°  Behind the ear. The only place with room for a battery that does not
#          put mass in front of the face, and it balances about the head's axis.
#   180°   Occiput. A rear-facing ToF cannot live on the front arc: aimed
#          backward from a temple it looks straight into the wearer's own head.

ARC_HALF_SPAN = 125.0      # rigid front arc, ±125° → 250° of shell
REAR_POD_HALF_SPAN = 20.0  # small rigid module at the occiput, carried by the strap
STRAP_GAP_DEG = 4.0        # visual break where shell meets strap

# ±117 rather than ±120: the sensor rides the behind-ear pod, where there is a
# rigid mount and full section, instead of the tapered arc tip. The 3° shift
# costs nothing — the blind gap stays at 5°, well inside F3's 15°.
TOF_BEARINGS = (0.0, -60.0, 60.0, -117.0, 117.0, 180.0)
TRANSDUCER_BEARINGS = (-78.0, 78.0)
POD_BEARINGS = (-117.0, 117.0)

BASE_HEIGHT = 18.0
BASE_THICKNESS = 9.0

# (centre bearing, half-width of the swelling, height, thickness, vertical bias)
#
# The vertical bias is load-bearing, not styling. A pod centred on the band plane
# grows equally up and down; behind the ear, downward is where the ear is. The
# +4 mm bias on the pods makes them swell upward and away from it, which is both
# the only way they clear and the reason they read as growing out of the band
# rather than hanging off it.
FEATURES = [
    (0.0, 10.0, 23.0, 15.0, 0.0),     # front ToF + the down-pitched ground sensor
    (-60.0, 9.0, 21.0, 13.5, 0.0),
    (60.0, 9.0, 21.0, 13.5, 0.0),
    (-78.0, 11.0, 26.0, 16.0, 1.5),   # transducer, lifted clear of the temple
    (78.0, 11.0, 26.0, 16.0, 1.5),
    (-117.0, 17.0, 28.0, 19.0, 4.0),  # behind-ear pod: cell + PCB + the ±120 ToF
    (117.0, 17.0, 28.0, 19.0, 4.0),
]

REAR_POD_FEATURE = (180.0, 20.0, 23.0, 15.0, 0.0)

STRAP_HEIGHT = 22.0
STRAP_THICKNESS = 3.0

LINER_GAP = 3.0        # compressed foam between skin and shell
LINER_REAR_EXTRA = 2.5
LINER_THICKNESS = 2.6
LINER_OVERHANG = 3.0   # liner wider than the shell, so no hard edge meets skin


def smoothstep(edge0, edge1, x):
    t = max(0.0, min(1.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)


def _angular_delta(a, b):
    """Shortest signed difference between two bearings, in degrees."""
    return (a - b + 180.0) % 360.0 - 180.0


def _blend(bearing, features, base_h, base_t):
    """
    Take the strongest feature rather than summing them.

    Summing overlapping swellings — the transducer at 78° and the pod at 117°
    nearly touch — would pile their thicknesses on top of each other and bulge
    the band between them. Max keeps each feature at its intended size and lets
    the larger one absorb the smaller.
    """
    h, t, off = base_h, base_t, 0.0
    for centre, half, fh, ft, fo in features:
        d = abs(_angular_delta(bearing, centre))
        # 1 at the centre, 0 by half-width + a soft tail either side.
        w = 1.0 - smoothstep(half * 0.55, half + 9.0, d)
        h = max(h, base_h + (fh - base_h) * w)
        t = max(t, base_t + (ft - base_t) * w)
        off = max(off, fo * w) if fo >= 0 else min(off, fo * w)
    return h, t, off


def shell_dims(bearing):
    """→ (height, thickness, vertical bias) in mm."""
    return _blend(bearing, FEATURES, BASE_HEIGHT, BASE_THICKNESS)


def rear_pod_dims(bearing):
    return _blend(bearing, [REAR_POD_FEATURE], BASE_HEIGHT * 0.85, BASE_THICKNESS * 0.8)


def liner_dims(bearing):
    """Follows the shell's height but stays thin and slightly wider."""
    h, _, off = shell_dims(bearing)
    return h + LINER_OVERHANG, LINER_THICKNESS, off


def strap_dims(_bearing):
    return STRAP_HEIGHT, STRAP_THICKNESS, 0.0


def liner_gap(bearing):
    """
    Standoff from skin to shell, as a function of bearing.

    Not constant. The skull curves away below the band faster at the occiput than
    anywhere else, so a rigid section that clears at the front presses in at the
    back — measured as a 0.5 mm breach at 180°, z −26 mm. Thickening the pad
    there is also simply what headbands do: the occiput is where they all carry
    their deepest padding, because it is where the load bears.
    """
    d = abs(_angular_delta(bearing, 180.0))
    return LINER_GAP + LINER_REAR_EXTRA * (1.0 - smoothstep(25.0, 70.0, d))


def section_point(angle, height, thickness, inner_exp=6.0, outer_exp=2.7):
    """
    One point on the cross-section, as (outward, up) offsets from the inner face.

    A superellipse whose exponent is interpolated around the loop: flat-ish
    against the head so it beds down on the skull, generously rounded outside so
    the form has no visible edge anywhere a finger lands. Interpolating the
    exponent rather than switching it at the midline keeps the section tangent-
    continuous, which is what stops a swept surface from showing a seam.
    """
    c = math.cos(angle)
    s = math.sin(angle)
    exp = inner_exp + (outer_exp - inner_exp) * (0.5 + 0.5 * c)
    p = 2.0 / exp

    u = math.copysign(abs(c) ** p, c)
    v = math.copysign(abs(s) ** p, s)
    return (thickness * 0.5) * (1.0 + u), (height * 0.5) * v


def section_loop(height, thickness, segments=48, **kw):
    return [section_point((i / segments) * math.tau, height, thickness, **kw)
            for i in range(segments)]


def summary():
    lines = [
        f"  arc            ±{ARC_HALF_SPAN:.0f}°  ({2 * ARC_HALF_SPAN:.0f}° of rigid shell)",
        f"  rear pod       ±{REAR_POD_HALF_SPAN:.0f}° about 180°",
        f"  base section   {BASE_HEIGHT:.0f} × {BASE_THICKNESS:.0f} mm",
    ]
    for centre, half, h, t, off in FEATURES + [REAR_POD_FEATURE]:
        bias = f"  bias {off:+.0f}" if off else ""
        lines.append(f"  {centre:+7.0f}°  ±{half:>4.0f}°   {h:.0f} × {t:.0f} mm{bias}")
    return "\n".join(lines)
