"""Build the race car used by the website's onboard view and export it as glTF.

An original, generic modern open-wheel race car (no real team's design or livery).
Run headless:

    blender --background --factory-startup --python tools/blender/build_car.py -- <repo root>

Outputs docs/models/car.glb and tools/blender/preview.png.

Conventions (so the web page can recolour and animate it):
  * materials named Livery, Accent, Carbon, Helmet, Tyre, TyreMark, Rim
  * wheels are separate objects Wheel_FL, Wheel_FR, Wheel_RL, Wheel_RR with their origin at the hub
  * Blender +Y is the front of the car, +Z up; the exporter converts to glTF's +Y up (front = -Z)
"""
import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector

ROOT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else os.getcwd()
OUT_GLB = os.path.join(ROOT, "docs", "models", "car.glb")
OUT_PNG = os.path.join(ROOT, "tools", "blender", "preview.png")

# ------------------------------------------------------------------ scene + materials
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def material(name, rgb, metallic=0.0, rough=0.5):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    m.diffuse_color = (*rgb, 1)
    return m


M = {
    "Livery": material("Livery", (0.05, 0.25, 0.75), 0.2, 0.35),
    "Accent": material("Accent", (0.95, 0.95, 0.95), 0.1, 0.4),
    "Carbon": material("Carbon", (0.025, 0.025, 0.028), 0.3, 0.45),
    "Helmet": material("Helmet", (0.95, 0.85, 0.1), 0.1, 0.3),
    "Tyre": material("Tyre", (0.03, 0.03, 0.03), 0.0, 0.85),
    "TyreMark": material("TyreMark", (0.9, 0.1, 0.1), 0.0, 0.6),
    "Rim": material("Rim", (0.12, 0.12, 0.13), 0.8, 0.35),
}


def obj_from_bmesh(name, bm, mats, smooth=False, subsurf=0):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(M[m])
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    if subsurf:
        mod = ob.modifiers.new("sub", "SUBSURF")
        mod.levels = subsurf
        mod.render_levels = subsurf
    return ob


def ring(xc, zc, w, h, r, n=24):
    """Rounded-rectangle cross-section in the XZ plane, counter-clockwise."""
    r = min(r, w / 2 - 1e-3, h / 2 - 1e-3)
    pts = []
    corners = [(xc + w / 2 - r, zc + h / 2 - r, 0), (xc - w / 2 + r, zc + h / 2 - r, 90),
               (xc - w / 2 + r, zc - h / 2 + r, 180), (xc + w / 2 - r, zc - h / 2 + r, 270)]
    per = n // 4
    for cx, cz, a0 in corners:
        for k in range(per):
            a = math.radians(a0 + 90 * k / (per - 1))
            pts.append((cx + r * math.cos(a), cz + r * math.sin(a)))
    return pts


def loft(name, sections, mats=("Livery",), subsurf=1):
    """sections: list of (y, xc, zc, w, h, r). Builds a closed tube with end caps."""
    bm = bmesh.new()
    rings = []
    for y, xc, zc, w, h, r in sections:
        rings.append([bm.verts.new((x, y, z)) for x, z in ring(xc, zc, w, h, r)])
    n = len(rings[0])
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bmesh(name, bm, mats, smooth=True, subsurf=subsurf)


def box(name, x0, x1, y0, y1, z0, z1, mat="Carbon", tilt=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x = x0 + (v.co.x + 0.5) * (x1 - x0)
        v.co.y = y0 + (v.co.y + 0.5) * (y1 - y0)
        v.co.z = z0 + (v.co.z + 0.5) * (z1 - z0)
    if tilt:
        cy, cz = (y0 + y1) / 2, (z0 + z1) / 2
        for v in bm.verts:
            dy, dz = v.co.y - cy, v.co.z - cz
            v.co.y = cy + dy * math.cos(tilt) - dz * math.sin(tilt)
            v.co.z = cz + dy * math.sin(tilt) + dz * math.cos(tilt)
    return obj_from_bmesh(name, bm, [mat])


def tube(name, path, radius, mat="Carbon", n=10):
    """Sweep a circle along a polyline (list of 3D points)."""
    bm = bmesh.new()
    path = [Vector(p) for p in path]
    rings = []
    for i, p in enumerate(path):
        t = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        up = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
        u = t.cross(up).normalized()
        v = t.cross(u).normalized()
        rings.append([bm.verts.new(p + radius * (math.cos(2 * math.pi * k / n) * u + math.sin(2 * math.pi * k / n) * v))
                      for k in range(n)])
    for a, b in zip(rings, rings[1:]):
        for k in range(n):
            bm.faces.new((a[k], a[(k + 1) % n], b[(k + 1) % n], b[k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bmesh(name, bm, [mat], smooth=True)


def bezier(p0, p1, p2, steps=12):
    return [tuple((1 - t) ** 2 * a + 2 * (1 - t) * t * b + t ** 2 * c for a, b, c in zip(p0, p1, p2))
            for t in [i / steps for i in range(steps + 1)]]


def wheel(name, x, y, r, width):
    """Tyre with coloured compound band and rim, origin at the hub, axle along X."""
    bm = bmesh.new()
    parts = [(r, width, 0), (r * 0.84, width + 0.006, 1), (r * 0.66, width + 0.012, 2)]
    for rad, wdt, mat_idx in parts:
        geom = bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=40,
                                     radius1=rad, radius2=rad, depth=wdt)
        for v in geom["verts"]:
            v.co = Vector((v.co.z, v.co.x, v.co.y))   # axis Z -> X
        for f in {f for v in geom["verts"] for f in v.link_faces}:
            f.material_index = mat_idx
    ob = obj_from_bmesh(name, bm, ["Tyre", "TyreMark", "Rim"], smooth=False)
    for p in ob.data.polygons:   # smooth the tread, keep sidewalls flat
        p.use_smooth = abs(p.normal.x) < 0.5
    ob.location = (x, y, r)
    return ob


# ------------------------------------------------------------------ body
body = loft("Body", [
    # y,    xc,  zc,   w,    h,    r
    (2.78, 0, 0.20, 0.16, 0.10, 0.04),
    (2.40, 0, 0.23, 0.26, 0.17, 0.07),
    (1.85, 0, 0.29, 0.36, 0.25, 0.10),
    (1.25, 0, 0.35, 0.50, 0.36, 0.14),
    (0.75, 0, 0.41, 0.62, 0.47, 0.18),
    (0.25, 0, 0.43, 0.72, 0.55, 0.20),
    (-0.30, 0, 0.45, 0.78, 0.60, 0.22),
    (-0.62, 0, 0.56, 0.56, 0.82, 0.20),
    (-0.95, 0, 0.50, 0.50, 0.68, 0.18),
    (-1.45, 0, 0.43, 0.44, 0.52, 0.15),
    (-2.05, 0, 0.37, 0.32, 0.38, 0.11),
    (-2.55, 0, 0.32, 0.18, 0.22, 0.07),
])
for side in (-1, 1):
    loft(f"Sidepod_{'L' if side < 0 else 'R'}", [
        (0.42, side * 0.60, 0.35, 0.30, 0.34, 0.06),
        (0.10, side * 0.62, 0.33, 0.40, 0.36, 0.08),
        (-0.70, side * 0.56, 0.29, 0.34, 0.28, 0.08),
        (-1.55, side * 0.40, 0.25, 0.14, 0.18, 0.06),
    ])
    # sidepod inlet (dark mouth)
    box(f"Inlet_{side}", side * 0.47 - 0.11, side * 0.47 + 0.11, 0.43, 0.46, 0.22, 0.48, "Carbon")

# cockpit opening, driver, airbox, camera pod
box("Cockpit", -0.24, 0.24, -0.20, 0.62, 0.66, 0.735, "Carbon")
bm = bmesh.new()
bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=14, radius=0.15)
for v in bm.verts:
    v.co = Vector((v.co.x, v.co.y * 1.15 + 0.08, v.co.z + 0.80))
obj_from_bmesh("Helmet", bm, ["Helmet"], smooth=True)
box("Visor", -0.105, 0.105, 0.20, 0.235, 0.79, 0.85, "Carbon")
box("AirboxInlet", -0.13, 0.13, -0.43, -0.40, 0.84, 0.95, "Carbon")
box("TCam", -0.07, 0.07, -0.60, -0.42, 0.97, 1.03, "Accent")

# floor, wings
box("Floor", -0.74, 0.74, -2.25, 1.05, 0.03, 0.06, "Carbon")
box("FrontWingMain", -1.0, 1.0, 2.55, 3.02, 0.08, 0.11, "Carbon")
box("FrontWingFlap", -0.96, 0.96, 2.42, 2.70, 0.15, 0.18, "Carbon", tilt=math.radians(-18))
box("FrontWingFlap2", -0.92, 0.92, 2.32, 2.52, 0.22, 0.245, "Livery", tilt=math.radians(-28))
for side in (-1, 1):
    box(f"FWEndplate_{side}", side * 1.0 - 0.012, side * 1.0 + 0.012, 2.30, 3.02, 0.05, 0.33, "Accent")
    box(f"RWEndplate_{side}", side * 0.53 - 0.012, side * 0.53 + 0.012, -3.02, -2.28, 0.48, 1.08, "Accent")
    box(f"Mirror_{side}", side * 0.50 - 0.07, side * 0.50 + 0.07, 0.30, 0.34, 0.66, 0.73, "Livery")
    tube(f"MirrorStalk_{side}", [(side * 0.30, 0.32, 0.60), (side * 0.44, 0.32, 0.69)], 0.012)
box("RearWingMain", -0.53, 0.53, -2.98, -2.58, 0.86, 0.90, "Carbon", tilt=math.radians(8))
box("RearWingFlap", -0.53, 0.53, -2.72, -2.46, 0.98, 1.01, "Livery", tilt=math.radians(-22))
box("BeamWing", -0.46, 0.46, -2.80, -2.58, 0.42, 0.445, "Carbon")
box("RWPylon", -0.03, 0.03, -2.72, -2.60, 0.34, 0.88, "Carbon")
box("Diffuser", -0.55, 0.55, -2.55, -2.25, 0.04, 0.22, "Carbon", tilt=math.radians(-14))

# halo: two legs meeting at a front pillar
halo_path = bezier((-0.27, -0.18, 0.70), (-0.34, 0.30, 0.92), (0.0, 0.52, 0.92)) + \
    bezier((0.0, 0.52, 0.92), (0.34, 0.30, 0.92), (0.27, -0.18, 0.70))[1:]
tube("Halo", halo_path, 0.026)
tube("HaloPillar", [(0.0, 0.52, 0.92), (0.0, 0.62, 0.80), (0.0, 0.66, 0.70)], 0.024)

# wheels + suspension
WHEELS = {"FL": (-0.80, 1.75, 0.355, 0.34), "FR": (0.80, 1.75, 0.355, 0.34),
          "RL": (-0.78, -1.85, 0.36, 0.41), "RR": (0.78, -1.85, 0.36, 0.41)}
for key, (x, y, r, wdt) in WHEELS.items():
    wheel(f"Wheel_{key}", x, y, r, wdt)
    s = 1 if x > 0 else -1
    inner = s * 0.22 if y > 0 else s * 0.20
    hub = abs(x) - wdt / 2 - 0.02
    for dz, dy in ((0.12, 0.25), (-0.06, 0.25), (0.12, -0.25), (-0.06, -0.25)):
        tube(f"Arm_{key}_{dz}_{dy}", [(inner, y + dy, r + dz), (s * hub, y, r + dz * 0.8)], 0.016)

# ------------------------------------------------------------------ merge everything except the wheels
# (one mesh per car keeps the browser's draw calls low)
dg = bpy.context.evaluated_depsgraph_get()
parts = [o for o in scene.collection.objects if o.type == "MESH" and not o.name.startswith("Wheel_")]
for o in parts:
    if o.modifiers:
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
        o.modifiers.clear()
        o.data = me
chassis = parts[0]
with bpy.context.temp_override(active_object=chassis, selected_editable_objects=parts, object=chassis):
    bpy.ops.object.join()
chassis.name = "Chassis"

# ------------------------------------------------------------------ export
os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=OUT_GLB, export_format="GLB", export_apply=True, export_yup=True,
                          export_cameras=False, export_lights=False)

# ------------------------------------------------------------------ preview render
cam_data = bpy.data.cameras.new("cam")
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
cam.location = (4.6, 4.2, 2.3)
direction = Vector((0, 0.1, 0.4)) - cam.location
cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
cam_data.lens = 40
scene.camera = cam
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.rotation_euler = (math.radians(50), 0, math.radians(30))
scene.collection.objects.link(sun)
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "MATERIAL"
scene.display.shading.show_shadows = True
scene.display.shading.show_cavity = True
scene.render.resolution_x, scene.render.resolution_y = 1280, 720
scene.render.film_transparent = False
scene.world = bpy.data.worlds.new("w")
scene.world.color = (0.82, 0.84, 0.86)
scene.render.filepath = OUT_PNG
bpy.ops.render.render(write_still=True)
print("EXPORTED", OUT_GLB, os.path.getsize(OUT_GLB))
