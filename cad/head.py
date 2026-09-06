"""
The head the band is designed around.

Blender Studio's Human Base Meshes bundle, CC0. Run cad/fetch_head.py once to
download it into cad/assets/.

Measured facts about `GEO-head_sculpting_realistic`, established by probing the
mesh rather than assumed:

    80–100 mm below the crown   circumference 557 mm, width 155, depth 194
    120 mm below the crown      circumference jumps to 600 mm — the ears begin
    140 mm below the crown      622 mm, width 174 — ears at full width

So the band seats around 90 mm below the crown, where the head is a textbook
56 cm adult, and it clears the ears by roughly 30 mm. The behind-ear pods are
the one part of the design that can foul anatomy, which is why `ear_clearance()`
exists and gets reported on every build.

The bundle is modelled at true metric scale (the male body measures 1690 mm), so
no guessing at units.
"""

import math
import os

import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

MM = 0.001
HERE = os.path.dirname(os.path.abspath(__file__))
BUNDLE = os.path.join(HERE, "assets", "human_base_meshes_bundle.blend")

HEAD_OBJECT = "GEO-head_sculpting_realistic"
TARGET_CIRCUMFERENCE = 560.0  # mm — mid of requirement N7's 540–600 range
BAND_DROP = 90.0              # mm below crown where the band seats
EAR_DROP = 130.0              # mm below crown, top of the ear


def append_head(name=HEAD_OBJECT, bundle=BUNDLE):
    """
    Append the head mesh, failing loudly with the available names.

    Never hardcode-and-hope: the bundle holds 407 objects and a silently wrong
    name would leave an empty scene that still renders.
    """
    if not os.path.exists(bundle):
        raise FileNotFoundError(
            f"{bundle} not found — run `python3 cad/fetch_head.py` first"
        )

    with bpy.data.libraries.load(bundle, link=False) as (src, dst):
        if name not in src.objects:
            heads = sorted(o for o in src.objects if "head" in o.lower())
            raise KeyError(f"{name!r} not in bundle. Head-like objects: {heads}")
        dst.objects = [name]

    obj = dst.objects[0]
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _apply_transforms(obj):
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.select_set(False)


def _perimeter(points):
    return sum((points[i] - points[(i + 1) % len(points)]).length
               for i in range(len(points)))


class HeadModel:
    """
    A head, normalised: nose along +Y, crown up +Z, origin at the centre of the
    band ring, scaled so the band-height circumference hits TARGET_CIRCUMFERENCE.

    Everything downstream measures against this frame, so the band path is
    derived from real anatomy instead of an idealised ellipse.
    """

    def __init__(self, obj=None, target_circumference=TARGET_CIRCUMFERENCE,
                 subdivide=2):
        self.obj = obj or append_head()
        self.obj.name = "HeadReference"
        _apply_transforms(self.obj)

        # The asset is a 3,307-vertex sculpting base, meant to be driven by
        # Multiresolution. Raw, it is visibly faceted and its normals step from
        # facet to facet — which both looks wrong in a render and makes the band
        # path jitter, since every ray hits a flat plane at a slightly different
        # angle. Subdividing before the BVH is built means measurements and
        # renders use the same smooth surface.
        if subdivide:
            mod = self.obj.modifiers.new("Subdivision", "SUBSURF")
            mod.levels = mod.render_levels = subdivide

        self._rebuild()

        self._orient_forward()
        self._normalise_scale(target_circumference)
        self._recentre()

        self.circumference = _perimeter(self._ring_points(0.0)) / MM

    # ---------------------------------------------------------------- setup

    def _rebuild(self):
        """BVH over the evaluated mesh, so any modifiers on the asset count."""
        dg = bpy.context.evaluated_depsgraph_get()
        self.bvh = BVHTree.FromObject(self.obj, dg)
        # Statistics come off the *evaluated* mesh so they agree with the BVH —
        # subdivision pulls the surface in by around a millimetre, and reading
        # the base cage instead would put the crown and the centroid elsewhere.
        ev = self.obj.evaluated_get(dg)
        me = ev.to_mesh()
        co = [v.co.copy() for v in me.vertices]
        ev.to_mesh_clear()
        self.crown_z = max(v.z for v in co)
        self.base_z = min(v.z for v in co)
        self.band_z = self.crown_z - BAND_DROP * MM
        # The asset is authored well away from the origin (x ≈ 1.79 m), so ray
        # casts have to be seeded from the mesh itself, not from (0, 0).
        self.centroid = Vector((
            sum(v.x for v in co) / len(co),
            sum(v.y for v in co) / len(co),
            0.0,
        ))

    def _ring_points(self, tilt_deg, n=180, drop=None, seed_z=None):
        """
        Horizontal (or tilted) ring of surface points at band height.

        Two passes: the first finds the slice centroid, the second re-casts from
        it. Casting from a guessed centre biases every radius on an asymmetric
        shape like a head.
        """
        z0 = seed_z if seed_z is not None else (
            self.crown_z - (drop if drop is not None else BAND_DROP) * MM)
        slope = math.tan(math.radians(tilt_deg))

        centre = Vector((self.centroid.x, self.centroid.y, z0))
        pts = []
        for _ in range(2):
            pts = []
            for i in range(n):
                a = (i / n) * math.tau
                d = Vector((math.sin(a), math.cos(a), 0.0))
                # A tilted band is not a horizontal slice: its height depends on
                # how far forward the point is. A few iterations settle it.
                hit = (None,)
                z = z0
                for _ in range(3):
                    origin = Vector((centre.x, centre.y, z))
                    hit = self.bvh.ray_cast(origin - d * 0.6, d, 1.2)
                    if hit[0] is None:
                        break
                    z = z0 + slope * (hit[0].y - centre.y)
                if hit[0] is not None:
                    pts.append(hit[0])
            if not pts:
                raise RuntimeError(
                    f"no surface found at z={z0 / MM:.0f} mm "
                    f"(seed {centre.x:.2f}, {centre.y:.2f})"
                )
            centre = sum(pts, Vector()) / len(pts)
        return pts

    def _orient_forward(self):
        """
        Rotate so the nose points +Y.

        Detected, not assumed: at nose height the face is the single furthest
        point from the vertical axis, so the bearing of maximum radius is the
        forward direction.
        """
        pts = self._ring_points(0.0, n=180, drop=115.0)
        centre = sum(pts, Vector()) / len(pts)
        best = max(pts, key=lambda p: (p - centre).xy.length)
        bearing = math.atan2(best.x - centre.x, best.y - centre.y)

        self.obj.rotation_euler = (0.0, 0.0, -bearing)
        _apply_transforms(self.obj)
        self._rebuild()

    def _normalise_scale(self, target_mm):
        measured = _perimeter(self._ring_points(0.0)) / MM
        factor = target_mm / measured
        self.scale_factor = factor
        self.measured_circumference = measured
        self.obj.scale = (factor, factor, factor)
        _apply_transforms(self.obj)
        self._rebuild()

    def _recentre(self):
        pts = self._ring_points(0.0)
        centre = sum(pts, Vector()) / len(pts)
        self.obj.location = (-centre.x, -centre.y, -centre.z)
        _apply_transforms(self.obj)
        self._rebuild()
        self.band_z = 0.0

    # ---------------------------------------------------------------- queries

    def surface(self, bearing, z):
        """
        Cast inward from outside the head toward the axis at `bearing`.
        Returns (point, normal) or None. Bearing 0 is forward (+Y), clockwise
        from above — the same convention the sonification encoder uses.
        """
        d = Vector((math.sin(bearing), math.cos(bearing), 0.0))
        origin = Vector((self.centroid.x, self.centroid.y, z)) + d * 0.6
        hit = self.bvh.ray_cast(origin, -d, 1.2)
        if hit[0] is None:
            return None
        return hit[0], hit[1]

    @staticmethod
    def _smooth_closed(values, sigma_samples):
        """
        Circular Gaussian blur over a closed loop.

        A band is a stiff object; it bridges local detail rather than tracing it.
        Following the raw raycast hits reproduces every brow-ridge bump and
        facet-normal step in the mesh, which shows up as a rippling shell and a
        ragged liner silhouette. Smoothing the path keeps the skull's overall
        curve and drops the noise the band would physically span.
        """
        if sigma_samples <= 0:
            return list(values)
        radius = max(1, int(sigma_samples * 3))
        weights = [math.exp(-0.5 * (i / sigma_samples) ** 2)
                   for i in range(-radius, radius + 1)]
        total = sum(weights)
        n = len(values)
        out = []
        for i in range(n):
            acc = values[0] * 0.0
            for k, w in enumerate(weights):
                acc = acc + values[(i + k - radius) % n] * w
            out.append(acc / total)
        return out

    def band_ring(self, n=256, tilt_deg=10.0, drop=BAND_DROP, smooth_deg=7.0):
        """
        The seating path: one (point, normal) per bearing, on a plane tilted
        nose-up so the band rides above the brow at the front and tucks under the
        occipital bulge at the back — where a headband actually sits.
        """
        z0 = self.crown_z - drop * MM
        slope = math.tan(math.radians(tilt_deg))
        ring = []
        for i in range(n):
            bearing = (i / n) * math.tau
            d = Vector((math.sin(bearing), math.cos(bearing), 0.0))
            z = z0
            hit = (None,)
            for _ in range(4):
                origin = Vector((self.centroid.x, self.centroid.y, z)) + d * 0.6
                hit = self.bvh.ray_cast(origin, -d, 1.2)
                if hit[0] is None:
                    break
                z = z0 + slope * hit[0].y
            if hit is None or hit[0] is None:
                raise RuntimeError(f"no surface at bearing {math.degrees(bearing):.0f}°")
            ring.append((hit[0].copy(), hit[1].copy(), bearing))

        sigma = (smooth_deg / 360.0) * n
        points = self._smooth_closed([p for p, _, _ in ring], sigma)
        normals = [nm.normalized() for nm in
                   self._smooth_closed([nm for _, nm, _ in ring], sigma)]

        # Smoothing averages, so the path now cuts through every high spot it
        # used to trace — the brow ridge and the occiput. A stiff band does the
        # opposite: it rides *on* the peaks and bridges the hollows between. So
        # push any sample that ended up inside the skull back out to the surface,
        # then re-smooth gently to take the corners off. Two passes converge.
        for _ in range(2):
            lifted = []
            for p, nm in zip(points, normals):
                sd = self.signed_distance(p)
                lifted.append(p - nm * sd if sd is not None and sd < 0 else p)
            points = self._smooth_closed(lifted, sigma * 0.5)

        return [(points[i], normals[i], ring[i][2]) for i in range(len(ring))]

    def circumference_at(self, drop_mm):
        return _perimeter(self._ring_points(0.0, drop=drop_mm)) / MM

    def half_width_at(self, drop_mm):
        """Half the ear-to-ear width at a given depth below the crown."""
        pts = self._ring_points(0.0, drop=drop_mm)
        return max(abs(p.x) for p in pts) / MM

    def ear_top_z(self, threshold_mm=6.0):
        """
        Height of the top of the ear, found by scanning.

        Not by circumference: the cranium widens steadily as you descend, so
        circumference grows ~18 mm in the first 5 mm below the band with no ear
        involved, and a circumference test fires immediately. The ear's actual
        signature is a jump in *width* — 154 mm at 100 mm below the crown, 179 mm
        at 120 mm — against a cranium whose width is flat through that range.
        """
        base = min(self.half_width_at(float(d)) for d in (70, 80, 90))
        for drop in range(95, 185, 5):
            if self.half_width_at(float(drop)) - base > threshold_mm:
                return self.crown_z - drop * MM
        return None

    def signed_distance(self, point):
        """
        Distance from a point to the head surface: positive outside, negative in.

        Sign comes from the surface normal at the nearest point, which is what
        makes this work on a shape as concave as an ear — a purely vertical
        "is the pod below the ear top" test cannot tell the difference between a
        pod resting *on* the pinna and one tucked *behind* it, and those are
        opposite outcomes.
        """
        loc, nrm, _, _ = self.bvh.find_nearest(point, 0.5)
        if loc is None:
            return None
        d = (point - loc).length
        return d if (point - loc).dot(nrm) >= 0 else -d

    def interference(self, points):
        """
        Worst penetration into the head over a set of points, in mm.
        Positive means clear; negative means the part is inside the wearer.
        """
        worst = None
        where = None
        for p in points:
            sd = self.signed_distance(p)
            if sd is None:
                continue
            if worst is None or sd < worst:
                worst = sd
                where = p
        return (None, None) if worst is None else (worst / MM, where)

    # ---------------------------------------------------------------- report

    def report(self):
        print("\n--- head ---")
        print(f"  source            {HEAD_OBJECT} (CC0, Blender Studio)")
        print(f"  as modelled       {self.measured_circumference:.0f} mm circumference")
        print(f"  scaled ×{self.scale_factor:.4f} → {self.circumference:.0f} mm "
              f"(target {TARGET_CIRCUMFERENCE:.0f})")
        for drop in (60, 90, 120, 150):
            print(f"  {drop:>3} mm below crown  {self.circumference_at(float(drop)):.0f} mm")
        print(f"  crown at z = {self.crown_z / MM:.0f} mm above the band plane")


def load(target_circumference=TARGET_CIRCUMFERENCE):
    return HeadModel(target_circumference=target_circumference)


if __name__ == "__main__":
    head = load()
    head.report()
