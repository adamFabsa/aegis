"""
Lantern building sprites.

Builds every Lantern building kind procedurally in Blender and renders isometric
sprites that line up 1:1 with the web town view:
  * sprite box 520 x 380 (SVG units), footprint centre at (220, 220)
  * 1 m = 4 SVG units, true isometric camera (same projection as the SVG ground plane)

Usage (from the repo root):
  blender -b -P blender/build_sprites.py -- \
      --kinds senior,apartments,office,shelter,homes \
      --variants night,dusk,maquette,burning,gutted,lost \
      --scale 2 --samples 64 --format webp

Output: web/public/sprites/<kind>_<variant>.<ext>  (transparent, shadows baked in)
"""
import bpy, math, random, sys, os
from mathutils import Vector

# ------------------------------------------------------------------ args
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(name, default):
    return argv[argv.index(name) + 1] if name in argv else default

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KINDS = arg('--kinds', 'senior,apartments,office,shelter,homes').split(',')
VARIANTS = arg('--variants', 'night,dusk,maquette,burning,gutted,lost').split(',')
SCALE = float(arg('--scale', '2'))
SAMPLES = int(arg('--samples', '64'))
FMT = arg('--format', 'webp').lower()
# view rotations to render: 0 is the original camera, 1..3 turn the town 90 degrees at a time
ROTS = [int(r) for r in arg('--rots', '0').split(',')]
ROTS_ALL = (0, 1, 2, 3)
OUT = arg('--out', os.path.join(ROOT, 'web', 'public', 'sprites'))
os.makedirs(OUT, exist_ok=True)

# Sprite frame in SVG units; must match SPRITE_BOX in web/src/town/scene.ts.
# The footprint centre is left of / below the frame centre so long shadows (which fall
# toward +x, i.e. right/down on screen) are not clipped.
BOX_W, BOX_H = 520, 380
ANCHOR_X, ANCHOR_Y = 220, 220

# ------------------------------------------------------------------ palettes
BASE = dict(stucco='#E6D2B5', stucco2='#EDE6D8', house2='#CFCBB2', civic='#D3CEC2', stone='#9C8B78',
            trim='#F2EBDD', roof='#8F8A82', metal='#3B3F45', metalL='#B8BCC2', concrete='#B9B3A8',
            asphalt='#2C2D30', grass='#4E6B2E', foliage='#3F6A2A', palm='#6B8A3A', euc='#6F8D72', bark='#CFC6B4', trunk='#4A3626', van='#F2F2EF',
            amber='#F2A93B', glass='#1C2A36', cw='#4E7088', solar='#14243A', canopy='#4A4038',
            tile='#B85E36', awning='#2F6B5E', green='#4C6B33', deck='#8E6A48', sign='#3DD68C',
            spandrel='#20272E', wood='#6B4A32', car1='#8C2F2F', car2='#2F4C7A')
CHAR = dict(stucco='#4A423D', stucco2='#463F3A', house2='#433C37', civic='#433D39', stone='#2E2926',
            trim='#57504A', roof='#26211F', metal='#1F1B19', metalL='#3A3431', concrete='#4A443F',
            asphalt='#242120', grass='#3A332E', foliage='#2A2522', palm='#2A2522', euc='#2A2522', bark='#3A3430', trunk='#151110', van='#2A2523',
            amber='#3A2A20', glass='#050505', cw='#0A0A0A', solar='#0F0E0E', canopy='#1A1614',
            tile='#2E2624', awning='#221D1B', green='#2A2420', deck='#1E1917', sign='#2A2522',
            spandrel='#121010', wood='#1A1513', car1='#221C1A', car2='#1E1A19')
# collapsed ruins: ash-gray broken concrete and soot, lighter than the still-burning char
ASH = dict(CHAR, stucco='#5E5650', stucco2='#5A534D', house2='#58514B', civic='#5C5550', stone='#4E4843',
           trim='#6E665F', roof='#3E3834', concrete='#6E6660', grass='#3E3833')
MAQ = dict(stucco='#F2F0EB', stucco2='#EEEBE4', house2='#EAE6DD', civic='#F0EEE9', stone='#E4E0D8',
           trim='#FFFFFF', roof='#E9E6E0', metal='#D8D4CC', metalL='#E6E3DC', concrete='#ECE7DD',
           asphalt='#DDD6C8', grass='#D9BF92', foliage='#F4F2EE', palm='#EFECE5', euc='#F1EFEA', bark='#E6E0D4', trunk='#D7C9AE', van='#FFFFFF',
           amber='#E0D8C8', glass='#B4C3CA', cw='#BFCDD3', solar='#AAB6BE', canopy='#E2DED6',
           tile='#E8E2D6', awning='#E0D9CC', green='#D8DCCB', deck='#DCC7A5', sign='#B9CDBE',
           spandrel='#E6E2DA', wood='#D9C9AC', car1='#FFFFFF', car2='#F2EFE9')

MOON = (-0.8, -0.6, 1.0)
VARIANT = {
    'night':    dict(pal=BASE, lit=0.55, lit_col='#FFB46B', lit_str=7.0, lobby=5.0, lamps=True, fire_glow=800,
                     sun=('#9FB4FF', 1.4, MOON, 1.5), sky=('#0A1020', '#2E3A58', 1.6), exposure=0.5),
    'dusk':     dict(pal=BASE, lit=0.2, lit_col='#FFC98A', lit_str=1.6, lobby=1.0, lamps=False, fire_glow=0,
                     sun=('#FFC28A', 4.5, (-1.0, -0.35, 0.5), 1.5), sky=('#5D7FA8', '#F2B37E', 1.2), exposure=0.0),
    'maquette': dict(pal=MAQ, lit=0.0, lit_col='#FFFFFF', lit_str=0.0, lobby=0.0, lamps=False, fire_glow=0,
                     sun=('#FFFFFF', 3.2, MOON, 8.0), sky=('#DDE2E8', '#F4F1EC', 1.1), exposure=0.25),
    'burning':  dict(pal=BASE, lit=0.85, lit_col='#FF6A1F', lit_str=6.0, lobby=5.0, lamps=False, fire_glow=0,
                     sun=('#9FB4FF', 1.2, MOON, 1.5), sky=('#0A0C14', '#3A2420', 1.4), exposure=0.0, roof_fire=True),
    # fire damage stages: gutted (still burning, roof corner caved in, windows blown) and lost (collapsed)
    'gutted':   dict(pal=CHAR, lit=0.9, lit_col='#FF5A1F', lit_str=9.0, lobby=7.0, lamps=False, fire_glow=0,
                     sun=('#9FB4FF', 1.6, MOON, 1.5), sky=('#0A0C14', '#3A2420', 1.4), exposure=0.75, roof_fire=True, damage='gutted'),
    'lost':     dict(pal=ASH, lit=0.0, lit_col='#FF5A1F', lit_str=0.0, lobby=0.0, lamps=False, fire_glow=0,
                     sun=('#C4CCE0', 4.2, MOON, 1.5), sky=('#0C0E14', '#3A3430', 2.0), exposure=1.1, embers=True, damage='ruin'),
}

# ------------------------------------------------------------------ low-level helpers
def lin(hexstr, a=1.0):
    h = hexstr.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    c = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return (c[0], c[1], c[2], a)

def scale_col(c, f):
    return (min(c[0] * f, 1), min(c[1] * f, 1), min(c[2] * f, 1), 1)

def link(nt, a, b):
    nt.links.new(a, b)

def setin(node, name, val):
    if name in node.inputs:
        node.inputs[name].default_value = val

def mix_rgb(nt, fac, a, b):
    n = nt.nodes.new('ShaderNodeMix')
    n.data_type = 'RGBA'
    ins = [s for s in n.inputs if s.type == 'RGBA']
    if isinstance(fac, (int, float)):
        n.inputs[0].default_value = fac
    else:
        link(nt, fac, n.inputs[0])
    for sock, val in ((ins[0], a), (ins[1], b)):
        if isinstance(val, tuple):
            sock.default_value = val
        else:
            link(nt, val, sock)
    return [s for s in n.outputs if s.type == 'RGBA'][0]

def make_mat(name, color, rough=0.6, metal=0.0, spec=0.5, emit=None, estr=0.0, trans=0.0,
             noise=0.0, nscale=18.0, bump=0.0, bscale=220.0, grime=0.0, brick=None, coat=0.0, wave=None,
             streaks=0.0, emit_var=False):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    nt = m.node_tree
    bsdf = nt.nodes.get('Principled BSDF') or nt.nodes.new('ShaderNodeBsdfPrincipled')
    base = lin(color) if isinstance(color, str) else color
    col = base
    height = None
    if brick:
        b = nt.nodes.new('ShaderNodeTexBrick')
        tc = nt.nodes.new('ShaderNodeTexCoord')
        link(nt, tc.outputs['Object'], b.inputs['Vector'])
        setin(b, 'Color1', base)
        setin(b, 'Color2', scale_col(base, 1.35))
        setin(b, 'Mortar', lin('#9AA4B2'))
        setin(b, 'Scale', brick)
        setin(b, 'Mortar Size', 0.03)
        b.offset = 0.0
        col = b.outputs['Color']
    if wave:   # barrel roof tiles: bands across X
        tc = nt.nodes.new('ShaderNodeTexCoord')
        wv = nt.nodes.new('ShaderNodeTexWave')
        wv.wave_type = 'BANDS'
        try:
            wv.bands_direction = 'X'
        except Exception:
            pass
        link(nt, tc.outputs['Object'], wv.inputs['Vector'])
        setin(wv, 'Scale', wave)
        setin(wv, 'Distortion', 0.0)
        col = mix_rgb(nt, wv.outputs['Fac'], scale_col(base, 0.7), scale_col(base, 1.15))
        height = wv.outputs['Fac']
    if noise:
        nz = nt.nodes.new('ShaderNodeTexNoise')
        setin(nz, 'Scale', nscale)
        setin(nz, 'Detail', 6.0)
        mul = nt.nodes.new('ShaderNodeMath')
        mul.operation = 'MULTIPLY'
        link(nt, nz.outputs['Fac'], mul.inputs[0])
        mul.inputs[1].default_value = noise
        col = mix_rgb(nt, mul.outputs[0], col, scale_col(base, 0.72))
    if grime:
        geo = nt.nodes.new('ShaderNodeNewGeometry')
        sep = nt.nodes.new('ShaderNodeSeparateXYZ')
        link(nt, geo.outputs['Position'], sep.inputs[0])
        mr = nt.nodes.new('ShaderNodeMapRange')
        link(nt, sep.outputs['Z'], mr.inputs['Value'])
        mr.inputs['From Min'].default_value = 0.0
        mr.inputs['From Max'].default_value = 2.8
        mr.inputs['To Min'].default_value = grime
        mr.inputs['To Max'].default_value = 0.0
        col = mix_rgb(nt, mr.outputs['Result'], col, scale_col(base, 0.55))
    if streaks:   # rain streaks: noise stretched vertically, darkening in long drips
        tc = nt.nodes.new('ShaderNodeTexCoord')
        mp = nt.nodes.new('ShaderNodeMapping')
        link(nt, tc.outputs['Object'], mp.inputs['Vector'])
        mp.inputs['Scale'].default_value = (5.0, 5.0, 0.3)
        nz = nt.nodes.new('ShaderNodeTexNoise')
        setin(nz, 'Scale', 2.5)
        setin(nz, 'Detail', 8.0)
        link(nt, mp.outputs['Vector'], nz.inputs['Vector'])
        mr = nt.nodes.new('ShaderNodeMapRange')
        link(nt, nz.outputs['Fac'], mr.inputs['Value'])
        mr.inputs['From Min'].default_value = 0.5
        mr.inputs['From Max'].default_value = 0.8
        mr.inputs['To Min'].default_value = 0.0
        mr.inputs['To Max'].default_value = streaks
        col = mix_rgb(nt, mr.outputs['Result'], col, scale_col(base, 0.6))
    if isinstance(col, tuple):
        bsdf.inputs['Base Color'].default_value = col
    else:
        link(nt, col, bsdf.inputs['Base Color'])
    setin(bsdf, 'Roughness', rough)
    setin(bsdf, 'Metallic', metal)
    setin(bsdf, 'Specular IOR Level', spec)
    setin(bsdf, 'Coat Weight', coat)
    if trans:
        setin(bsdf, 'Transmission Weight', trans)
        setin(bsdf, 'IOR', 1.45)
    if emit:
        ecol = lin(emit) if isinstance(emit, str) else emit
        if emit_var and estr > 0:
            # lived-in rooms: brightness and colour temperature vary pane to pane, faint blinds
            tc = nt.nodes.new('ShaderNodeTexCoord')
            nz = nt.nodes.new('ShaderNodeTexNoise')
            setin(nz, 'Scale', 0.7)
            setin(nz, 'Detail', 1.0)
            link(nt, tc.outputs['Object'], nz.inputs['Vector'])
            mr = nt.nodes.new('ShaderNodeMapRange')
            link(nt, nz.outputs['Fac'], mr.inputs['Value'])
            mr.inputs['From Min'].default_value = 0.3
            mr.inputs['From Max'].default_value = 0.7
            mr.inputs['To Min'].default_value = 0.3
            mr.inputs['To Max'].default_value = 1.4
            wv = nt.nodes.new('ShaderNodeTexWave')
            wv.wave_type = 'BANDS'
            try:
                wv.bands_direction = 'Z'
            except Exception:
                pass
            link(nt, tc.outputs['Object'], wv.inputs['Vector'])
            setin(wv, 'Scale', 18.0)
            wr = nt.nodes.new('ShaderNodeMapRange')
            link(nt, wv.outputs['Fac'], wr.inputs['Value'])
            wr.inputs['To Min'].default_value = 0.8
            wr.inputs['To Max'].default_value = 1.0
            m1 = nt.nodes.new('ShaderNodeMath')
            m1.operation = 'MULTIPLY'
            link(nt, mr.outputs['Result'], m1.inputs[0])
            link(nt, wr.outputs['Result'], m1.inputs[1])
            m2 = nt.nodes.new('ShaderNodeMath')
            m2.operation = 'MULTIPLY'
            link(nt, m1.outputs[0], m2.inputs[0])
            m2.inputs[1].default_value = estr
            link(nt, m2.outputs[0], bsdf.inputs['Emission Strength'])
            nz2 = nt.nodes.new('ShaderNodeTexNoise')
            setin(nz2, 'Scale', 1.9)
            setin(nz2, 'Detail', 1.0)
            link(nt, tc.outputs['Object'], nz2.inputs['Vector'])
            link(nt, mix_rgb(nt, nz2.outputs['Fac'], ecol, lin('#FFEBD0')), bsdf.inputs['Emission Color'])
        else:
            setin(bsdf, 'Emission Color', ecol)
            setin(bsdf, 'Emission Strength', estr)
    if bump and height is None:
        nz2 = nt.nodes.new('ShaderNodeTexNoise')
        setin(nz2, 'Scale', bscale)
        setin(nz2, 'Detail', 4.0)
        height = nz2.outputs['Fac']
    if bump and height is not None:
        bp = nt.nodes.new('ShaderNodeBump')
        setin(bp, 'Strength', bump)
        setin(bp, 'Distance', 0.02)
        link(nt, height, bp.inputs['Height'])
        link(nt, bp.outputs['Normal'], bsdf.inputs['Normal'])
    return m

def add_obj(name, data):
    o = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(o)
    return o

def mesh_obj(name, v, f, mat, bevel=0.0, solidify=0.0):
    me = bpy.data.meshes.new(name)
    me.from_pydata(v, [], f)
    me.update()
    o = add_obj(name, me)
    me.materials.append(mat)
    if solidify:
        s = o.modifiers.new('solid', 'SOLIDIFY')
        s.thickness = solidify
    if bevel:
        m = o.modifiers.new('bevel', 'BEVEL')
        m.width = bevel
        m.segments = 2
        m.limit_method = 'ANGLE'
    return o

def boxes(name, bxs, mat, bevel=0.0):
    """One mesh object from many axis-aligned boxes (x0, x1, y0, y1, z0, z1)."""
    if not bxs:
        return None
    v, f = [], []
    for (x0, x1, y0, y1, z0, z1) in bxs:
        b = len(v)
        v += [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
              (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
        f += [(b, b + 3, b + 2, b + 1), (b + 4, b + 5, b + 6, b + 7), (b, b + 1, b + 5, b + 4),
              (b + 1, b + 2, b + 6, b + 5), (b + 2, b + 3, b + 7, b + 6), (b + 3, b, b + 4, b + 7)]
    return mesh_obj(name, v, f, mat, bevel)

def cylinder(name, x, y, z0, z1, r, mat, verts=20):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=(z1 - z0), location=(x, y, (z0 + z1) / 2))
    o = bpy.context.active_object
    o.name = name
    o.data.materials.append(mat)
    return o

def ring(name, x, y, z, R, r, mat):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, location=(x, y, z), major_segments=48, minor_segments=8)
    o = bpy.context.active_object
    o.name = name
    o.scale = (1, 1, 0.3)
    o.data.materials.append(mat)
    return o

def blob(name, loc, r, mat, seed):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=r, location=loc)
    o = bpy.context.active_object
    o.name = name
    tex = bpy.data.textures.new(name + '_tex', 'CLOUDS')
    tex.noise_scale = 0.6
    d = o.modifiers.new('disp', 'DISPLACE')
    d.texture = tex
    d.strength = r * 0.35
    o.data.materials.append(mat)
    o.rotation_euler = (seed * 0.7, seed * 1.3, seed * 2.1)
    bpy.ops.object.shade_smooth()
    return o

def text(name, body, loc, rot, size, mat, align='CENTER'):
    cu = bpy.data.curves.new(name, 'FONT')
    cu.body = body
    cu.size = size
    cu.extrude = 0.02
    cu.align_x = align
    o = add_obj(name, cu)
    o.location = loc
    o.rotation_euler = rot
    cu.materials.append(mat)
    return o

def light(kind, name, loc, power, color, size=0.5, toward=None, source=None, angle=2.0, shadow=None):
    ld = bpy.data.lights.new(name, kind)
    ld.energy = power
    ld.color = lin(color)[:3]
    if shadow is None:
        shadow = (kind == 'SUN')
    try:
        ld.use_shadow = shadow
    except Exception:
        pass
    o = add_obj(name, ld)
    o.location = loc
    if kind == 'SUN':
        ld.angle = math.radians(angle)
        o.rotation_euler = Vector(source).normalized().to_track_quat('Z', 'Y').to_euler()
    elif kind == 'AREA':
        ld.size = size
        o.rotation_euler = (-(Vector(toward) - Vector(loc))).to_track_quat('Z', 'Y').to_euler()
    else:
        ld.shadow_soft_size = size
    return o

# ------------------------------------------------------------------ scene setup
def setup_render(v):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for dv in prefs.devices:
            dv.use = True
        sc.cycles.device = 'GPU'
    except Exception as e:
        print('GPU setup failed, using CPU:', e)
    sc.cycles.samples = SAMPLES
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.use_denoising = True
    try:
        sc.cycles.denoiser = 'OPENIMAGEDENOISE'
    except Exception:
        pass
    sc.cycles.max_bounces = 8
    sc.render.film_transparent = True
    sc.render.resolution_x = int(BOX_W * SCALE)
    sc.render.resolution_y = int(BOX_H * SCALE)
    sc.render.resolution_percentage = 100
    st = sc.render.image_settings
    if FMT == 'webp':
        st.file_format = 'WEBP'
        st.quality = 90
    else:
        st.file_format = 'PNG'
    st.color_mode = 'RGBA'
    try:
        sc.view_settings.view_transform = 'AgX'
        sc.view_settings.look = 'AgX - Punchy'
    except Exception:
        pass
    sc.view_settings.exposure = v['exposure']

def setup_camera():
    cd = bpy.data.cameras.new('iso')
    cd.type = 'ORTHO'
    cd.ortho_scale = BOX_W / (4 * 1.2247449)        # 1 m = 4 SVG units in a true-iso projection
    cd.shift_x = (BOX_W / 2 - ANCHOR_X) / BOX_W       # footprint centre sits at the anchor, not the frame centre
    cd.shift_y = (ANCHOR_Y - BOX_H / 2) / BOX_W
    cd.clip_end = 1000
    c = add_obj('iso', cd)
    d = 120
    c.location = (d * 0.57735, -d * 0.57735, d * 0.57735)
    c.rotation_euler = (math.radians(54.7356), 0, math.radians(45))
    bpy.context.scene.camera = c

def setup_world(v):
    w = bpy.data.worlds.new('sky')
    bpy.context.scene.world = w
    try:
        w.use_nodes = True
    except Exception:
        pass
    nt = w.node_tree
    bg = nt.nodes.get('Background') or nt.nodes.new('ShaderNodeBackground')
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    link(nt, tc.outputs['Generated'], sep.inputs[0])
    mr = nt.nodes.new('ShaderNodeMapRange')
    link(nt, sep.outputs['Z'], mr.inputs['Value'])
    mr.inputs['From Min'].default_value = -0.05
    mr.inputs['From Max'].default_value = 0.6
    zen, hor, strength = v['sky']
    link(nt, mix_rgb(nt, mr.outputs['Result'], lin(hor), lin(zen)), bg.inputs['Color'])
    bg.inputs['Strength'].default_value = strength

# ------------------------------------------------------------------ shared building context
class Ctx:
    def __init__(self, v):
        self.v = v
        self.p = v['pal']
        self.lost = v.get('damage') is not None
        self.maq = v is VARIANT['maquette']
        self.rnd = random.Random(12)
        p, lamps = self.p, v['lamps']
        on = (lambda s: s if lamps else 0.0)
        grime = 0.0 if (self.lost or self.maq) else 0.45
        streak = 0.0 if self.maq else 0.5
        self.M = dict(
            stucco=make_mat('stucco', p['stucco'], rough=0.88, noise=0.35, nscale=6, bump=0.25, grime=grime, streaks=streak),
            stucco2=make_mat('stucco2', p['stucco2'], rough=0.85, noise=0.3, nscale=6, bump=0.25, grime=grime, streaks=streak),
            house2=make_mat('house2', p['house2'], rough=0.88, noise=0.35, nscale=6, bump=0.25, grime=grime * 0.7, streaks=streak * 0.7),
            civic=make_mat('civic', p['civic'], rough=0.85, noise=0.3, nscale=10, bump=0.2, grime=grime * 0.6, streaks=streak * 0.8),
            stone=make_mat('stone', p['stone'], rough=0.8, noise=0.5, nscale=30, bump=0.35, bscale=90),
            trim=make_mat('trim', p['trim'], rough=0.55, noise=0.15, nscale=12),
            roof=make_mat('roof', p['roof'], rough=0.95, noise=0.6, nscale=40, bump=0.4, bscale=300),
            metal=make_mat('metal', p['metal'], rough=0.35 if not self.maq else 0.6, metal=0.0 if self.maq else 0.8),
            metalL=make_mat('metalL', p['metalL'], rough=0.4 if not self.maq else 0.6, metal=0.0 if self.maq else 0.6),
            concrete=make_mat('concrete', p['concrete'], rough=0.9, noise=0.4, nscale=25, bump=0.2),
            asphalt=make_mat('asphalt', p['asphalt'], rough=0.95, noise=0.4, nscale=60, bump=0.3, bscale=400),
            grass=make_mat('grass', p['grass'], rough=0.95, noise=0.7 if not self.maq else 0.15, nscale=3, bump=0.5, bscale=500),
            foliage=make_mat('foliage', p['foliage'], rough=0.8, noise=0.6 if not self.maq else 0.1, nscale=4),
            trunk=make_mat('trunk', p['trunk'], rough=0.9),
            van=make_mat('van', p['van'], rough=0.25, coat=0.6),
            car1=make_mat('car1', p['car1'], rough=0.25, coat=0.7),
            car2=make_mat('car2', p['car2'], rough=0.25, coat=0.7),
            amber=make_mat('amber', p['amber'], rough=0.4),
            glass=make_mat('glass', p['glass'], rough=0.04 if not self.lost else 0.9, spec=0.9),
            cw=make_mat('cw', p['cw'], rough=0.06 if not self.lost else 0.9, metal=0.1, spec=0.8),
            solar=make_mat('solar', p['solar'], rough=0.12, spec=0.9, brick=1.6),
            canopy=make_mat('canopy', p['canopy'], rough=0.4, metal=0.7),
            tile=make_mat('tile', p['tile'], rough=0.7, noise=0.3, nscale=8, wave=6.0, bump=0.4),
            tileFlat=make_mat('tileFlat', p['tile'], rough=0.75, noise=0.4, nscale=14, bump=0.3, bscale=120),
            awning=make_mat('awning', p['awning'], rough=0.8),
            green=make_mat('green', p['green'], rough=0.9, noise=0.6, nscale=5, bump=0.4),
            deck=make_mat('deck', p['deck'], rough=0.7, brick=3.0),
            wood=make_mat('wood', p['wood'], rough=0.6),
            spandrel=make_mat('spandrel', p['spandrel'], rough=0.4 if not self.maq else 0.7, metal=0.0 if self.maq else 0.5),
            rail=make_mat('rail', '#DCEBF2', rough=0.02, trans=1.0),
            lit1=make_mat('lit1', p['glass'], rough=0.05, emit=v['lit_col'], estr=v['lit_str'], emit_var=True),
            lit2=make_mat('lit2', p['glass'], rough=0.05, emit='#FFE0B0' if not v.get('roof_fire') else '#FF8A3D', estr=v['lit_str'] * 0.55, emit_var=True),
            lobby=make_mat('lobby', p['glass'], rough=0.05, emit='#FFD49A' if not v.get('roof_fire') else '#FF7A2E', estr=v['lobby'], emit_var=True),
            strip=make_mat('strip', '#FFE2B8', rough=0.5, emit='#FFE2B8', estr=on(6.0)),
            beacon=make_mat('beacon', '#F2A93B', rough=0.4, emit='#F2A93B', estr=on(8.0)),
            head=make_mat('head', '#FFF4D8', rough=0.2, emit='#FFF4D8', estr=on(10.0)),
            tail=make_mat('tail', '#C0262B', rough=0.3, emit='#FF2A2A', estr=on(4.0)),
            sign=make_mat('sign', p['trim'], rough=0.4, emit='#FFF1D6', estr=on(4.0)),
            signGreen=make_mat('signGreen', p['sign'], rough=0.4, emit=p['sign'],
                               estr=(3.0 if lamps else (0.6 if v is VARIANT['dusk'] else 0.0))),
            ink=make_mat('ink', '#0B0F17', rough=0.5),
            red=make_mat('red', '#FF3B30', rough=0.3, emit='#FF3B30', estr=0.0 if (self.lost or self.maq) else 6.0),
            tire=make_mat('tire', '#141414', rough=0.8),
            leaf=make_mat('leaf', p['foliage'], rough=0.75, noise=0.0 if self.maq else 0.75, nscale=3, bump=0.9, bscale=45),
            palmLeaf=make_mat('palmLeaf', p['palm'], rough=0.6, noise=0.0 if self.maq else 0.5, nscale=6, bump=0.4, bscale=80),
            palmTrunk=make_mat('palmTrunk', p['trunk'], rough=0.9, noise=0.4, nscale=12, bump=0.6, bscale=30),
            pavers=make_mat('pavers', p['concrete'], rough=0.85, brick=2.4, bump=0.2),
            reveal=make_mat('reveal', scale_col(lin(p['stucco']), 0.62), rough=0.9),
            sconce=make_mat('sconce', '#FFE2B8', rough=0.4, emit='#FFD9A0', estr=on(9.0)),
        )
        self.reset_lists()
        self.fire_spots = []
        self.openings = []   # every window/door pane box, so damage can cut real openings

    def reset_lists(self):
        self.trim, self.glass, self.lit1, self.lit2, self.lobby, self.metal, self.rail = [], [], [], [], [], [], []

    def pane(self, box):
        r = self.rnd.random()
        lit = self.v['lit']
        (self.lit1 if r < lit * 0.65 else self.lit2 if r < lit else self.glass).append(box)

    def win_front(self, cx, hd, zb, zt, half=0.95, sill=True, mullion=True):
        """Window on the front face (y = -hd); the frame protrudes toward -y."""
        self.pane((cx - half, cx + half, -hd - 0.03, -hd + 0.01, zb, zt))
        self.trim += [(cx - half - 0.15, cx + half + 0.15, -hd - 0.16, -hd, zt, zt + 0.15),
                      (cx - half - 0.15, cx - half, -hd - 0.16, -hd, zb, zt),
                      (cx + half, cx + half + 0.15, -hd - 0.16, -hd, zb, zt)]
        if sill:
            self.trim.append((cx - half - 0.25, cx + half + 0.25, -hd - 0.22, -hd, zb - 0.13, zb))
        if mullion:
            self.metal.append((cx - 0.04, cx + 0.04, -hd - 0.08, -hd, zb, zt))

    def win_side(self, cy, hw, zb, zt, half=0.95, sill=True, mullion=True):
        """Window on the side face (x = +hw); the frame protrudes toward +x."""
        self.pane((hw - 0.01, hw + 0.03, cy - half, cy + half, zb, zt))
        self.trim += [(hw, hw + 0.16, cy - half - 0.15, cy + half + 0.15, zt, zt + 0.15),
                      (hw, hw + 0.16, cy - half - 0.15, cy - half, zb, zt),
                      (hw, hw + 0.16, cy + half, cy + half + 0.15, zb, zt)]
        if sill:
            self.trim.append((hw, hw + 0.24, cy - half - 0.25, cy + half + 0.25, zb - 0.13, zb))
        if mullion:
            self.metal.append((hw, hw + 0.08, cy - 0.04, cy + 0.04, zb, zt))

    def balcony_front(self, cx, hd, z0, width, depth=1.3):
        bx0, bx1 = cx - width / 2, cx + width / 2
        self.trim.append((bx0, bx1, -hd - depth, -hd, z0 - 0.05, z0 + 0.2))
        if not self.lost:
            self.rail += [(bx0 + 0.05, bx1 - 0.05, -hd - depth + 0.03, -hd - depth + 0.07, z0 + 0.2, z0 + 1.12),
                          (bx0 + 0.02, bx0 + 0.06, -hd - depth + 0.03, -hd, z0 + 0.2, z0 + 1.12),
                          (bx1 - 0.06, bx1 - 0.02, -hd - depth + 0.03, -hd, z0 + 0.2, z0 + 1.12)]
            self.metal.append((bx0, bx1, -hd - depth - 0.01, -hd - depth + 0.11, z0 + 1.1, z0 + 1.17))
        else:
            self.metal.append((bx0, bx0 + 0.6, -hd - depth - 0.01, -hd - depth + 0.11, z0 + 0.6, z0 + 0.66))

    def glazing_front(self, x0, x1, hd, zb, zt, n):
        self.lobby.append((x0, x1, -hd - 0.03, -hd + 0.01, zb, zt))
        for k in range(n + 1):
            x = x0 + (x1 - x0) * k / n
            self.metal.append((x - 0.05, x + 0.05, -hd - 0.1, -hd, zb, zt))
        self.metal.append((x0, x1, -hd - 0.1, -hd, zb - 0.05, zb + 0.05))

    def glazing_side(self, y0, y1, hw, zb, zt, n):
        self.lobby.append((hw - 0.01, hw + 0.03, y0, y1, zb, zt))
        for k in range(n + 1):
            y = y0 + (y1 - y0) * k / n
            self.metal.append((hw, hw + 0.1, y - 0.05, y + 0.05, zb, zt))

    def flush(self):
        M = self.M
        self.openings += self.lit1 + self.lit2 + self.glass + self.lobby
        boxes('trim', self.trim, M['trim'], bevel=0.015)
        boxes('glass', self.glass, M['glass'])
        boxes('lit1', self.lit1, M['lit1'])
        boxes('lit2', self.lit2, M['lit2'])
        boxes('lobby', self.lobby, M['lobby'])
        boxes('metal', self.metal, M['metal'])
        boxes('rail', self.rail, M['rail'])
        self.reset_lists()

    # ---- shared site pieces
    def ground(self, W, D, apron=True):
        M = self.M
        c = boxes('catcher', [(-120, 120, -120, 120, -0.02, -0.001)], M['concrete'])
        c.is_shadow_catcher = True
        boxes('lawn', [(-W / 2 - 4, W / 2 + 4, -D / 2 - 4, D / 2 + 4, 0, 0.02)], M['grass'])
        if apron:
            boxes('apron', [(-W / 2 - 1.25, W / 2 + 1.25, -D / 2 - 1.25, D / 2 + 1.25, 0, 0.04)], M['pavers'])

    def sconces(self, xs, hd, z):
        """Wall lights along the front face; at night they wash the facade and the sidewalk."""
        boxes('sconces', [(x - 0.13, x + 0.13, -hd - 0.16, -hd, z, z + 0.32) for x in xs], self.M['sconce'])
        if self.v['lamps']:
            for x in xs:
                light('POINT', 'sconce', (x, -hd - 0.45, z - 0.1), 45, '#FFC98A', size=0.12)

    def reveals(self, W, D, floors, FH):
        """Recessed floor-line grooves on the two visible faces."""
        hw, hd = W / 2, D / 2
        bx = []
        for f in range(1, floors):
            z = f * FH
            bx += [(-hw - 0.02, hw + 0.02, -hd - 0.02, -hd + 0.01, z - 0.05, z + 0.05), (hw - 0.01, hw + 0.02, -hd - 0.02, hd + 0.02, z - 0.05, z + 0.05)]
        boxes('reveals', bx, self.M['reveal'])

    def roof_clutter(self, x0, x1, y0, y1, z, n):
        """Vents, stacks and conduit runs so flat roofs do not read as empty planes."""
        r = random.Random(77)
        M = self.M
        for _ in range(n):
            x = x0 + r.random() * (x1 - x0)
            y = y0 + r.random() * (y1 - y0)
            cylinder('vent', x, y, z, z + 0.35 + r.random() * 0.5, 0.12 + r.random() * 0.1, M['metalL'], verts=12)
        runs = [(x0, x1, y0 + 0.4, y0 + 0.55, z, z + 0.15), (x0 + 0.5, x0 + 0.65, y0, y1, z, z + 0.15)]
        boxes('conduit', runs, M['metal'])

    def tree(self, x, y, s, k):
        M = self.M
        cylinder('trunk', x, y, 0.0, 3.2 * s, 0.22 * s, M['trunk'], verts=10)
        if self.lost:
            blob('crown', (x, y, 4.0 * s), 1.1 * s, M['trunk'], k)
            return
        blob('crown', (x, y, 4.2 * s), 2.0 * s, M['foliage'], k)
        blob('crown', (x + 0.9 * s, y - 0.6 * s, 3.6 * s), 1.4 * s, M['foliage'], k + 10)
        blob('crown', (x - 0.8 * s, y + 0.5 * s, 5.0 * s), 1.3 * s, M['foliage'], k + 20)

    def shrub(self, x, y, r, k, z=None):
        o = blob('shrub', (x, y, r * 0.8 if z is None else z), r, self.M['foliage'] if not self.lost else self.M['trunk'], k)
        return o

    def lamp_post(self, x, y):
        M = self.M
        cylinder('pole', x, y, 0.0, 4.6, 0.07, M['metal'], verts=10)
        boxes('lampHead', [(x - 0.35, x + 0.35, y - 0.18, y + 0.18, 4.55, 4.75)], M['metal'])
        boxes('lampLens', [(x - 0.3, x + 0.3, y - 0.14, y + 0.14, 4.52, 4.56)], M['strip'])
        if self.v['lamps']:
            light('POINT', 'lamp', (x, y, 4.4), 260, '#FFC98A', size=0.25)

    def van(self, x0, y0):
        M = self.M
        x1, y1 = x0 + 6.0, y0 + 2.2
        boxes('van', [(x0, x1, y0, y1, 0.35, 2.6)], M['van'], bevel=0.22)
        boxes('vanglass', [(x0 + 1.0, x0 + 4.8, y0 - 0.03, y0 + 0.05, 1.5, 2.25), (x1 - 0.05, x1 + 0.04, y0 + 0.15, y1 - 0.15, 1.45, 2.3),
                           (x0 + 1.0, x0 + 4.8, y1 - 0.05, y1 + 0.03, 1.5, 2.25)], M['glass'])
        boxes('vanstripe', [(x0, x1, y0 - 0.02, y0 + 0.02, 1.05, 1.28), (x1 - 0.02, x1 + 0.03, y0 + 0.1, y1 - 0.1, 1.05, 1.28)], M['amber'])
        boxes('beacon', [(x0 + 2.4, x0 + 3.6, y0 + 0.6, y0 + 1.6, 2.6, 2.78)], M['beacon'])
        boxes('head', [(x1 - 0.02, x1 + 0.05, y0 + 0.2, y0 + 0.6, 0.75, 0.98), (x1 - 0.02, x1 + 0.05, y1 - 0.6, y1 - 0.2, 0.75, 0.98)], M['head'])
        boxes('tail', [(x0 - 0.05, x0 + 0.02, y0 + 0.2, y0 + 0.5, 0.8, 1.2), (x0 - 0.05, x0 + 0.02, y1 - 0.5, y1 - 0.2, 0.8, 1.2)], M['tail'])
        for wx in (x0 + 1.3, x0 + 4.8):
            for wy in (y0 + 0.05, y1 - 0.05):
                w = cylinder('wheel', wx, wy, 0.0, 0.32, 0.4, M['tire'], verts=24)
                w.rotation_euler = (math.radians(90), 0, 0)
                w.location = (wx, wy, 0.4)

    def car(self, x0, y0, mat):
        M = self.M
        boxes('carBody', [(x0, x0 + 4.4, y0, y0 + 1.9, 0.3, 1.15)], M[mat], bevel=0.25)
        boxes('carCabin', [(x0 + 1.1, x0 + 3.4, y0 + 0.15, y0 + 1.75, 1.15, 1.75)], M['glass'], bevel=0.15)
        for wx in (x0 + 0.9, x0 + 3.5):
            for wy in (y0 + 0.02, y0 + 1.88):
                w = cylinder('wheel', wx, wy, 0.0, 0.25, 0.34, M['tire'], verts=20)
                w.rotation_euler = (math.radians(90), 0, 0)
                w.location = (wx, wy, 0.34)

    def hvac(self, x0, y0, w=3.0, d=2.3, h=1.45, z=0.0):
        M = self.M
        boxes('hvac', [(x0, x0 + w, y0, y0 + d, z, z + h)], M['metalL'], bevel=0.04)
        cylinder('fan', x0 + w / 2, y0 + d / 2, z + h, z + h + 0.1, min(w, d) * 0.33, M['metal'])

    def parapet(self, W, D, H, cap=0.6, out=0.3):
        hw, hd = W / 2, D / 2
        self.trim += [(-hw - out, hw + out, -hd - out, hd + out, H - 0.35, H),
                      (-hw - out, hw + out, -hd - out, -hd + 0.05, H, H + cap), (-hw - out, hw + out, hd - 0.05, hd + out, H, H + cap),
                      (-hw - out, -hw + 0.05, -hd - out, hd + out, H, H + cap), (hw - 0.05, hw + out, -hd - out, hd + out, H, H + cap)]
        boxes('roofdeck', [(-hw + 0.05, hw - 0.05, -hd + 0.05, hd - 0.05, H - 0.36, H + 0.05)], self.M['roof'])

    def lights(self, W, D, H):
        v = self.v
        scol, sstr, sdir, sang = v['sun']
        light('SUN', 'sun', (0, 0, 50), sstr, scol, source=sdir, angle=sang)
        if v['fire_glow']:
            light('AREA', 'fireGlow', (55, 40, 10), v['fire_glow'], '#FF7A2E', size=30, toward=(0, 0, 6))
        if v.get('roof_fire'):
            spots = self.fire_spots or [(-W / 4, D / 6), (W / 4, -D / 6)]
            pw = 1800 if H > 10 else 900
            for (fx, fy) in spots:
                light('POINT', 'roofFire', (fx, fy, H + 2.5), pw, '#FF6A1F', size=2.0)
            light('AREA', 'fireGlow', (55, 40, 10), 3000, '#FF5A1F', size=30, toward=(0, 0, 6))
        if v.get('embers'):
            for k in range(7):
                ex = -W / 2 + 2 + self.rnd.random() * (W - 4)
                light('POINT', 'ember', (ex, -D / 2 + 0.6, 0.6 + self.rnd.random() * max(H - 2, 1)), 40, '#FF5A1F', size=0.4)
            light('POINT', 'ember', (0, 0, H + 0.6), 300, '#FF4A1A', size=3)

# ------------------------------------------------------------------ kinds
def build_senior(c):
    M = c.M
    W, D, FH, NF = 37.5, 18.75, 3.5, 4
    H = FH * NF
    hw, hd, BW = W / 2, D / 2, W / 8
    c.ground(W, D)
    boxes('walk', [(-3.75, 5.75, -18.4, -hd, 0, 0.06)], M['concrete'])
    boxes('drive', [(9.4, 17.6, -16.6, -hd - 1.25, 0, 0.05)], M['asphalt'])
    boxes('mass', [(-hw, hw, -hd, hd, 3.4, H - 0.35)], M['stucco'], bevel=0.03)
    boxes('plinth', [(-hw, hw, -hd, hd, 0, 3.4)], M['stone'], bevel=0.02)
    c.parapet(W, D, H)
    c.trim.append((-hw - 0.12, hw + 0.12, -hd - 0.12, hd + 0.12, 3.3, 3.55))
    for f in range(2, NF):
        c.trim.append((hw, hw + 0.1, -hd - 0.05, hd + 0.05, f * FH - 0.12, f * FH + 0.12))
    for i in range(8):
        cx = -hw + (i + 0.5) * BW
        for f in range(1, NF):
            z0 = f * FH
            c.win_front(cx, hd, z0 + 0.25, z0 + 2.65, sill=False)
            c.balcony_front(cx, hd, z0, BW - 0.5)
    for j in range(4):
        cy = -hd + (j + 0.5) * BW
        for f in range(1, NF):
            c.win_side(cy, hw, f * FH + 0.85, f * FH + 2.65)
    c.glazing_front(-16.75, -5.25, hd, 0.45, 3.0, 7)
    c.glazing_front(6.25, 16.75, hd, 0.45, 3.0, 7)
    c.lobby.append((-2.5, 3.5, -hd - 0.03, -hd + 0.01, 0.0, 3.0))
    c.metal += [(-2.6, -2.45, -hd - 0.12, -hd, 0, 3.05), (3.45, 3.6, -hd - 0.12, -hd, 0, 3.05),
                (-2.6, 3.6, -hd - 0.12, -hd, 2.95, 3.1), (0.45, 0.55, -hd - 0.1, -hd, 0, 3.0)]
    c.glazing_side(-hd + 2.0, hd - 2.0, hw, 0.45, 3.0, 5)
    c.flush()
    c.hvac(-12.75, 3.6, z=H + 0.05)
    c.hvac(-8.25, 3.6, z=H + 0.05)
    boxes('penthouse', [(6.25, 12.75, 0.4, 5.9, H, H + 2.6)], M['stucco'], bevel=0.03)
    boxes('pentcap', [(6.1, 12.9, 0.25, 6.05, H + 2.6, H + 2.78)], M['trim'])
    boxes('pentdoor', [(8.4, 9.6, 0.33, 0.41, H + 0.05, H + 2.15)], M['metal'])
    for yc in (-2.5, -5.75):
        row = boxes('solar', [(-14.25 + k * 4.6, -14.25 + k * 4.6 + 4.25, -1.35, 1.35, -0.04, 0.04) for k in range(4)], M['solar'], bevel=0.01)
        row.location = (0, yc, H + 0.7)
        row.rotation_euler = (math.radians(14), 0, 0)
        boxes('solarframe', [(-14.25 + k * 4.6 + 0.3, -14.25 + k * 4.6 + 3.95, yc - 0.9, yc + 0.9, H + 0.05, H + 0.55) for k in range(4)], M['metal'])
    boxes('canopy', [(-4.25, 5.25, -12.875, -hd, 4.0, 4.6)], M['canopy'], bevel=0.02)
    boxes('soffit', [(-4.0, 5.0, -12.6, -hd - 0.3, 3.97, 4.0)], M['strip'])
    cylinder('col1', -4.0, -12.55, 0.06, 4.0, 0.14, M['canopy'])
    cylinder('col2', 5.0, -12.55, 0.06, 4.0, 0.14, M['canopy'])
    text('sign', 'BUILDING 12', (0.5, -12.9, 4.12), (math.radians(90), 0, 0), 0.5, M['sign'])
    boxes('ramp', [(6.4, 8.9, -16.1, -hd - 0.05, 0, 0.14)], M['concrete'])
    rails = [(6.4, 6.47, -16.1, -hd, 0.95, 1.01), (8.83, 8.9, -16.1, -hd, 0.95, 1.01)]
    for yy in (-16.0, -14.0, -12.0, -10.0):
        rails += [(6.4, 6.47, yy, yy + 0.07, 0.14, 0.98), (8.83, 8.9, yy, yy + 0.07, 0.14, 0.98)]
    boxes('ramprail', rails, M['metalL'])
    c.van(10.0, -15.2)
    for k, x in enumerate((-17.5, -15.0, -12.5, -9.5, -6.8)):
        c.shrub(x, -hd - 2.0, 0.55 + 0.25 * c.rnd.random(), k)
    for k, y in enumerate((-6.5, -2.0, 2.5, 7.0)):
        c.shrub(hw + 2.2, y, 0.6 + 0.2 * c.rnd.random(), k + 10)
    for k, (tx, ty, s) in enumerate(((-21.0, -12.0, 1.0), (22.2, -9.5, 0.9), (21.5, 6.5, 1.1), (-21.5, 8.0, 0.85))):
        c.tree(tx, ty, s, k + 20)
    c.lamp_post(-20.5, -15.0)
    c.lamp_post(19.0, -17.4)
    c.sconces((-17.5, -11.0, -4.0, 5.0, 11.5, 17.5), hd, 3.05)
    c.reveals(W, D, NF, FH)
    c.roof_clutter(-16.5, 4.0, 0.5, 8.0, H + 0.05, 9)
    if c.v['lamps']:
        light('POINT', 'canopyLight', (0.5, -11.2, 3.6), 180, '#FFD49A', size=0.3)
    c.fire_spots = [(-5, -1), (5, -4), (-13, 3), (12, 2)]
    return W, D, H

def build_apartments(c):
    M = c.M
    W, D, FH, NF = 30.0, 22.5, 3.5, 5
    H = FH * NF
    hw, hd = W / 2, D / 2
    c.ground(W, D)
    boxes('walk', [(-1.6, 1.6, -hd - 4.5, -hd, 0, 0.06)], M['concrete'])
    boxes('mass', [(-hw, hw, -hd, hd, 3.4, H - 0.35)], M['stucco2'], bevel=0.03)
    boxes('plinth', [(-hw, hw, -hd, hd, 0, 3.4)], M['stone'], bevel=0.02)
    c.parapet(W, D, H)
    c.trim.append((-hw - 0.12, hw + 0.12, -hd - 0.12, hd + 0.12, 3.3, 3.55))
    boxes('stripe', [(-1.75, 1.75, -hd - 0.2, -hd, 3.4, H - 0.35)], M['tileFlat'], bevel=0.02)
    for f in range(1, NF):
        z0 = f * FH
        c.pane((-0.35, 0.35, -hd - 0.23, -hd - 0.19, z0 + 0.6, z0 + 2.9))
    bays = [-15 + 3.25 * (i + 0.5) for i in range(4)] + [2 + 3.25 * (i + 0.5) for i in range(4)]
    for i, cx in enumerate(bays):
        for f in range(1, NF):
            z0 = f * FH
            if i % 2 == 0:
                c.win_front(cx, hd, z0 + 0.25, z0 + 2.65, half=0.8, sill=False)
                c.balcony_front(cx, hd, z0, 2.9, depth=1.1)
            else:
                c.win_front(cx, hd, z0 + 0.9, z0 + 2.5, half=0.75)
    for j in range(6):
        cy = -hd + (j + 0.5) * 3.75
        for f in range(1, NF):
            c.win_side(cy, hw, f * FH + 0.9, f * FH + 2.5, half=0.8)
    c.glazing_front(-14.5, -3.0, hd, 0.35, 2.75, 6)
    c.glazing_front(3.0, 14.5, hd, 0.35, 2.75, 6)
    c.lobby.append((-1.2, 1.2, -hd - 0.25, -hd - 0.21, 0.0, 2.8))
    c.metal += [(-1.3, -1.15, -hd - 0.3, -hd - 0.2, 0, 2.9), (1.15, 1.3, -hd - 0.3, -hd - 0.2, 0, 2.9), (-1.3, 1.3, -hd - 0.3, -hd - 0.2, 2.8, 2.95)]
    c.glazing_side(-hd + 1.5, hd - 1.5, hw, 0.35, 2.75, 6)
    boxes('awning', [(-14.8, -2.7, -hd - 1.25, -hd, 2.95, 3.12), (2.7, 14.8, -hd - 1.25, -hd, 2.95, 3.12),
                     (-14.8, -2.7, -hd - 1.27, -hd - 1.2, 2.6, 3.12), (2.7, 14.8, -hd - 1.27, -hd - 1.2, 2.6, 3.12)], M['awning'], bevel=0.02)
    c.flush()
    boxes('garden', [(-12.5, -2.5, -8.75, -1.75, H, H + 0.45)], M['green'], bevel=0.05)
    for k, (gx, gy) in enumerate(((-11, -3.5), (-8.5, -7), (-5.5, -4.5), (-4, -7.5), (-10, -6))):
        c.shrub(gx, gy, 0.55, k + 50, z=H + 0.75)
    boxes('deck', [(-1.0, 6.0, -9.25, 0.25, H, H + 0.22)], M['deck'])
    boxes('deckRail', [(-1.0, 6.0, -9.3, -9.2, H + 0.22, H + 1.1), (5.95, 6.05, -9.25, 0.25, H + 0.22, H + 1.1)],
          M['rail'] if not c.lost else M['metal'])
    boxes('overrun', [(-10.5, -6.5, 3.25, 7.25, H, H + 3.0)], M['stucco2'], bevel=0.03)
    boxes('overrunCap', [(-10.65, -6.35, 3.1, 7.4, H + 3.0, H + 3.15)], M['trim'])
    c.hvac(0.0, 4.25, w=3.5, d=2.5, z=H + 0.05)
    boxes('stair', [(7.0, 12.0, -7.75, -2.25, H, H + 3.0)], M['stucco2'], bevel=0.03)
    boxes('stairDoor', [(8.8, 10.0, -7.82, -7.74, H + 0.05, H + 2.2)], M['metal'])
    boxes('stairCap', [(6.85, 12.15, -7.9, -2.1, H + 3.0, H + 3.15)], M['trim'])
    for k, x in enumerate((-13.5, -10.5, -7.5, -4.5, 4.5, 7.5, 10.5, 13.5)):
        c.shrub(x, -hd - 2.0, 0.5 + 0.2 * c.rnd.random(), k)
    for k, (tx, ty, s) in enumerate(((-18.0, -13.5, 1.0), (18.5, -11.0, 0.95), (18.5, 7.5, 1.05))):
        c.tree(tx, ty, s, k + 20)
    c.lamp_post(-17.5, -16.5)
    c.lamp_post(4.5, -16.5)
    c.sconces((-14.8, -2.6, 2.6, 14.8), hd, 3.0)
    c.reveals(W, D, NF, FH)
    c.roof_clutter(1.5, 13.5, 1.0, 10.0, H + 0.05, 7)
    c.fire_spots = [(-7, -5), (3, 4), (9, -5), (-11, 6)]
    return W, D, H

def build_office(c):
    M = c.M
    W, D, FH, NF = 32.0, 16.0, 3.5, 5
    H = FH * NF
    hw, hd = W / 2, D / 2
    c.ground(W, D)
    boxes('plaza', [(-19.5, 19.5, -hd - 7.0, -hd, 0, 0.06)], M['concrete'])
    boxes('core', [(-hw + 0.3, hw - 0.3, -hd + 0.3, hd - 0.3, 0, H)], M['spandrel'])
    cw = []
    for f in range(NF):
        z0 = f * FH
        panes = [(cx - 1.94, cx + 1.94, -hd - 0.03, -hd + 0.01, z0 + 0.75, z0 + FH) for cx in (-hw + (i + 0.5) * 4.0 for i in range(8))]
        panes += [(hw - 0.01, hw + 0.03, cy - 1.94, cy + 1.94, z0 + 0.75, z0 + FH) for cy in (-hd + (j + 0.5) * 4.0 for j in range(4))]
        for box in panes:
            if f == 0:
                c.lobby.append(box)
            elif c.rnd.random() < 0.4:
                c.pane(box)
            else:
                cw.append(box)
    cw += c.glass          # unlit panes on an office read as reflective curtain-wall glass
    c.glass = []
    boxes('cw', cw, M['cw'])
    c.openings += cw
    span = []
    for f in range(NF):
        z0 = f * FH
        span += [(-hw, hw, -hd - 0.05, -hd, z0, z0 + 0.75), (hw, hw + 0.05, -hd, hd, z0, z0 + 0.75)]
    boxes('spandrels', span, M['spandrel'])
    mull = [(-hw + k * 4.0 - 0.07, -hw + k * 4.0 + 0.07, -hd - 0.22, -hd, 0, H) for k in range(9)]
    mull += [(hw, hw + 0.22, -hd + k * 4.0 - 0.07, -hd + k * 4.0 + 0.07, 0, H) for k in range(5)]
    boxes('mullions', mull, M['metalL'])
    c.trim.append((-hw - 0.05, hw + 0.05, -hd - 0.05, hd + 0.05, H - 0.3, H))
    for (a, b, y0, y1) in ((-hw, hw, -hd - 0.05, -hd + 0.15), (-hw, hw, hd - 0.15, hd), (-hw, -hw + 0.15, -hd, hd), (hw - 0.15, hw + 0.05, -hd, hd)):
        c.trim.append((a, b, y0, y1, H, H + 0.6))
    boxes('roofdeck', [(-hw + 0.1, hw - 0.1, -hd + 0.1, hd - 0.1, H - 0.3, H + 0.04)], M['roof'])
    py0, py1 = -hd - 2.0, -hd
    c.lobby += [(-17.5, 17.5, py0 - 0.03, py0 + 0.01, 0.0, 3.3), (17.5, 17.54, py0, py1, 0.0, 3.3)]
    for k in range(15):
        x = -17.5 + k * 2.5
        c.metal.append((x - 0.05, x + 0.05, py0 - 0.1, py0, 0, 3.3))
    c.metal.append((17.45, 17.6, py0, py1, 0, 3.3))
    boxes('podiumRoof', [(-17.7, 17.7, py0 - 0.2, py1, 3.3, 3.65)], M['metalL'], bevel=0.02)
    text('sign15', '15', (-10.0, py0 - 0.22, 3.36), (math.radians(90), 0, 0), 0.32, M['sign'])
    c.flush()
    slats = []
    for k in range(8):
        z = H + 0.2 + k * 0.3
        slats += [(-8.5, 8.5, -4.6, -4.5, z, z + 0.16), (8.5, 8.6, -4.5, 4.5, z, z + 0.16)]
    boxes('screenCore', [(-8.4, 8.4, -4.4, 4.4, H, H + 2.5)], M['metal'])
    boxes('slats', slats, M['metalL'])
    cylinder('mast', 11.5, 5.5, H, H + 6.0, 0.08, M['metalL'], verts=8)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.22, location=(11.5, 5.5, H + 6.1))
    bpy.context.active_object.data.materials.append(M['red'])
    for k, x in enumerate((-18.0, -14.0, 14.0)):
        c.shrub(x, -hd - 5.5, 0.6, k)
    for k, (tx, ty, s) in enumerate(((-20.5, -9.0, 1.0), (20.5, -12.0, 0.9), (20.5, 5.0, 1.0))):
        c.tree(tx, ty, s, k + 20)
    c.lamp_post(-12.0, -hd - 6.5)
    c.lamp_post(12.0, -hd - 6.5)
    c.roof_clutter(-15.0, -9.5, -6.5, 6.5, H + 0.04, 6)
    c.fire_spots = [(-8, 0), (6, -2), (12, 3), (-13, 2)]
    return W, D, H

def build_shelter(c):
    M = c.M
    W, D, H = 35.0, 15.0, 6.0
    hw, hd = W / 2, D / 2
    c.ground(W, D)
    boxes('plaza', [(-6.0, 6.0, -hd - 6.0, -hd, 0, 0.06)], M['concrete'])
    boxes('lot', [(hw + 1.5, hw + 10.5, -hd, hd, 0, 0.05)], M['asphalt'])
    boxes('stripes', [(hw + 1.6, hw + 7.6, y - 0.06, y + 0.06, 0.05, 0.065) for y in (-7.5, -5.0, -2.5, 0.0, 2.5, 5.0, 7.5)], M['trim'])
    boxes('walls', [(-hw, hw, -hd, hd, 0, H - 0.3)], M['civic'], bevel=0.03)
    c.parapet(W, D, H, cap=0.5, out=0.2)
    c.trim.append((-hw - 0.08, hw + 0.08, -hd - 0.08, hd + 0.08, 0, 0.5))
    for i in range(7):
        cx = -hw + (i + 0.5) * 5.0
        if abs(cx) < 4:
            continue
        c.win_front(cx, hd, 1.2, 4.7, half=1.25)
    for j in range(3):
        c.win_side(-hd + (j + 0.5) * 5.0, hw, 1.2, 4.7, half=1.25)
    c.flush()
    boxes('clere', [(-10.0, 10.0, -3.0, 4.5, H, H + 3.0)], M['civic'], bevel=0.03)
    c.glazing_front(-9.5, 9.5, 3.0, H + 0.8, H + 2.4, 10)
    c.glazing_side(-2.5, 4.0, 10.0, H + 0.8, H + 2.4, 3)
    c.trim.append((-10.2, 10.2, -3.2, 4.7, H + 3.0, H + 3.2))
    c.flush()
    ring('marker', 13.5, 0.75, H + 0.1, 2.6, 0.14, M['signGreen'])
    text('markerA', 'A', (13.5, 0.0, H + 0.08), (0, 0, math.radians(45)), 2.8, M['signGreen'])
    boxes('vestibule', [(-3.5, 3.5, -hd - 2.5, -hd, 0, 4.5)], M['civic'], bevel=0.03)
    boxes('vestCap', [(-3.65, 3.65, -hd - 2.65, -hd, 4.5, 4.7)], M['trim'])
    boxes('signBand', [(-3.5, 3.5, -hd - 2.58, -hd - 2.48, 3.3, 4.35), (3.48, 3.58, -hd - 2.5, -hd, 3.3, 4.35)], M['signGreen'])
    text('signText', 'SHELTER A', (0.0, -hd - 2.6, 3.6), (math.radians(90), 0, 0), 0.55, M['ink'])
    c.lobby.append((-2.2, 2.2, -hd - 2.53, -hd - 2.49, 0.0, 3.0))
    c.metal += [(-2.3, -2.15, -hd - 2.6, -hd - 2.5, 0, 3.05), (2.15, 2.3, -hd - 2.6, -hd - 2.5, 0, 3.05), (-0.05, 0.05, -hd - 2.58, -hd - 2.5, 0, 3.0)]
    c.flush()
    cylinder('flagpole', -9.0, -hd - 4.5, 0.0, 9.0, 0.06, M['metalL'], verts=8)
    boxes('flag', [(-8.95, -7.0, -hd - 4.52, -hd - 4.48, 7.6, 8.8)], M['signGreen'])
    ring('assembly', -13.5, -hd - 4.0, 0.08, 1.8, 0.1, M['signGreen'])
    c.car(hw + 2.0, -6.9, 'car1')
    c.car(hw + 2.0, 0.6, 'car2')
    for k, x in enumerate((-16.0, -13.0, -10.0, 10.0, 13.0, 16.0)):
        c.shrub(x, -hd - 1.9, 0.5, k)
    for k, (tx, ty, s) in enumerate(((-21.0, -8.0, 1.0), (-21.0, 6.0, 0.9))):
        c.tree(tx, ty, s, k + 20)
    c.lamp_post(-7.0, -hd - 6.5)
    c.lamp_post(7.0, -hd - 6.5)
    c.sconces((-15.0, -10.0, 10.0, 15.0), hd, 5.0)
    c.roof_clutter(-16.0, -11.0, -6.0, 6.0, H + 0.05, 5)
    c.fire_spots = [(-8, 2), (8, -2), (0, 1)]
    return W, D, H + 3

def build_homes(c):
    M = c.M
    W, D = 70.0, 10.0
    c.ground(W, D, apron=False)
    wall_h, ridge = 3.0, 6.25
    for i in range(4):
        x0 = -35 + 19 * i
        x1 = x0 + 13
        wm = M['stucco'] if i % 2 == 0 else M['house2']
        boxes('walk', [(x0 + 5.8, x0 + 7.2, -10.0, -4.5, 0, 0.05)], M['concrete'])
        boxes('drive', [(x0 + 9.3, x0 + 12.6, -10.0, -4.5, 0, 0.05)], M['concrete'])
        boxes('fence', [(x0 - 2.5, x0 + 5.6, -8.0, -7.9, 0, 0.9), (x0 - 2.5, x0 - 2.4, -8.0, 3.0, 0, 0.9)], M['trim'] if not c.lost else M['wood'])
        boxes('walls', [(x0, x1, -4.5, 4.5, 0, wall_h)], wm, bevel=0.02)
        v = [(x0, -4.5, wall_h), (x0, 4.5, wall_h), (x0, 0, ridge), (x1, -4.5, wall_h), (x1, 4.5, wall_h), (x1, 0, ridge)]
        mesh_obj('gable', v, [(0, 2, 1), (3, 4, 5), (0, 1, 4, 3), (0, 3, 5, 2), (1, 2, 5, 4)], wm)
        o = 0.45
        rv = [(x0 - o, -5.05, wall_h - 0.12), (x1 + o, -5.05, wall_h - 0.12), (x1 + o, 0, ridge + 0.12), (x0 - o, 0, ridge + 0.12),
              (x1 + o, 5.05, wall_h - 0.12), (x0 - o, 5.05, wall_h - 0.12)]
        mesh_obj('roof', rv, [(0, 1, 2, 3), (3, 2, 4, 5)], M['tile'], solidify=0.18)
        boxes('ridgeCap', [(x0 - o, x1 + o, -0.15, 0.15, ridge + 0.05, ridge + 0.3)], M['tileFlat'])
        boxes('chimney', [(x0 + 2.5, x0 + 3.5, 1.2, 2.2, 4.3, 7.4)], M['stone'], bevel=0.02)
        c.win_front(x0 + 2.5, 4.5, 0.9, 2.3, half=1.0, mullion=False)
        c.win_front(x0 + 10.5, 4.5, 0.9, 2.3, half=1.0, mullion=False)
        boxes('door', [(x0 + 5.9, x0 + 7.1, -4.58, -4.5, 0.0, 2.3)], M['wood'])
        boxes('porchLight', [(x0 + 7.35, x0 + 7.5, -4.62, -4.5, 1.9, 2.1)], M['strip'])
        c.win_side(-1.6, x1, 0.9, 2.3, half=0.8, mullion=False)
        c.win_side(1.6, x1, 0.9, 2.3, half=0.8, mullion=False)
        c.metal.append((x1, x1 + 0.08, -0.45, 0.45, 4.25, 4.85))
        c.shrub(x0 + 1.0, -5.6, 0.5, i * 3)
        c.shrub(x0 + 4.0, -5.6, 0.45, i * 3 + 1)
        if i < 3:
            c.tree(x1 + 3.0, 1.5, 0.85, 20 + i)
    c.flush()
    c.tree(-38.0, -5.0, 0.9, 40)
    c.lamp_post(-30.0, -9.6)
    c.lamp_post(8.0, -9.6)
    c.fire_spots = [(-28.5, 0), (-9.5, 0), (9.5, 0), (28.5, 0)]
    return W, D, ridge

BUILDERS = dict(senior=build_senior, apartments=build_apartments, office=build_office, shelter=build_shelter, homes=build_homes)

# ------------------------------------------------------------------ vegetation props (billboards on the map)
# Smaller frame, anchor = where the trunk meets the ground. Must match PROP_BOX in web/src/town/scene.ts.
PROP_BOX = (176, 110, 36, 62)

def branch(pivot, rx, rz, ln, r, mat):
    """Cylinder that starts at pivot and points along the given tilt (rx) / heading (rz)."""
    from mathutils import Euler
    e = Euler((math.radians(rx), 0, math.radians(rz)))
    d = Vector((0, 0, 1))
    d.rotate(e)
    cy = cylinder('branch', 0, 0, 0, ln, r, mat, verts=8)
    cy.rotation_euler = e
    cy.location = Vector(pivot) + d * (ln / 2)
    return cy

def prop_ground(c):
    cat = boxes('catcher', [(-60, 60, -60, 60, -0.02, -0.001)], c.M['concrete'])
    cat.is_shadow_catcher = True

def build_oak(c):
    M = c.M
    prop_ground(c)
    cylinder('trunk', 0, 0, 0.0, 3.0, 0.24, M['trunk'], verts=12)
    for (rx, rz, ln) in ((35, 20, 1.6), (40, 140, 1.4), (30, 250, 1.3)):
        branch((0, 0, 2.6), rx, rz, ln, 0.1, M['trunk'])
    blobs = [((0, 0, 4.4), 1.9), ((1.1, -0.6, 3.9), 1.4), ((-1.0, 0.5, 4.0), 1.4), ((0.3, 0.9, 5.2), 1.3),
             ((-0.5, -0.9, 5.0), 1.2), ((0.9, 0.4, 5.4), 1.0)]
    for k, (loc, r) in enumerate(blobs):
        blob('crown', loc, r, M['leaf'], k + 3)
    return 3, 3, 6

def build_palm(c):
    M = c.M
    prop_ground(c)
    top = Vector((0.6, -0.3, 8.6))
    segs = 8
    for i in range(segs):
        t0, t1 = i / segs, (i + 1) / segs
        a = Vector((0, 0, 0)).lerp(top, t0)
        b = Vector((0, 0, 0)).lerp(top, t1)
        a.x += 0.5 * math.sin(t0 * math.pi) ; b.x += 0.5 * math.sin(t1 * math.pi)
        mid = (a + b) / 2
        d = b - a
        cy = cylinder('palmTrunk', mid.x, mid.y, 0, d.length, 0.24 - 0.08 * t0, M['palmTrunk'], verts=12)
        cy.location = mid
        cy.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    top.x += 0.0
    fronds = 11
    for f in range(fronds):
        ang = 2 * math.pi * f / fronds + 0.3
        L = 3.2 + 0.4 * math.sin(f * 1.7)
        lift = 1.3 if f % 3 else 1.8
        v, faces = [], []
        n = 10
        for i in range(n + 1):
            t = i / n
            cx = top.x + math.cos(ang) * L * t
            cy2 = top.y + math.sin(ang) * L * t
            cz = top.z + lift * t - 3.4 * t * t
            w = 0.55 * math.sin(math.pi * min(1.0, t * 1.15)) + 0.05
            px, py = -math.sin(ang) * w, math.cos(ang) * w
            v += [(cx + px, cy2 + py, cz - 0.08 * w), (cx, cy2, cz + 0.05), (cx - px, cy2 - py, cz - 0.08 * w)]
            if i:
                b0 = (i - 1) * 3
                faces += [(b0, b0 + 1, b0 + 4, b0 + 3), (b0 + 1, b0 + 2, b0 + 5, b0 + 4)]
        mesh_obj('frond', v, faces, M['palmLeaf'], solidify=0.02)
    blob('palmHeart', tuple(top), 0.35, M['palmTrunk'], 2)
    return 3, 3, 9

def build_shrub(c):
    M = c.M
    prop_ground(c)
    for k, (loc, r) in enumerate((((0, 0, 0.55), 0.75), ((0.6, -0.3, 0.45), 0.55), ((-0.5, 0.35, 0.5), 0.6))):
        blob('shrub', loc, r, M['leaf'], k + 7)
    return 2, 2, 1.2

def build_snag(c):
    M = c.M
    prop_ground(c)
    cylinder('trunk', 0, 0, 0.0, 4.2, 0.26, M['trunk'], verts=10)
    for (rx, rz, ln, z) in ((40, 30, 1.8, 2.6), (45, 160, 1.5, 2.1), (35, 260, 1.3, 3.3), (25, 330, 1.0, 3.8)):
        branch((0, 0, z), rx, rz, ln, 0.09, M['trunk'])
    return 2, 2, 4

def build_euc(c):
    """Eucalyptus: tall pale trunk that forks, sparse drooping blue-green crown."""
    p = c.p
    bark = make_mat('bark', p['bark'], rough=0.7, noise=0.6, nscale=4, bump=0.3, bscale=40)
    leaf = make_mat('eucLeaf', p['euc'], rough=0.7, noise=0.0 if c.maq else 0.6, nscale=3, bump=0.8, bscale=40)
    prop_ground(c)
    cylinder('trunk', 0, 0, 0.0, 5.5, 0.26, bark, verts=12)
    for (rx, rz, ln, r) in ((14, 30, 5.0, 0.17), (18, 200, 4.4, 0.15), (24, 110, 3.4, 0.11)):
        branch((0, 0, 5.2), rx, rz, ln, r, bark)
    tips = [((0.9, 0.5, 10.2), 1.3), ((-0.9, -0.6, 9.3), 1.15), ((0.3, 1.3, 8.6), 1.0), ((-0.2, -0.1, 10.9), 0.9),
            ((1.4, -0.4, 8.9), 0.9), ((-1.2, 0.6, 8.2), 0.85)]
    for k, (loc, r) in enumerate(tips):
        o = blob('eucCrown', loc, r, leaf, k + 11)
        o.scale = (1.0, 1.0, 1.35)
    return 3, 3, 11

PROPS = dict(oak=build_oak, palm=build_palm, shrub=build_shrub, snag=build_snag, euc=build_euc)

# ------------------------------------------------------------------ fire damage
SITE = ('catcher', 'lawn', 'apron', 'walk', 'drive', 'plaza', 'lot', 'stripes', 'trunk', 'crown', 'shrub', 'pole', 'lamp',
        'van', 'beacon', 'head', 'tail', 'wheel', 'car', 'flag', 'assembly', 'fence', 'ramp')

def _invisible(o):
    """Cutters must stay in the render (hide_render would drop the boolean) but never be seen."""
    for attr in ('visible_camera', 'visible_shadow', 'visible_diffuse', 'visible_glossy', 'visible_transmission', 'visible_volume_scatter'):
        if hasattr(o, attr):
            setattr(o, attr, False)
    o.name = 'cutter_' + o.name

def _cutter_grid(z, size, strength, seed):
    """A jagged horizontal break surface extruded upward: everything above it is removed."""
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=48, y_subdivisions=48, size=size, location=(0, 0, z))
    g = bpy.context.active_object
    tex = bpy.data.textures.new('breakTex', 'CLOUDS')
    tex.noise_scale = 0.9
    tex.noise_depth = 2
    d = g.modifiers.new('break', 'DISPLACE')
    d.texture = tex
    d.strength = strength
    d.texture_coords = 'GLOBAL'
    sol = g.modifiers.new('volume', 'SOLIDIFY')
    sol.thickness = 60
    sol.offset = 1.0
    _invisible(g)
    g.rotation_euler = (0, 0, seed)
    return g

def _cutter_blob(loc, r, seed):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=r, location=loc)
    b = bpy.context.active_object
    tex = bpy.data.textures.new('holeTex', 'CLOUDS')
    tex.noise_scale = 0.22
    tex.noise_depth = 3
    d = b.modifiers.new('rough', 'DISPLACE')
    d.texture = tex
    d.strength = r * 0.75
    b.rotation_euler = (seed, seed * 1.7, seed * 0.6)
    _invisible(b)
    return b

SHELLS = ('mass', 'plinth', 'walls', 'core', 'clere')

def _bounds(o):
    vs = [o.matrix_world @ v.co for v in o.data.vertices]
    return (min(v.x for v in vs), max(v.x for v in vs), min(v.y for v in vs), max(v.y for v in vs), min(v.z for v in vs), max(v.z for v in vs))

def hollow_interior(c, kind, mode, rnd):
    """Swap solid masses for wall shells with floors, columns, rooms and burnt furniture inside,
    and cut the window panes out as real openings so the fire-gutted interior shows through."""
    M = c.M
    ruin = mode == 'ruin'
    plaster = make_mat('plaster', '#8A817A' if ruin else '#4A423E', rough=0.95, noise=0.8, nscale=9, bump=0.5, bscale=60)
    slab = make_mat('slab', '#7A726B' if ruin else '#3B3633', rough=0.95, noise=0.8, nscale=6, bump=0.5, bscale=90)
    charwood = make_mat('charwood', '#1C1412', rough=0.9, noise=0.8, nscale=25, bump=0.8, bscale=70)
    shells = []
    for o in [o for o in bpy.context.scene.objects if o.type == 'MESH' and o.name.split('.')[0] in SHELLS]:
        b = _bounds(o)
        mat = o.data.materials[0] if o.data.materials else M['stucco']
        bpy.data.objects.remove(o, do_unlink=True)
        x0, x1, y0, y1, z0, z1 = b
        t = 0.35
        if ruin:
            # what survives a collapse: wall stubs of uneven height, built broken rather than cut
            top = z0 + (z1 - z0) * 0.55
            segs = []
            def run(a0, a1, fixed, along_x):
                n = max(2, int((a1 - a0) / 1.6))
                for i in range(n):
                    u0 = a0 + (a1 - a0) * i / n
                    u1 = a0 + (a1 - a0) * (i + 1) / n
                    hgt = z0 + (top - z0) * (rnd.uniform(0.15, 1.0) ** 1.6)
                    if along_x:
                        segs.append((u0, u1, fixed[0], fixed[1], z0, hgt))
                    else:
                        segs.append((fixed[0], fixed[1], u0, u1, z0, hgt))
            run(x0, x1, (y0, y0 + t), True)
            run(x0, x1, (y1 - t, y1), True)
            run(y0, y1, (x0, x0 + t), False)
            run(y0, y1, (x1 - t, x1), False)
            shells.append((boxes('ruinwall', segs, mat), (x0, x1, y0, y1, z0, top)))
        else:
            shells.append((boxes('shell', [(x0, x1, y0, y0 + t, z0, z1), (x0, x1, y1 - t, y1, z0, z1),
                                           (x0, x0 + t, y0, y1, z0, z1), (x1 - t, x1, y0, y1, z0, z1)], mat), b))
    # window and door openings through the shell walls (panes are blown out)
    cuts = []
    for (x0, x1, y0, y1, z0, z1) in c.openings:
        if (y1 - y0) < (x1 - x0):   # pane on a face that runs along x: push the cut through the wall in y
            cuts.append((x0, x1, y0 - 0.3, y1 + 0.7, z0, z1))
        else:
            cuts.append((x0 - 0.7, x1 + 0.3, y0, y1, z0, z1))
    if cuts and not ruin:   # stacking the openings cut under the collapse cut breaks the second boolean; ruins do not need it
        win = boxes('cutter_windows', cuts, M['glass'])
        for attr in ('visible_camera', 'visible_shadow', 'visible_diffuse', 'visible_glossy', 'visible_transmission', 'visible_volume_scatter'):
            if hasattr(win, attr):
                setattr(win, attr, False)
        for sh, _ in shells:
            m = sh.modifiers.new('openings', 'BOOLEAN')
            m.operation = 'DIFFERENCE'
            m.object = win
            m.solver = 'FLOAT'
    for name in ('glass', 'lit1', 'lit2', 'lobby', 'cw', 'rail'):
        for o in [o for o in bpy.context.scene.objects if o.name.split('.')[0] == name]:
            bpy.data.objects.remove(o, do_unlink=True)

    # inside each shell: slabs at every storey, columns, corridor + room walls, charred contents
    FH = 3.5
    slabs, cols, parts, stuff, flames = [], [], [], [], []
    for _, (x0, x1, y0, y1, z0, z1) in shells:
        ix0, ix1, iy0, iy1 = x0 + 0.35, x1 - 0.35, y0 + 0.35, y1 - 0.35
        storey = FH if (z1 - z0) > 4.2 else (z1 - z0)
        z = z0
        floors = []
        while z < z1 - 0.6:
            floors.append(z)
            slabs.append((ix0, ix1, iy0, iy1, z, z + 0.25))
            z += storey
        nx = max(2, int((ix1 - ix0) / 4.7))
        ny = max(1, int((iy1 - iy0) / 4.7))
        for i in range(1, nx):
            x = ix0 + (ix1 - ix0) * i / nx
            for j in range(1, ny + 1):
                y = iy0 + (iy1 - iy0) * j / (ny + 1)
                cols.append((x - 0.2, x + 0.2, y - 0.2, y + 0.2, z0, z1))
        if (iy1 - iy0) > 7:
            yc = (iy0 + iy1) / 2
            parts += [(ix0, ix1, yc - 1.3, yc - 1.15, z0, z1), (ix0, ix1, yc + 1.15, yc + 1.3, z0, z1)]
        for i in range(1, nx):
            x = ix0 + (ix1 - ix0) * i / nx + 1.1
            parts.append((x - 0.07, x + 0.07, iy0, iy0 + (iy1 - iy0) * 0.42, z0, z1))
        for fz in floors:
            for i in range(nx):
                if rnd.random() < 0.75:
                    fx = ix0 + (ix1 - ix0) * (i + rnd.uniform(0.2, 0.7)) / nx
                    fy = rnd.uniform(iy0 + 0.6, iy0 + (iy1 - iy0) * 0.38)
                    w, d, h = rnd.uniform(0.8, 2.0), rnd.uniform(0.6, 1.4), rnd.uniform(0.35, 0.9)
                    stuff.append((fx - w / 2, fx + w / 2, fy - d / 2, fy + d / 2, fz + 0.25, fz + 0.25 + h))
            if mode == 'gutted':
                # fire burning in the rooms: glowing beds of flame you can see through every opening
                for k in range(nx):
                    if rnd.random() < 0.8:
                        lx = ix0 + (ix1 - ix0) * (k + rnd.uniform(0.25, 0.75)) / nx
                        flames.append((lx - 0.8, lx + 0.8, iy0 + 0.6, iy0 + 1.5, fz + 0.25, fz + rnd.uniform(0.6, 1.6)))
                for k in range(3):
                    lx = ix0 + (ix1 - ix0) * (k + 0.5) / 3
                    light('POINT', 'roomFire', (lx, iy0 + 1.4, fz + 1.5), 900, '#FF5A1F', size=1.2)
    if ruin:
        # interior survives as broken pieces too: chop walls into stubs, snap columns, keep only low floors
        def broken(bx_list, seg):
            out = []
            for (a0, a1, b0, b1, z0_, z1_) in bx_list:
                along_x = (a1 - a0) >= (b1 - b0)
                L = (a1 - a0) if along_x else (b1 - b0)
                n = max(1, int(L / seg))
                for i in range(n):
                    if rnd.random() < 0.25:
                        continue
                    hgt = z0_ + (z1_ - z0_) * (rnd.uniform(0.1, 0.9) ** 1.5)
                    if along_x:
                        out.append((a0 + L * i / n, a0 + L * (i + 1) / n, b0, b1, z0_, hgt))
                    else:
                        out.append((a0, a1, b0 + L * i / n, b0 + L * (i + 1) / n, z0_, hgt))
            return out
        parts = broken(parts, 1.4)
        cols = broken(cols, 99)
        lowest = min((z for (_, _, _, _, z, _) in slabs), default=0)
        slabs = [b_ for b_ in slabs if b_[4] <= lowest + 3.6]
    boxes('slabs', slabs, slab, bevel=0.02)
    boxes('columns', cols, slab)
    boxes('partitions', parts, plaster)
    boxes('contents', stuff, charwood, bevel=0.04)
    if flames:
        boxes('roomFlames', flames, make_mat('roomGlow', '#FF6A1F', rough=0.6, emit='#FF6A1F', estr=14.0), bevel=0.2)

def apply_damage(c, kind, W, D, H, mode):
    """Carve the finished model: 'gutted' caves in a roof corner and punches holes in the front;
    'ruin' snaps the building off along a jagged line and piles debris where it fell."""
    M = c.M
    rnd = random.Random(31 + len(kind))
    hollow_interior(c, kind, mode, rnd)
    targets = [o for o in bpy.context.scene.objects
               if o.type in ('MESH',) and not o.name.startswith(SITE + (('ruinwall', 'partitions', 'columns', 'slabs', 'contents') if mode == 'ruin' else ())) and not o.name.startswith('cutter_') and not o.hide_render]
    for o in [o for o in bpy.context.scene.objects if o.type == 'FONT']:
        bpy.data.objects.remove(o, do_unlink=True)
    cutters = []
    hole_centres = []
    if mode == 'gutted' and kind == 'homes':
        for i in range(4):
            cx = -35 + 19 * i + 6.5 + (i % 2) * 2
            hole_centres.append((cx, -1.0, 6.4, 3.4))
    elif mode == 'gutted':
        r = 0.3 * max(W, D)
        hole_centres.append((W * 0.2, -D * 0.2, H + r * 0.25, r))
        hole_centres.append((-W * 0.26, -D * 0.5, H * 0.7, 0.12 * max(W, D)))
    for k, (x, y, z, r) in enumerate(hole_centres):
        cutters.append(_cutter_blob((x, y, z), r, 1.3 + k))
    if mode == 'ruin':
        top = H * 0.3 if kind != 'homes' else 1.5
        cutters.append(_cutter_grid(top, max(W, D) * 1.8, H * 0.34 if kind != 'homes' else 1.1, 0.4))
    for o in targets:
        for k, cut in enumerate(cutters):
            m = o.modifiers.new(f'dmg{k}', 'BOOLEAN')
            m.operation = 'DIFFERENCE'
            m.object = cut
            m.solver = 'FLOAT'  # the exact solver gives up on the noisy cutter surface and silently skips the cut

    # debris: broken slabs and blocks around the base, mounds where floors came down
    hw, hd = W / 2, D / 2
    mats = [M['stucco'], M['stone'], M['trim'], M['roof'], M['concrete']]
    n = 70 if mode == 'ruin' else 26
    for i in range(n):
        if mode == 'ruin' and i % 3 == 0:
            x, y = rnd.uniform(-hw, hw), rnd.uniform(-hd, hd)
            z = H * 0.3 + rnd.uniform(-1, 1.5)
        else:
            side = rnd.random()
            x = rnd.uniform(-hw - 2.5, hw + 2.5) if side < 0.6 else hw + rnd.uniform(0, 2.8)
            y = -hd - rnd.uniform(0, 3.0) if side < 0.6 else rnd.uniform(-hd, hd)
            z = rnd.uniform(0.05, 0.6)
        s = rnd.uniform(0.35, 1.4) if mode == 'ruin' else rnd.uniform(0.25, 0.8)
        o = boxes('debris', [(-s, s, -s * 0.6, s * 0.6, -s * 0.25, s * 0.25)], mats[i % len(mats)])
        o.location = (x, y, z)
        o.rotation_euler = (rnd.uniform(0, 1.2), rnd.uniform(0, 1.2), rnd.uniform(0, 3.14))
    # charred beams left hanging across the broken areas
    beam = make_mat('beam', '#1A1311', rough=0.9, noise=0.6, nscale=30, bump=0.6, bscale=80)
    for (x, y, z, r) in hole_centres:
        for j in range(4):
            o = boxes('beam', [(-r * 0.8, r * 0.8, -0.12, 0.12, -0.12, 0.12)], beam)
            o.location = (x + rnd.uniform(-r * 0.3, r * 0.3), y + rnd.uniform(-r * 0.3, r * 0.3), min(z, H) - rnd.uniform(0.2, 1.4))
            o.rotation_euler = (rnd.uniform(-0.25, 0.25), rnd.uniform(-0.35, 0.35), rnd.uniform(0, 3.14))
    if mode == 'ruin':
        # low, rough heaps where the upper floors came down
        tex = bpy.data.textures.new('heapTex', 'CLOUDS')
        tex.noise_scale = 0.35
        heaps = 6 if kind != 'homes' else 6
        for i in range(heaps):
            x = -hw + (i + 0.5) * W / heaps + rnd.uniform(-1, 1)
            r = min(W, D) * (0.1 if kind != 'homes' else 0.22) * rnd.uniform(0.8, 1.2)
            # heaps sit toward the back and sides so the broken floors stay visible
            bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=r, location=(x, rnd.uniform(hd * 0.1, hd * 0.6), H * 0.12 if kind != 'homes' else 0.9))
            heap = bpy.context.active_object
            d = heap.modifiers.new('rough', 'DISPLACE')
            d.texture = tex
            d.strength = r * 0.6
            heap.scale = (1.5, 1.1, 0.42)
            heap.data.materials.append(mats[i % len(mats)])
        # what is left standing: twisted columns and a corner of wall above the rubble line
        if kind != 'homes':
            stand = make_mat('standing', '#2C2724', rough=0.95, noise=0.7, nscale=12, bump=0.6, bscale=50)
            for k in range(5):
                x = -hw + W * rnd.uniform(0.15, 0.85)
                y = rnd.uniform(-hd * 0.6, hd * 0.6)
                hgt = H * rnd.uniform(0.38, 0.62)
                col = boxes('stub', [(-0.22, 0.22, -0.22, 0.22, 0, hgt)], stand)
                col.location = (x, y, 0)
                col.rotation_euler = (rnd.uniform(-0.12, 0.12), rnd.uniform(-0.12, 0.12), rnd.uniform(0, 3))
            boxes('wallCorner', [(hw - 5.5, hw, -hd, -hd + 0.35, 0, H * 0.55), (hw - 0.35, hw, -hd, -hd + 4.5, 0, H * 0.5)], M['stucco'])
            boxes('wallFrag', [(-hw, -hw + 3.2, -hd, -hd + 0.35, 0, H * 0.42)], M['stucco'])
        # embers glowing in the rubble
        glow = make_mat('emberGlow', '#2A1A12', rough=0.8, emit='#FF5A1F', estr=6.0)
        for i in range(18):
            o = boxes('ember', [(-0.18, 0.18, -0.12, 0.12, -0.06, 0.06)], glow)
            o.location = (rnd.uniform(-hw, hw), rnd.uniform(-hd - 1.5, hd), rnd.uniform(0.1, H * 0.3))
    else:
        # fire light inside the caved-in corner
        light('POINT', 'innerFire', (W * 0.22, -D * 0.2, H * 0.8), 2600, '#FF5A1F', size=2.5)
        light('POINT', 'innerFire', (-W * 0.24, -D * 0.4, H * 0.65), 1200, '#FF6A1F', size=1.5)

# ------------------------------------------------------------------ all-round facades and view rotation
def _box_key(bx):
    return tuple(round(v, 2) for v in bx)

def mirror_boxes(boxes_list, W, D):
    """Copies of facade boxes for the faces the original camera never saw: front (-y) -> back (+y),
    side (+x) -> left (-x). Skips copies that would sit exactly on an existing box."""
    hw, hd = W / 2, D / 2
    seen = {_box_key(b) for b in boxes_list}
    out = []
    for (x0, x1, y0, y1, z0, z1) in boxes_list:
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        cands = []
        if cy < -hd + 0.8 and abs(cy) > 0.4 * hd:
            cands.append((x0, x1, -y1, -y0, z0, z1))
        if cx > hw - 0.8 and abs(cx) > 0.4 * hw:
            cands.append((-x1, -x0, y0, y1, z0, z1))
        for m in cands:
            k = _box_key(m)
            if k not in seen:
                seen.add(k)
                out.append(m)
    return out

def mirror_facades(c, W, D):
    """Give a building windows and detail on all four sides, so the town can be viewed from any side."""
    skip = set(SITE) | {'cutter'}
    for o in list(bpy.data.objects):
        if o.type != 'MESH' or o.parent is not None or any(o.name.startswith(n) for n in skip):
            continue
        me = o.data
        nv = len(me.vertices)
        if nv == 0 or nv % 8 or len(me.polygons) != nv // 8 * 6:
            continue   # not built by boxes(): cylinders, text, blobs
        bx = []
        for g in range(nv // 8):
            vs = [me.vertices[g * 8 + i].co for i in range(8)]
            bx.append((min(v.x for v in vs), max(v.x for v in vs), min(v.y for v in vs), max(v.y for v in vs), min(v.z for v in vs), max(v.z for v in vs)))
        extra = mirror_boxes(bx, W, D)
        if not extra:
            continue
        mat = me.materials[0] if me.materials else None
        bevel = next((m.width for m in o.modifiers if m.type == 'BEVEL'), 0.0)
        mo = boxes(o.name + '_mirror', extra, mat, bevel)
        mo.location = o.location
        for attr in ('visible_camera', 'visible_shadow', 'visible_diffuse', 'visible_glossy', 'visible_transmission', 'visible_volume_scatter'):
            setattr(mo, attr, getattr(o, attr))
    c.openings += mirror_boxes(c.openings, W, D)

def rotate_view(r, pivot=(0.0, 0.0)):
    """Turn the whole model (not the camera, not the sun) by r x 90 degrees about Z around the pivot:
    the same turn the web app applies to map space, with light staying put relative to the camera."""
    if not r:
        return
    from mathutils import Matrix
    T = Matrix.Translation((pivot[0], pivot[1], 0.0))
    R = T @ Matrix.Rotation(math.radians(90 * r), 4, 'Z') @ T.inverted()
    for o in bpy.data.objects:
        if o.parent is not None or o.type == 'CAMERA' or o.name.startswith('catcher'):
            continue
        if o.type == 'LIGHT' and o.data.type == 'SUN':
            continue
        o.matrix_world = R @ o.matrix_world

# ------------------------------------------------------------------ window export
def export_windows(path):
    """Project every window/door pane onto the sprite frame so the web app can light, darken or
    set fire to each room on its own. Output: {kind: [[x1,y1,x2,y2,x3,y3,x4,y4,floor,face], ...]}"""
    import json
    from bpy_extras.object_utils import world_to_camera_view
    data = {}
    for kind in ('senior', 'apartments', 'office', 'shelter', 'homes'):
        v = VARIANT['night']
        bpy.ops.wm.read_factory_settings(use_empty=True)
        setup_render(v)
        setup_camera()
        c = Ctx(v)
        W, D, H = BUILDERS[kind](c)
        sc = bpy.context.scene
        cam = sc.camera
        openings = c.openings + mirror_boxes(c.openings, W, D)
        for r in ROTS_ALL:
            ca, sa = round(math.cos(math.radians(90 * r))), round(math.sin(math.radians(90 * r)))
            rot = lambda x, y: (x * ca - y * sa, x * sa + y * ca)
            out = []
            for (x0, x1, y0, y1, z0, z1) in openings:
                cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
                if (y1 - y0) < (x1 - x0):   # pane on a +-y face
                    ny = -1 if cy < 0 else 1
                    yy = y0 if ny < 0 else y1
                    quad2 = [(x0, yy), (x1, yy)]
                    n = rot(0, ny)
                else:                        # pane on a +-x face
                    nx = 1 if cx > 0 else -1
                    xx = x1 if nx > 0 else x0
                    quad2 = [(xx, y1), (xx, y0)]
                    n = rot(nx, 0)
                if n[1] < -0.5:
                    face = 0                 # faces the camera's front (world -y)
                elif n[0] > 0.5:
                    face = 1                 # faces the camera's side (world +x)
                else:
                    continue                 # turned away: not drawn in this view
                a2, b2 = rot(*quad2[0]), rot(*quad2[1])
                quad = [(a2[0], a2[1], z0), (b2[0], b2[1], z0), (b2[0], b2[1], z1), (a2[0], a2[1], z1)]
                pts = []
                for q in quad:
                    uv = world_to_camera_view(sc, cam, Vector(q))
                    pts += [round(uv.x * BOX_W, 1), round((1 - uv.y) * BOX_H, 1)]
                out.append(pts + [int(z0 // 3.5), face])
            data[kind if r == 0 else f'{kind}_r{r}'] = out
        print(f'[windows] {kind}: {len(out)}', flush=True)
    with open(path, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    print('[windows] wrote', path, flush=True)

def main():
    global BOX_W, BOX_H, ANCHOR_X, ANCHOR_Y
    if '--export-windows' in argv:
        BOX_W, BOX_H, ANCHOR_X, ANCHOR_Y = 520, 380, 220, 220
        export_windows(os.path.join(ROOT, 'web', 'src', 'town', 'windows.json'))
        return

    # ------------------------------------------------------------------ main
    ext = 'webp' if FMT == 'webp' else 'png'
    for kind in KINDS:
        is_prop = kind in PROPS
        if is_prop:
            BOX_W, BOX_H, ANCHOR_X, ANCHOR_Y = PROP_BOX
        else:
            BOX_W, BOX_H, ANCHOR_X, ANCHOR_Y = 520, 380, 220, 220
        for name in VARIANTS:
            if kind == 'snag' and name != 'lost':
                continue
            if is_prop and kind != 'snag' and name in ('lost', 'burning', 'gutted'):
                continue
            v = VARIANT[name]
            for r in ROTS:
                if r and is_prop:
                    continue   # trees look the same from every side
                bpy.ops.wm.read_factory_settings(use_empty=True)
                setup_render(v)
                setup_camera()
                setup_world(v)
                c = Ctx(v)
                W, D, H = (PROPS if is_prop else BUILDERS)[kind](c)
                if not is_prop:
                    mirror_facades(c, W, D)
                if not is_prop and v.get('damage'):
                    apply_damage(c, kind, W, D, H, v['damage'])
                if is_prop:
                    v_props = dict(v, roof_fire=False, embers=False, fire_glow=0)
                    c.v = v_props
                c.lights(W, D, H)
                rotate_view(r)
                suffix = f'_r{r}' if r else ''
                out = os.path.join(OUT, f'{"prop_" if is_prop else ""}{kind}_{name}{suffix}.{ext}')
                bpy.context.scene.render.filepath = out
                print(f'[lantern] rendering {kind}/{name}/r{r} -> {out}', flush=True)
                bpy.ops.render.render(write_still=True)
    print('[lantern] all done', flush=True)


if __name__ == '__main__':
    main()
