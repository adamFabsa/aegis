"""
Lantern ground plate.

Renders the whole town board (terrain, roads, sidewalks, curbs, park, pond, lots and the soil
cut along the board edge) as one image per look, with the same orthographic true-iso camera
and lights as the building sprites, so everything lines up with the SVG map 1:1.

Usage (from the repo root):
  blender -b -P blender/build_ground.py -- --looks dusk,night,maquette --scale 2 --samples 64

Output: web/public/sprites/ground_<look>.webp (+ ground_<look>_lite.webp for phones).
The frame covers view box x 0..1440, y 96..968 (GROUND_PLATE in web/src/town/scene.ts).
Layout numbers mirror web/src/town/scene.ts and mockWorld.ts; keep them in sync.
"""
import bpy, math, random, sys, os, subprocess
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_sprites as bs  # noqa: E402  (helpers, palettes and lights; its main() does not run on import)
import vehicles  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(name, default):
    return argv[argv.index(name) + 1] if name in argv else default

LOOKS = arg('--looks', 'dusk,night,maquette').split(',')
SCALE = float(arg('--scale', '2'))
SAMPLES = int(arg('--samples', '64'))
OUT = arg('--out', os.path.join(bs.ROOT, 'web', 'public', 'sprites'))

# plate frame in SVG view units (iso.ts: OX 555, OY 120)
FX, FY, FW, FH = 0, 96, 1440, 872
OX, OY = 555, 120

lin, link, setin = bs.lin, bs.link, bs.setin

def P(x, y, z=0.0):
    """map units -> Blender metres (1 m = 4 units; map +y runs toward Blender -Y)."""
    return (x / 4.0, -y / 4.0, z)

# ------------------------------------------------------------------ layout (mirrors scene.ts)
MAP_W, MAP_H = 1000, 620
ROADS = [(0, 430, 1000, 36), (360, 0, 32, 620), (392, 214, 608, 22)]
SIDEWALKS = [(0, 424, 1000, 48), (354, 0, 44, 620), (392, 208, 608, 34)]
LOTS = [(600, 490, 140, 92), (20, 482, 104, 120)]
PARK = (24, 24, 310, 196)
POND = (128, 86, 44, 26)
HILLS = [(560, 0), (1000, 0), (1000, 285), (930, 255), (880, 218), (820, 206), (760, 196),
         (700, 152), (640, 122), (608, 102), (584, 62)]
BUILDINGS = [  # x, y, w, h, kind
    (570, 250, 150, 70, 'senior'), (780, 300, 110, 60, 'senior'), (420, 290, 120, 90, 'apartments'),
    (170, 270, 140, 80, 'apartments'), (140, 480, 130, 64, 'office'), (800, 470, 130, 70, 'apartments'),
    (430, 150, 280, 40, 'homes'), (440, 505, 140, 60, 'shelter'),
]

def in_poly(x, y, poly):
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside

def in_rect(x, y, r, pad=0.0):
    rx, ry, rw, rh = r
    return rx - pad <= x <= rx + rw + pad and ry - pad <= y <= ry + rh + pad

# ------------------------------------------------------------------ palettes
GP = {
    'real': dict(green1='#5F7334', green2='#869045', dry='#C4AA6A', straw='#DCC890', dirt='#9E8463', olive='#7B7F47', lawn='#4E6B2B', lawnHi='#6F8A38',
                 chap='#5A5D3A', chapD='#3F4529', chapSoil='#8A7658', asphalt='#3A3B3E', asphaltHi='#55565A', lotAsph='#45464A',
                 conc='#BDB6A8', concD='#9E968A', paintW='#E9E6DE', paintY='#E2B23A', dg='#C4A77A', water='#183A40',
                 rock='#8C857A', soil='#6E5840', topsoil='#3D3025', wood='#7A5638', metal='#3A3D42', rubber='#7E4636',
                 hydrant='#E2C23A', manhole='#2A2A2C'),
    'maq': dict(green1='#DDE0CF', green2='#E4E6D8', dry='#E6DFCF', straw='#EEE8DA', dirt='#DCD3C1', olive='#DADCC9', lawn='#DCE0CE', lawnHi='#E6E9DA',
                chap='#D8D2BF', chapD='#CCC5B0', chapSoil='#E0D8C6', asphalt='#CFCBC2', asphaltHi='#DAD6CE', lotAsph='#D4D0C8',
                conc='#F1EEE7', concD='#E3DED4', paintW='#FFFFFF', paintY='#F4EBD3', dg='#E8DFCC', water='#C6D2D6',
                rock='#DAD5CB', soil='#DDD4C3', topsoil='#CFC5B2', wood='#DCCBAE', metal='#D6D2CA', rubber='#E2D2C6',
                hydrant='#F2EEE4', manhole='#C8C4BC'),
}

# ------------------------------------------------------------------ node helpers
class NT:
    """Tiny node-graph helper bound to one material."""
    def __init__(self, name):
        self.m = bpy.data.materials.new(name)
        try:
            self.m.use_nodes = True
        except Exception:
            pass
        self.nt = self.m.node_tree
        self.bsdf = self.nt.nodes.get('Principled BSDF') or self.nt.nodes.new('ShaderNodeBsdfPrincipled')
        geo = self.nt.nodes.new('ShaderNodeNewGeometry')
        self.pos = geo.outputs['Position']   # world space, so overlapping pieces share one texture

    def node(self, kind, **inputs):
        n = self.nt.nodes.new(kind)
        for k, v in inputs.items():
            if k in n.inputs:
                if hasattr(v, 'is_output'):
                    link(self.nt, v, n.inputs[k])
                else:
                    n.inputs[k].default_value = v
        return n

    def noise(self, scale, detail=4.0, rough=0.5, vec=None, dims=None):
        n = self.node('ShaderNodeTexNoise', Scale=scale, Detail=detail, Roughness=rough)
        if dims:
            n.noise_dimensions = dims
        link(self.nt, vec or self.pos, n.inputs['Vector'])
        return n.outputs['Fac']

    def voronoi(self, scale, feature='F1', vec=None, rand=1.0):
        n = self.node('ShaderNodeTexVoronoi', Scale=scale, Randomness=rand)
        n.feature = feature
        link(self.nt, vec or self.pos, n.inputs['Vector'])
        return n.outputs['Distance']

    def math(self, op, a, b=None, clamp=False):
        n = self.nt.nodes.new('ShaderNodeMath')
        n.operation = op
        n.use_clamp = clamp
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if hasattr(v, 'is_output'):
                link(self.nt, v, n.inputs[i])
            else:
                n.inputs[i].default_value = v
        return n.outputs[0]

    def ramp(self, fac, lo, hi, a=0.0, b=1.0):
        n = self.nt.nodes.new('ShaderNodeMapRange')
        link(self.nt, fac, n.inputs['Value'])
        n.inputs['From Min'].default_value = lo
        n.inputs['From Max'].default_value = hi
        n.inputs['To Min'].default_value = a
        n.inputs['To Max'].default_value = b
        n.clamp = True
        return n.outputs['Result']

    def mix(self, fac, a, b):
        return bs.mix_rgb(self.nt, fac, a, b)

    def xyz(self):
        s = self.nt.nodes.new('ShaderNodeSeparateXYZ')
        link(self.nt, self.pos, s.inputs[0])
        return s.outputs['X'], s.outputs['Y'], s.outputs['Z']

    def done(self, col, rough=0.9, bump=None, bstr=0.4, spec=0.4, dist=0.02, metal=0.0, coat=0.0):
        if hasattr(col, 'is_output'):
            link(self.nt, col, self.bsdf.inputs['Base Color'])
        else:
            self.bsdf.inputs['Base Color'].default_value = col
        if hasattr(rough, 'is_output'):
            link(self.nt, rough, self.bsdf.inputs['Roughness'])
        else:
            setin(self.bsdf, 'Roughness', rough)
        setin(self.bsdf, 'Specular IOR Level', spec)
        setin(self.bsdf, 'Metallic', metal)
        setin(self.bsdf, 'Coat Weight', coat)
        if bump is not None:
            bp = self.node('ShaderNodeBump', Strength=bstr, Distance=dist)
            link(self.nt, bump, bp.inputs['Height'])
            link(self.nt, bp.outputs['Normal'], self.bsdf.inputs['Normal'])
        return self.m

def C(h):
    return lin(h)

def sc(c, f):
    return bs.scale_col(c, f)

# ------------------------------------------------------------------ materials
def materials(G, maq):
    M = {}
    k = 0.35 if maq else 1.0   # maquette keeps texture variation subtle

    # vacant land: California dry grass, bare dirt and a few green patches
    t = NT('vacant')
    big = t.noise(0.045, 5, 0.55)
    mid = t.noise(0.5, 6, 0.6)
    col = t.mix(t.ramp(big, 0.26, 0.48), C(G['dirt']), C(G['dry']))
    col = t.mix(t.ramp(mid, 0.45, 0.75, 0, 0.7 * k), col, C(G['straw']))
    col = t.mix(t.ramp(t.noise(0.11, 3), 0.6, 0.68, 0, 0.75 * k), col, C(G['olive']))
    col = t.mix(t.ramp(t.noise(2.2, 4), 0.25, 0.6, 0.35 * k, 0), col, sc(C(G['dirt']), 0.8))
    # the town core is watered: green grass with tired patches; it dries out toward the hills
    green = t.mix(t.ramp(t.noise(0.3, 4), 0.35, 0.7), C(G['green1']), C(G['green2']))
    green = t.mix(t.ramp(t.noise(0.9, 5), 0.58, 0.7, 0, 0.8 * k), green, C(G['straw']))
    green = t.mix(t.ramp(t.noise(2.4, 4), 0.3, 0.62, 0.3 * k, 0), green, sc(C(G['green1']), 0.75))
    x, y, _ = t.xyz()
    toward_hills = t.math('ADD', t.math('ADD', x, y), t.math('MULTIPLY', t.noise(0.05, 3), 40.0))
    col = t.mix(t.ramp(toward_hills, 100, 150), green, col)
    blades = t.math('ADD', t.noise(38, 2), t.math('MULTIPLY', t.voronoi(7), 0.6))
    M['vacant'] = t.done(col, 0.95, blades, 0.55)

    # irrigated lawn (yards), with mowing stripes for the park
    for name, stripes in (('lawn', False), ('park', True)):
        t = NT(name)
        col = t.mix(t.ramp(t.noise(0.25, 4), 0.4, 0.7, 0, 0.55 * k), C(G['lawn']), C(G['lawnHi']))
        col = t.mix(t.ramp(t.noise(1.6, 5), 0.3, 0.7, 0.25 * k, 0), col, sc(C(G['lawn']), 0.75))
        if stripes and not maq:
            x, y, _ = t.xyz()
            s = t.math('SINE', t.math('MULTIPLY', t.math('ADD', x, t.math('MULTIPLY', y, 0.35)), math.pi / 2.6))
            col = t.mix(t.ramp(s, -0.2, 0.2, 0.0, 0.22), col, sc(C(G['lawnHi']), 1.15))
        M[name] = t.done(col, 0.92, t.noise(70, 2), 0.35)

    # chaparral: dense dark shrubs on dry soil
    t = NT('chaparral')
    cell = t.voronoi(0.9)
    shrub = t.ramp(t.math('ADD', cell, t.math('MULTIPLY', t.noise(1.4, 4), 0.35)), 0.38, 0.62, 1, 0)
    soil = t.mix(t.ramp(t.noise(0.6, 5), 0.4, 0.7), C(G['chapSoil']), C(G['dry']))
    leaf = t.mix(t.ramp(t.noise(0.35, 3), 0.35, 0.7), C(G['chapD']), C(G['chap']))
    col = t.mix(shrub, soil, leaf)
    col = t.mix(t.ramp(t.noise(5, 4), 0.3, 0.7, 0.3 * k, 0), col, sc(C(G['chapD']), 0.7))
    M['chap'] = t.done(col, 0.95, t.math('ADD', t.math('MULTIPLY', shrub, 1.2), t.noise(18, 3)), 0.6)

    # asphalt: aggregate, uneven wear, cracks and oil stains
    for name, base in (('asphalt', G['asphalt']), ('lot', G['lotAsph'])):
        t = NT(name)
        col = t.mix(t.ramp(t.noise(0.18, 4), 0.35, 0.65, 0, 0.6 * k), sc(C(base), 0.88), C(G['asphaltHi']))
        col = t.mix(t.ramp(t.noise(320, 2), 0.4, 0.75, 0, 0.35 * k), col, sc(C(G['asphaltHi']), 1.15))
        if not maq:
            stain = t.ramp(t.noise(0.9, 3), 0.62, 0.72, 0, 0.45)
            col = t.mix(stain, col, sc(C(base), 0.55))
        warp = t.node('ShaderNodeVectorMath')
        warp.operation = 'ADD'
        link(t.nt, t.pos, warp.inputs[0])
        nz = t.node('ShaderNodeTexNoise', Scale=1.2, Detail=3)
        link(t.nt, t.pos, nz.inputs['Vector'])
        link(t.nt, nz.outputs['Color'], warp.inputs[1])
        crack_d = t.node('ShaderNodeTexVoronoi', Scale=0.35)
        crack_d.feature = 'DISTANCE_TO_EDGE'
        link(t.nt, warp.outputs[0], crack_d.inputs['Vector'])
        crack = t.ramp(crack_d.outputs['Distance'], 0.0, 0.035 if not maq else 0.012, 1, 0)
        crack = t.math('MULTIPLY', crack, t.ramp(t.noise(0.5, 2), 0.45, 0.6))
        col = t.mix(t.math('MULTIPLY', crack, 0.75 * k), col, sc(C(base), 0.35))
        bump = t.math('SUBTRACT', t.noise(260, 2), t.math('MULTIPLY', crack, 1.5))
        M[name] = t.done(col, 0.88, bump, 0.35)

    # concrete with scored joints every 1.5 m (sidewalk panels) and a little grime
    t = NT('concrete')
    x, y, _ = t.xyz()
    def groove(v):
        f = t.math('FRACT', t.math('DIVIDE', v, 1.5))
        d = t.math('MINIMUM', f, t.math('SUBTRACT', 1.0, f))
        return t.ramp(d, 0.0, 0.016, 1, 0)
    joints = t.math('MAXIMUM', groove(x), groove(y))
    col = t.mix(t.ramp(t.noise(0.4, 4), 0.35, 0.7, 0, 0.5 * k), C(G['conc']), C(G['concD']))
    col = t.mix(t.ramp(t.noise(4, 5), 0.5, 0.8, 0, 0.3 * k), col, sc(C(G['concD']), 0.85))
    col = t.mix(t.math('MULTIPLY', joints, 0.7 * (0.5 if maq else 1)), col, sc(C(G['concD']), 0.55))
    M['conc'] = t.done(col, 0.85, t.math('SUBTRACT', t.noise(140, 2), t.math('MULTIPLY', joints, 2.0)), 0.3)
    t = NT('curb')
    M['curb'] = t.done(t.mix(t.ramp(t.noise(3, 4), 0.4, 0.8, 0, 0.4 * k), sc(C(G['conc']), 1.04), C(G['concD'])), 0.8, t.noise(90, 2), 0.25)
    t = NT('apron')
    M['apron'] = t.done(t.mix(t.ramp(t.noise(0.5, 4), 0.35, 0.7, 0, 0.5 * k), sc(C(G['conc']), 0.96), C(G['concD'])), 0.85, t.noise(120, 2), 0.25)

    # road paint, worn through in places
    for name, base in (('paintW', G['paintW']), ('paintY', G['paintY']), ('paintB', '#3E6FB0'), ('paintR', '#B8352B')):
        t = NT(name)
        wear = t.ramp(t.noise(3.5, 5), 0.5, 0.75, 0, 0.75 if not maq else 0.0)
        M[name] = t.done(t.mix(wear, C(base), sc(C(G['asphalt']), 1.1)), 0.6, t.noise(200, 2), 0.2)

    # decomposed granite paths
    t = NT('dg')
    col = t.mix(t.ramp(t.noise(1.2, 5), 0.35, 0.7, 0, 0.5 * k), C(G['dg']), sc(C(G['dg']), 0.82))
    M['dg'] = t.done(col, 0.95, t.noise(160, 3), 0.5)

    # water: dark, glossy, small wind ripples
    t = NT('water')
    rip = t.noise(3.0, 3, vec=None)
    M['water'] = t.done(C(G['water']), 0.05 if not maq else 0.4, rip, 0.15, spec=0.8)
    t = NT('mud')
    M['mud'] = t.done(sc(C(G['dirt']), 0.7), 0.6, t.noise(40, 3), 0.3)

    t = NT('rock')
    M['rock'] = t.done(t.mix(t.ramp(t.noise(6, 4), 0.3, 0.7), C(G['rock']), sc(C(G['rock']), 0.7)), 0.85, t.noise(30, 4), 0.6)

    # soil cut along the board edge: dark topsoil over layered subsoil
    t = NT('soil')
    _, _, z = t.xyz()
    zz = t.math('ADD', z, t.math('MULTIPLY', t.noise(0.8, 3), 0.35))
    layers = t.node('ShaderNodeTexWave', Scale=0.0)
    layers.wave_type = 'BANDS'
    try:
        layers.bands_direction = 'Z'
    except Exception:
        pass
    setin(layers, 'Scale', 0.9)
    setin(layers, 'Distortion', 4.0)
    link(t.nt, t.pos, layers.inputs['Vector'])
    col = t.mix(t.ramp(layers.outputs['Fac'], 0.2, 0.8, 0, 0.35 * k), C(G['soil']), sc(C(G['soil']), 0.78))
    col = t.mix(t.ramp(zz, -0.9, -0.5, 0, 1), col, C(G['topsoil']))
    col = t.mix(t.ramp(t.voronoi(9), 0.0, 0.08, 0.5 * k, 0), col, C(G['rock']))
    M['soil'] = t.done(col, 0.95, t.math('ADD', t.voronoi(9), t.noise(12, 3)), 0.5)

    M['wood'] = bs.make_mat('wood', G['wood'], rough=0.7, noise=0.3 * k, nscale=20)
    M['metal'] = bs.make_mat('metal', G['metal'], rough=0.4, metal=0.0 if maq else 0.7)
    M['rubber'] = bs.make_mat('rubber', G['rubber'], rough=0.95, noise=0.4 * k, nscale=60, bump=0.3)
    M['hydrant'] = bs.make_mat('hydrant', G['hydrant'], rough=0.45)
    M['manhole'] = bs.make_mat('manhole', G['manhole'], rough=0.55, metal=0.0 if maq else 0.6, noise=0.3, nscale=30, bump=0.4, bscale=80)
    M['grassClump'] = bs.make_mat('grassClump', G['straw'], rough=0.9, noise=0.5 * k, nscale=4)
    M['shrub'] = bs.make_mat('shrubLeaf', G['chap'], rough=0.85, noise=0.6 * k, nscale=3, bump=0.5, bscale=40)
    return M

# ------------------------------------------------------------------ geometry helpers
def poly_obj(name, pts, z, mat):
    v = [P(x, y, z) for (x, y) in pts]
    return bs.mesh_obj(name, v, [list(range(len(v)))[::-1]], mat)

def rect_pts(x, y, w, h):
    return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]

def rrect_pts(x, y, w, h, r, seg=6):
    pts = []
    for (cx, cy, a0) in ((x + w - r, y + r, -90), (x + w - r, y + h - r, 0), (x + r, y + h - r, 90), (x + r, y + r, 180)):
        for i in range(seg + 1):
            a = math.radians(a0 + 90 * i / seg)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts

def ellipse_pts(cx, cy, rx, ry, n=72, jitter=0.0, seed=1):
    rnd = random.Random(seed)
    out = []
    for i in range(n):
        a = 2 * math.pi * i / n
        j = 1 + (rnd.random() - 0.5) * jitter
        out.append((cx + rx * j * math.cos(a), cy + ry * j * math.sin(a)))
    return out

def box(name, x0, y0, x1, y1, z0, z1, mat, bevel=0.0):
    """Axis-aligned box in map units (x0<x1, y0<y1) between heights z0..z1 (metres)."""
    a, b = P(x0, y1), P(x1, y0)
    return bs.boxes(name, [(a[0], b[0], a[1], b[1], z0, z1)], mat, bevel)

def ribbon(name, pts, width, z, mat):
    """Flat strip of the given width (map units) along a polyline."""
    left, right = [], []
    for i, (x, y) in enumerate(pts):
        x0, y0 = pts[max(0, i - 1)]
        x1, y1 = pts[min(len(pts) - 1, i + 1)]
        dx, dy = x1 - x0, y1 - y0
        L = math.hypot(dx, dy) or 1
        nx, ny = -dy / L * width / 2, dx / L * width / 2
        left.append((x + nx, y + ny))
        right.append((x - nx, y - ny))
    v = [P(x, y, z) for (x, y) in left] + [P(x, y, z) for (x, y) in right]
    n = len(pts)
    f = [(i + 1, i, n + i, n + i + 1) for i in range(n - 1)]
    return bs.mesh_obj(name, v, f, mat)

def cubic(p0, p1, p2, p3, n=40):
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append((u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
                    u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1]))
    return out

def boolean(target, cutters, op='DIFFERENCE'):
    for c in cutters:
        m = target.modifiers.new('bool', 'BOOLEAN')
        m.operation = op
        m.object = c
        m.solver = 'EXACT'
        c.hide_render = True
        c.hide_viewport = True
    bpy.context.view_layer.objects.active = target
    for m in list(target.modifiers):
        if m.type == 'BOOLEAN':
            bpy.ops.object.modifier_apply(modifier=m.name)
    for c in cutters:
        bpy.data.objects.remove(c, do_unlink=True)

def scatter(name, proto, pts, zs=0.0):
    """Instance `proto` at every point (one vertex each) via vertex instancing: fast for thousands."""
    v = [P(x, y, zs) for (x, y) in pts]
    me = bpy.data.meshes.new(name)
    me.from_pydata(v, [], [])
    host = bs.add_obj(name, me)
    host.instance_type = 'VERTS'
    proto.parent = host
    proto.location = (0, 0, 0)
    return host

# ------------------------------------------------------------------ the board
def build(M, maq):
    rnd = random.Random(4)
    # soil slab under everything (its front and right faces are the visible cut)
    box('slab', 0, 0, MAP_W, MAP_H, -5.5, -0.002, M['soil'])

    # vacant land everywhere, then the zones on top
    poly_obj('vacant', rect_pts(0, 0, MAP_W, MAP_H), 0.0, M['vacant'])
    poly_obj('hills', HILLS, 0.006, M['chap'])

    # irrigated yards around each building, edged with a concrete mow strip
    for i, (x, y, w, h, kind) in enumerate(BUILDINGS):
        pad = 8 if kind == 'homes' else 12
        pts = rrect_pts(x - pad, y - pad, w + 2 * pad, h + 2 * pad, 8)
        poly_obj(f'yard{i}', pts, 0.012, M['lawn'])
        ring_pts = pts + [pts[0]]
        ribbon(f'yardEdge{i}', ring_pts, 1.2, 0.016, M['curb'])

    # park: striped lawn, gravel paths, pond with a muddy shore and stones, furniture
    px, py, pw, ph = PARK
    park = rrect_pts(px, py, pw, ph, 14)
    poly_obj('park', park, 0.014, M['park'])
    ribbon('parkEdge', park + [park[0]], 1.6, 0.018, M['curb'])
    cx, cy, rx, ry = POND
    ribbon('pondRing', ellipse_pts(cx, cy, rx + 7, ry + 7, 96) + [ellipse_pts(cx, cy, rx + 7, ry + 7, 96)[0]], 5, 0.02, M['dg'])
    poly_obj('shore', ellipse_pts(cx, cy, rx + 3, ry + 3, 96, 0.05, 3), 0.022, M['mud'])
    pond = poly_obj('pond', ellipse_pts(cx, cy, rx, ry, 96, 0.04, 5), 0.03, M['water'])
    for i in range(64):
        a = 2 * math.pi * i / 64 + rnd.random() * 0.05
        rr = 1 + (rnd.random() - 0.5) * 0.06
        bx, by = cx + (rx + 1.5) * rr * math.cos(a), cy + (ry + 1.5) * rr * math.sin(a)
        bs.blob(f'stone{i}', P(bx, by, 0.05), 0.22 + rnd.random() * 0.22, M['rock'], i)
    main_path = cubic((24, 150), (110, 120), (220, 190), (334, 136), 60)
    ribbon('parkPath', main_path, 7, 0.024, M['dg'])
    ribbon('pondLink', cubic((150, 112), (165, 122), (170, 135), (178, 146), 12), 5, 0.023, M['dg'])
    # benches along the path, facing the pond
    for i, t in enumerate((0.18, 0.42, 0.66)):
        bx, by = main_path[int(t * 60)]
        by -= 7
        box(f'benchSeat{i}', bx - 3.2, by - 0.9, bx + 3.2, by + 0.9, 0.42, 0.5, M['wood'], 0.01)
        box(f'benchBack{i}', bx - 3.2, by - 1.2, bx + 3.2, by - 0.8, 0.5, 0.9, M['wood'], 0.01)
        for sx in (-2.6, 2.6):
            box(f'benchLeg{i}{sx}', bx + sx - 0.3, by - 0.8, bx + sx + 0.3, by + 0.8, 0.0, 0.42, M['metal'])
    # picnic tables on the east lawn
    for i, (tx, ty) in enumerate(((272, 172), (300, 196))):
        box(f'table{i}', tx - 4, ty - 2.2, tx + 4, ty + 2.2, 0.72, 0.78, M['wood'], 0.01)
        for dy in (-4.2, 4.2):
            box(f'tbench{i}{dy}', tx - 4, ty + dy - 0.9, tx + 4, ty + dy + 0.9, 0.42, 0.47, M['wood'], 0.01)
        box(f'tleg{i}', tx - 0.6, ty - 4.5, tx + 0.6, ty + 4.5, 0.0, 0.72, M['metal'])
    # playground: rubber surface, a deck on posts, a slide and a swing frame
    gx, gy = 250, 52
    poly_obj('play', rrect_pts(gx, gy, 52, 36, 6), 0.026, M['rubber'])
    box('deck', gx + 12, gy + 10, gx + 26, gy + 22, 1.2, 1.35, M['wood'])
    for (ax, ay) in ((gx + 12, gy + 10), (gx + 26, gy + 10), (gx + 12, gy + 22), (gx + 26, gy + 22)):
        box('post', ax - 0.6, ay - 0.6, ax + 0.6, ay + 0.6, 0.0, 2.4, M['metal'])
    box('roofPlay', gx + 11, gy + 9, gx + 27, gy + 23, 2.4, 2.55, M['paintR'])
    slide = bs.mesh_obj('slide', [P(gx + 26, gy + 13, 1.3), P(gx + 26, gy + 19, 1.3), P(gx + 40, gy + 19, 0.15), P(gx + 40, gy + 13, 0.15)], [(0, 1, 2, 3)], M['paintY'], solidify=0.08)
    for sx in (gx + 8, gx + 44):
        box('swingLeg', sx - 0.5, gy + 28, sx + 0.5, gy + 29, 0.0, 2.2, M['metal'])
    box('swingBar', gx + 7.5, gy + 28, gx + 44.5, gy + 29, 2.2, 2.3, M['metal'])
    for sx in (gx + 18, gx + 30):
        box('swingSeat', sx - 1.5, gy + 27.6, sx + 1.5, gy + 29.4, 0.45, 0.5, M['rubber'])

    # roads: asphalt surfaces sit 15 cm below the sidewalks
    for i, (x, y, w, h) in enumerate(ROADS):
        box(f'road{i}', x, y, x + w, y + h, -0.1, 0.02 + i * 0.0005, M['asphalt'])
    # sidewalks: the union of the sidewalk bands minus the road beds; the cut faces become the curbs
    walk = box('walk', *(lambda r: (r[0], r[1], r[0] + r[2], r[1] + r[3]))(SIDEWALKS[0]), -0.1, 0.17, M['conc'])
    extra = [box(f'walk{i}', r[0], r[1], r[0] + r[2], r[1] + r[3], -0.1, 0.17, M['conc']) for i, r in enumerate(SIDEWALKS[1:])]
    boolean(walk, extra, 'UNION')
    cutters = [box(f'cut{i}', x, y if y > 0 else -5, x + w if x + w < MAP_W else MAP_W + 5, y + h if y + h < MAP_H else MAP_H + 5, -0.5, 0.5, M['conc'])
               for i, (x, y, w, h) in enumerate(ROADS)]
    boolean(walk, cutters, 'DIFFERENCE')
    bv = walk.modifiers.new('bevel', 'BEVEL')
    bv.width = 0.04
    bv.segments = 2
    bv.limit_method = 'ANGLE'

    # lane paint: double yellow centre lines, white edge lines, crosswalks and stop bars
    def hline(name, x0, x1, y, w, mat):
        box(name, x0, y - w / 2, x1, y + w / 2, 0.02, 0.026, mat)
    def vline(name, y0, y1, x, w, mat):
        box(name, x - w / 2, y0, x + w / 2, y1, 0.02, 0.026, mat)
    for (a, b) in ((0, 344), (408, 1000)):
        hline('yA', a, b, 447.3, 0.45, M['paintY'])
        hline('yB', a, b, 448.7, 0.45, M['paintY'])
        hline('edgeN', a, b, 432.5, 0.4, M['paintW'])
        hline('edgeS', a, b, 463.5, 0.4, M['paintW'])
    for (a, b) in ((0, 206), (240, 414), (480, 620)):
        vline('yA', a, b, 375.3, 0.45, M['paintY'])
        vline('yB', a, b, 376.7, 0.45, M['paintY'])
    for xx in range(420, 1000, 16):
        hline('dash', xx, xx + 8, 225, 0.45, M['paintW'])
    def zebra(name, x0, y0, x1, y1, along_x):
        if along_x:     # bars run along x, stacked in y
            yy = y0 + 1
            while yy + 2.4 <= y1:
                box(name, x0, yy, x1, yy + 2.4, 0.02, 0.026, M['paintW'])
                yy += 4.8
        else:
            xx = x0 + 1
            while xx + 2.4 <= x1:
                box(name, xx, y0, xx + 2.4, y1, 0.02, 0.026, M['paintW'])
                xx += 4.8
    zebra('xwN', 361, 416, 391, 426, False)
    zebra('xwS', 361, 470, 391, 480, False)
    zebra('xwW', 344, 431, 354, 465, True)
    zebra('xwE', 398, 431, 408, 465, True)
    zebra('xwT', 400, 215, 410, 235, True)
    for (x0, y0, x1, y1) in ((342, 448, 343.5, 465), (408.5, 431, 410, 448), (361, 413, 376, 414.5), (376, 481.5, 391, 483)):
        box('stop', x0, y0, x1, y1, 0.02, 0.026, M['paintW'])
    # red curb (no parking) on the corners of the main intersection
    for (x0, y0, x1, y1) in ((330, 429.2, 359, 430.4), (393, 465.6, 422, 466.8), (359, 400, 360.2, 429), (391.8, 467, 393, 496)):
        box('redCurb', x0, y0, x1, y1, 0.02, 0.172, M['paintR'])

    # parking lots: asphalt pads with curbs, stall lines, wheel stops and a concrete driveway to the road
    for i, (x, y, w, h) in enumerate(LOTS):
        box(f'lot{i}', x, y, x + w, y + h, -0.1, 0.03, M['lot'] if i == 0 else M['apron'])
        for (a, b, c, d) in ((x - 1.2, y - 1.2, x + w + 1.2, y), (x - 1.2, y + h, x + w + 1.2, y + h + 1.2),
                             (x - 1.2, y, x, y + h), (x + w, y, x + w + 1.2, y + h)):
            box(f'lotCurb{i}', a, b, c, d, 0.0, 0.16, M['curb'], 0.02)
    for xx in range(614, 740, 14):
        vline('stall', 490, 514, xx, 0.45, M['paintW'])
        vline('stall', 558, 582, xx, 0.45, M['paintW'])
    for xx in range(607, 733, 14):
        box('stopBlock', xx - 3, 491, xx + 3, 492.6, 0.03, 0.18, M['curb'], 0.02)
        box('stopBlock', xx - 3, 579.4, xx + 3, 581, 0.03, 0.18, M['curb'], 0.02)
    box('ada', 600.5, 490.5, 613.5, 513.5, 0.03, 0.034, M['paintB'])
    for yy in range(496, 590, 14):
        hline('bay', 20, 46, yy, 0.6, M['paintR'])
        hline('bay', 98, 124, yy, 0.6, M['paintR'])
    box('drive0', 652, 466, 684, 491, -0.1, 0.04, M['apron'])
    box('drive1', 58, 466, 86, 483, -0.1, 0.04, M['apron'])

    # street furniture: manholes, storm drains at the curb, fire hydrants on the sidewalks
    for (mx, my) in ((180, 440), (560, 456), (820, 440), (370, 120), (382, 560), (700, 225)):
        bs.cylinder('manhole', *P(mx, my)[:2], 0.02, 0.03, 0.38, M['manhole'], 24)
    for (dx, dy, horiz) in ((330, 431.5, True), (420, 464.5, True), (361.5, 400, False), (390.5, 500, False), (640, 431.5, True)):
        if horiz:
            box('drain', dx - 2, dy - 0.6, dx + 2, dy + 0.6, 0.02, 0.028, M['manhole'])
        else:
            box('drain', dx - 0.6, dy - 2, dx + 0.6, dy + 2, 0.02, 0.028, M['manhole'])
    for (hx, hy) in ((300, 427), (470, 469), (357, 330), (395, 380), (760, 427), (900, 469), (520, 239)):
        x, y, _ = P(hx, hy)
        bs.cylinder('hydrant', x, y, 0.17, 0.75, 0.13, M['hydrant'], 12)
        bs.cylinder('hydrantCap', x, y, 0.75, 0.84, 0.1, M['hydrant'], 12)
        bs.cylinder('hydrantNoz', x, y, 0.45, 0.55, 0.19, M['hydrant'], 12)

    # informal dirt tracks across the vacant land (desire lines)
    for i, (a, b, c, d) in enumerate((((930, 420), (960, 380), (990, 330), (985, 290)),
                                      ((30, 410), (60, 360), (110, 300), (150, 250)),
                                      ((600, 610), (640, 600), (700, 596), (760, 606)))):
        ribbon(f'track{i}', cubic(a, b, c, d, 30), 4.5, 0.004, M['mud'] if maq else M['dg'])

    # scattered dry grass clumps and stones on the vacant land, chaparral shrubs on the hills
    def free(x, y):
        if in_poly(x, y, HILLS) or in_rect(x, y, PARK, 4):
            return False
        if any(in_rect(x, y, r, 3) for r in SIDEWALKS) or any(in_rect(x, y, r, 4) for r in LOTS):
            return False
        return not any(in_rect(x, y, (bx, by, bw, bh), 22) for (bx, by, bw, bh, _) in BUILDINGS)
    clump_pts, stone_pts, shrub_pts = [], [], []
    while len(clump_pts) < 2600:
        x, y = rnd.random() * MAP_W, rnd.random() * MAP_H
        if free(x, y):
            clump_pts.append((x, y))
    while len(stone_pts) < 260:
        x, y = rnd.random() * MAP_W, rnd.random() * MAP_H
        if free(x, y) or in_poly(x, y, HILLS):
            stone_pts.append((x, y))
    tries = 0
    while len(shrub_pts) < 1400 and tries < 20000:
        tries += 1
        x, y = 560 + rnd.random() * 440, rnd.random() * 290
        if in_poly(x, y, HILLS) and in_poly(x + 6, y + 6, HILLS):
            shrub_pts.append((x, y))
    # grass clump: a tuft of thin cones
    bpy.ops.mesh.primitive_cone_add(vertices=5, radius1=0.09, radius2=0.0, depth=0.5, location=(0, 0, 0.25))
    tuft = bpy.context.active_object
    tuft.data.materials.append(M['grassClump'])
    for j in range(4):
        bpy.ops.mesh.primitive_cone_add(vertices=5, radius1=0.07, radius2=0.0, depth=0.42,
                                        location=(math.cos(j * 1.6) * 0.12, math.sin(j * 1.6) * 0.12, 0.2),
                                        rotation=(math.cos(j * 1.6) * 0.35, math.sin(j * 1.6) * 0.35, 0))
        o = bpy.context.active_object
        o.data.materials.append(M['grassClump'])
        o.select_set(True)
    tuft.select_set(True)
    bpy.context.view_layer.objects.active = tuft
    bpy.ops.object.join()
    tuft.scale = (2.2, 2.2, 1.6)
    scatter('clumps', tuft, clump_pts, 0.0)
    stone = bs.blob('stoneProto', (0, 0, 0.05), 0.28, M['rock'], 3)
    scatter('stones', stone, stone_pts, 0.0)
    for k, (n0, n1, r) in enumerate(((0, 500, 0.9), (500, 1000, 1.3), (1000, 1400, 0.65))):
        bush = bs.blob(f'bush{k}', (0, 0, r * 0.45), r, M['shrub'], k + 2)
        bush.scale = (1, 1, 0.7)
        scatter(f'bushes{k}', bush, shrub_pts[n0:n1], 0.0)

def park_cars(look, maq):
    """Modern cars in about two thirds of the stalls of the big lot, noses in."""
    VM = vehicles.vmats(night=(look == 'night'), maq=maq)
    rnd = random.Random(11)
    models = ['sedanW', 'suvS', 'sedanK', 'pickup', 'suvB', 'sedanR', 'sedanW', 'suvS']
    for row_y, rot in ((502, math.pi / 2), (570, -math.pi / 2)):
        for k in range(9):
            if (row_y == 502 and k == 0) or rnd.random() > 0.68:
                continue
            cx = 607 + 14 * k + (rnd.random() - 0.5) * 1.2
            vehicles.build(models[(k * 3 + row_y) % len(models)], VM, loc=P(cx, row_y + (rnd.random() - 0.5) * 1.5), rot=rot + (rnd.random() - 0.5) * 0.05)

# ------------------------------------------------------------------ camera, lights, render
def setup(look):
    v = bs.VARIANT[look]
    bs.BOX_W, bs.BOX_H = FW, FH
    bs.setup_render(v)
    sc = bpy.context.scene
    sc.render.resolution_x = int(FW * SCALE)
    sc.render.resolution_y = int(FH * SCALE)
    sc.cycles.samples = SAMPLES
    st = sc.render.image_settings
    st.file_format = 'PNG'
    st.color_mode = 'RGBA'
    bs.setup_world(v)
    cd = bpy.data.cameras.new('iso')
    cd.type = 'ORTHO'
    cd.ortho_scale = FW / (4 * 1.2247449)
    cd.clip_end = 2000
    cam = bs.add_obj('iso', cd)
    # map point under the frame centre: sx = OX + .866(x - y), sy = OY + .5(x + y)
    cxv, cyv = FX + FW / 2, FY + FH / 2
    d_xy = (cxv - OX) / 0.8660254
    s_xy = 2 * (cyv - OY)
    mx, my = (s_xy + d_xy) / 2, (s_xy - d_xy) / 2
    tx, ty, _ = P(mx, my)
    d = 600
    cam.location = (tx + d * 0.57735, ty - d * 0.57735, d * 0.57735)
    cam.rotation_euler = (math.radians(54.7356), 0, math.radians(45))
    sc.camera = cam
    scol, sstr, sdir, sang = v['sun']
    bs.light('SUN', 'sun', (0, 0, 50), sstr, scol, source=sdir, angle=sang)
    # the plate sits under brighter sprites; lift it so the ground reads as daylight, not shadow
    sc.view_settings.exposure = v['exposure'] + {'dusk': 0.55, 'night': 0.35, 'maquette': 0.1}.get(look, 0.3)
    return v

def main():
    os.makedirs(OUT, exist_ok=True)
    for look in LOOKS:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        setup(look)
        maq = look == 'maquette'
        M = materials(GP['maq' if maq else 'real'], maq)
        build(M, maq)
        park_cars(look, maq)
        png = os.path.join(OUT, f'ground_{look}.png')
        bpy.context.scene.render.filepath = png
        print(f'[ground] rendering {look} -> {png}', flush=True)
        bpy.ops.render.render(write_still=True)
        for suffix, extra in (('', []), ('_lite', ['-resize', str(int(FW * 1.1)), '0'])):
            webp = os.path.join(OUT, f'ground_{look}{suffix}.webp')
            subprocess.run(['cwebp', '-quiet', '-q', '80' if not suffix else '74', *extra, png, '-o', webp], check=True)
            print(f'[ground] wrote {webp} ({os.path.getsize(webp) // 1024} KB)', flush=True)
        os.remove(png)
    print('[ground] all done', flush=True)

main()
