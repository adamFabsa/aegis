"""
Vehicle models shared by the ground plate (parked cars) and the vehicle sprites (traffic, vans, engines).
Every model is built at the origin, facing Blender +X, wheels on z = 0. Units are metres.
"""
import bpy, math
import build_sprites as bs

lin = bs.lin

def vmats(night=False, maq=False):
    """Paints, glass, tyres and lights. Night switches the head and tail lights on."""
    def paint(name, col):
        m = bs.make_mat(name, col, rough=0.3 if not maq else 0.7, coat=0.0 if maq else 0.9, spec=0.6)
        return m
    M = dict(
        white=paint('pWhite', '#EDEDEA'), black=paint('pBlack', '#16181C'), red=paint('pRed', '#9E1B22'),
        silver=paint('pSilver', '#A9AEB5'), navy=paint('pNavy', '#1F2E4D'), tan=paint('pTan', '#C9B48A'),
        engine=paint('pEngine', '#B7161C'), vanWhite=paint('pVan', '#F2F2EF'),
        glass=bs.make_mat('vGlass', '#0E141B' if not maq else '#B8C4CA', rough=0.05, spec=0.9),
        tire=bs.make_mat('vTire', '#141414' if not maq else '#CFCBC3', rough=0.85),
        rim=bs.make_mat('vRim', '#3A3D42' if not maq else '#E6E2DA', rough=0.35, metal=0.0 if maq else 0.8),
        trim=bs.make_mat('vTrim', '#202226' if not maq else '#D8D4CC', rough=0.5),
        chrome=bs.make_mat('vChrome', '#D7DADF' if not maq else '#ECE8E0', rough=0.15, metal=0.0 if maq else 1.0),
        head=bs.make_mat('vHead', '#FFF4D8', rough=0.2, emit='#FFF4D8', estr=14.0 if night else 0.4),
        tail=bs.make_mat('vTail', '#8A0E0E', rough=0.3, emit='#FF2A1A', estr=6.0 if night else 0.3),
        amber=bs.make_mat('vAmber', '#F2A93B', rough=0.4, emit='#F2A93B', estr=6.0 if night else 0.5),
        bar=bs.make_mat('vBar', '#E8E6E0', rough=0.4),
        stripe=bs.make_mat('vStripe', '#F2F2EF', rough=0.4),
    )
    if maq:
        for k in ('white', 'black', 'red', 'silver', 'navy', 'tan', 'engine', 'vanWhite'):
            M[k] = bs.make_mat('pMaq' + k, '#F4F2EE', rough=0.7)
    return M

def _profile_obj(name, prof, y0, y1, mat, bevel=0.0, seg=3):
    """Side profile (x, z) extruded across y0..y1."""
    n = len(prof)
    v = [(x, y0, z) for (x, z) in prof] + [(x, y1, z) for (x, z) in prof]
    f = [list(range(n)), list(range(2 * n - 1, n - 1, -1))]
    for i in range(n):
        j = (i + 1) % n
        f.append((i, j, n + j, n + i))
    o = bs.mesh_obj(name, v, f, mat)
    # make normals point outward whichever way the profile was wound
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    o.select_set(False)
    if bevel:
        b = o.modifiers.new('bevel', 'BEVEL')
        b.width = bevel
        b.segments = seg
        b.limit_method = 'ANGLE'
        o.modifiers.new('smooth', 'WEIGHTED_NORMAL')
        try:
            o.data.shade_smooth()
        except Exception:
            pass
    return o

def _wheels(M, xs, half_w, r=0.34, w=0.24):
    out = []
    for x in xs:
        for y in (-half_w, half_w):
            t = bs.cylinder('tyre', x, y, 0, w, r, M['tire'], verts=24)
            t.rotation_euler = (math.radians(90), 0, 0)
            t.location = (x, y, r)
            h = bs.cylinder('rim', x, y, 0, w + 0.02, r * 0.58, M['rim'], verts=16)
            h.rotation_euler = (math.radians(90), 0, 0)
            h.location = (x, y, r)
            out += [t, h]
    return out

def _box(name, x0, x1, y0, y1, z0, z1, mat, bevel=0.0):
    return bs.boxes(name, [(x0, x1, y0, y1, z0, z1)], mat, bevel)

def _lights(M, L, hw, zf, zr, wide=0.32):
    """Modern lighting: slim LED headlight strips joined by a light bar, full-width LED tail bar."""
    h = L / 2
    _box('headL', h - 0.06, h + 0.02, -hw + 0.1, -hw + 0.1 + wide, zf, zf + 0.08, M['head'])
    _box('headR', h - 0.06, h + 0.02, hw - 0.1 - wide, hw - 0.1, zf, zf + 0.08, M['head'])
    _box('drl', h - 0.04, h + 0.015, -hw + 0.1, hw - 0.1, zf + 0.09, zf + 0.115, M['head'])
    _box('tailBar', -h - 0.02, -h + 0.05, -hw + 0.08, hw - 0.08, zr, zr + 0.07, M['tail'])

def sedan(M, paint):
    """Fastback electric sedan: short nose, raked windshield, glass roof flowing into a short deck."""
    L, W = 4.72, 1.86
    h, hw = L / 2, W / 2
    body = [(-h, 0.3), (-h, 0.78), (-h + 0.12, 0.92), (-h + 0.45, 0.99), (h - 1.15, 0.95), (h - 0.55, 0.86),
            (h - 0.18, 0.74), (h, 0.6), (h, 0.3)]
    _profile_obj('body', body, -hw, hw, M[paint], bevel=0.16, seg=4)
    cabin = [(-h + 0.42, 0.97), (-h + 1.05, 1.3), (-h + 1.75, 1.43), (h - 2.05, 1.44), (h - 1.18, 0.95)]
    _profile_obj('cabin', cabin, -hw + 0.16, hw - 0.16, M['glass'], bevel=0.12, seg=3)
    _box('sill', -h + 0.35, h - 0.35, -hw - 0.005, hw + 0.005, 0.28, 0.4, M['trim'])
    _lights(M, L, hw, 0.68, 0.86)
    _wheels(M, (-h + 0.98, h - 0.92), hw - 0.11, r=0.36, w=0.25)

def suv(M, paint):
    """Midsize electric crossover: raked windshield, falling roofline, black lower cladding."""
    L, W = 4.75, 1.95
    h, hw = L / 2, W / 2
    body = [(-h, 0.45), (-h, 1.02), (-h + 0.14, 1.12), (h - 1.05, 1.1), (h - 0.4, 1.0), (h - 0.08, 0.86), (h, 0.7), (h, 0.45)]
    _profile_obj('body', body, -hw, hw, M[paint], bevel=0.16, seg=4)
    cabin = [(-h + 0.14, 1.1), (-h + 0.38, 1.6), (-h + 0.9, 1.68), (h - 1.85, 1.7), (h - 1.06, 1.1)]
    _profile_obj('cabin', cabin, -hw + 0.12, hw - 0.12, M['glass'], bevel=0.1, seg=3)
    _box('roofPanel', -h + 0.9, h - 1.9, -hw + 0.16, hw - 0.16, 1.66, 1.72, M[paint], 0.03)
    _box('cladding', -h + 0.05, h - 0.05, -hw - 0.015, hw + 0.015, 0.38, 0.6, M['trim'], 0.03)
    _lights(M, L, hw, 0.86, 1.0)
    _wheels(M, (-h + 1.0, h - 0.95), hw - 0.1, r=0.4, w=0.28)

def pickup(M, paint):
    """Full-size crew-cab pickup: tall squared nose, high beltline, short bed."""
    L, W = 5.8, 2.05
    h, hw = L / 2, W / 2
    body = [(-h, 0.55), (-h, 1.28), (h - 1.0, 1.3), (h - 0.15, 1.24), (h, 1.05), (h, 0.55)]
    _profile_obj('body', body, -hw, hw, M[paint], bevel=0.1, seg=3)
    cabin = [(h - 3.25, 1.28), (h - 3.2, 1.98), (h - 1.85, 2.0), (h - 1.05, 1.28)]
    _profile_obj('cab', cabin, -hw + 0.08, hw - 0.08, M['glass'], bevel=0.07, seg=2)
    _box('cabRoof', h - 3.22, h - 1.86, -hw + 0.1, hw - 0.1, 1.95, 2.03, M[paint], 0.03)
    _box('bedFloor', -h + 0.1, h - 3.3, -hw + 0.1, hw - 0.1, 1.05, 1.15, M['trim'])
    _box('bedWallL', -h, h - 3.25, -hw, -hw + 0.09, 1.1, 1.36, M[paint], 0.02)
    _box('bedWallR', -h, h - 3.25, hw - 0.09, hw, 1.1, 1.36, M[paint], 0.02)
    _box('tailgate', -h, -h + 0.09, -hw, hw, 1.1, 1.36, M[paint], 0.02)
    _box('grille', h - 0.02, h + 0.03, -hw + 0.25, hw - 0.25, 0.75, 1.15, M['trim'])
    _box('cladding', -h, h, -hw - 0.012, hw + 0.012, 0.5, 0.66, M['trim'])
    _lights(M, L, hw, 1.08, 1.12)
    _wheels(M, (-h + 1.1, h - 1.25), hw - 0.1, r=0.43, w=0.3)

def van(M, paint='vanWhite'):
    """Evacuation van: tall white shuttle with an amber band and beacon."""
    L, W = 6.0, 2.1
    h, hw = L / 2, W / 2
    body = [(-h, 0.4), (-h, 2.55), (-h + 0.1, 2.65), (h - 1.2, 2.65), (h - 0.5, 1.6), (h, 1.25), (h, 0.4)]
    _profile_obj('body', body, -hw, hw, M[paint], bevel=0.12)
    _box('band', -h - 0.01, h - 0.4, -hw - 0.012, hw + 0.012, 1.1, 1.3, M['amber'])
    _box('winL', -h + 0.5, h - 1.5, -hw - 0.015, -hw + 0.02, 1.55, 2.25, M['glass'])
    _box('winR', -h + 0.5, h - 1.5, hw - 0.02, hw + 0.015, 1.55, 2.25, M['glass'])
    _profile_obj('wind', [(h - 1.18, 2.5), (h - 0.52, 1.62), (h - 0.48, 1.66), (h - 1.12, 2.56)], -hw + 0.12, hw - 0.12, M['glass'])
    _box('beacon', -0.3, 0.3, -0.45, 0.45, 2.65, 2.82, M['amber'], 0.03)
    _lights(M, L, hw, 0.95, 1.0)
    _wheels(M, (-h + 1.1, h - 1.2), hw - 0.12, r=0.38, w=0.26)

def engine(M, paint='engine'):
    """Type 1 fire engine: crew cab, pump panel, hose bed, ladder rack, light bar."""
    L, W = 9.2, 2.5
    h, hw = L / 2, W / 2
    cab = [(h - 2.6, 0.55), (h - 2.6, 3.0), (h - 0.6, 3.0), (h - 0.1, 2.3), (h, 1.3), (h, 0.55)]
    _profile_obj('cab', cab, -hw, hw, M[paint], bevel=0.1)
    _profile_obj('windshield', [(h - 0.58, 2.95), (h - 0.12, 2.32), (h - 0.07, 2.36), (h - 0.53, 2.99)], -hw + 0.12, hw - 0.12, M['glass'])
    _box('cabWinL', h - 2.4, h - 0.9, -hw - 0.015, -hw + 0.02, 1.9, 2.7, M['glass'])
    _box('cabWinR', h - 2.4, h - 0.9, hw - 0.02, hw + 0.015, 1.9, 2.7, M['glass'])
    _box('bodyRear', -h, h - 2.65, -hw, hw, 0.55, 2.55, M[paint], 0.06)
    _box('pumpPanel', h - 3.6, h - 2.65, -hw - 0.02, hw + 0.02, 0.8, 2.3, M['chrome'], 0.02)
    for x in (-h + 0.6, -h + 2.2, -h + 3.8):
        _box('doorline', x, x + 0.05, -hw - 0.01, hw + 0.01, 0.8, 2.4, M['trim'])
    _box('stripe', -h, h, -hw - 0.012, hw + 0.012, 1.15, 1.32, M['stripe'])
    _box('hosebed', -h + 0.1, h - 3.8, -hw + 0.15, hw - 0.15, 2.55, 2.75, M['trim'])
    for y in (-hw + 0.25, hw - 0.25):
        _box('ladderRail', -h - 0.2, h - 2.7, y - 0.05, y + 0.05, 2.95, 3.05, M['chrome'])
    for x in [(-h - 0.1) + i * 0.45 for i in range(14)]:
        _box('rung', x, x + 0.05, -hw + 0.25, hw - 0.25, 2.97, 3.03, M['chrome'])
    for x in (-h + 0.6, h - 3.0):
        _box('ladderPost', x, x + 0.1, -hw + 0.2, hw - 0.2, 2.55, 2.97, M['chrome'])
    _box('lightbar', h - 2.2, h - 0.9, -hw + 0.2, hw - 0.2, 3.0, 3.18, M['bar'], 0.03)
    _box('bumper', h - 0.02, h + 0.25, -hw, hw, 0.5, 0.85, M['chrome'], 0.04)
    _lights(M, L, hw, 1.05, 1.1, wide=0.28)
    _wheels(M, (-h + 1.4, -h + 2.5, h - 1.6), hw - 0.15, r=0.5, w=0.34)

MODELS = dict(
    sedanW=(sedan, 'white'), sedanK=(sedan, 'black'), sedanR=(sedan, 'red'),
    suvS=(suv, 'silver'), suvB=(suv, 'navy'), pickup=(pickup, 'tan'),
    van=(van, 'vanWhite'), engine=(engine, 'engine'),
)

def build(name, M, loc=(0, 0, 0), rot=0.0):
    """Build model `name` and place it; returns the parent empty."""
    before = set(bpy.data.objects)
    fn, paint = MODELS[name]
    fn(M, paint)
    parts = [o for o in bpy.data.objects if o not in before]
    root = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(root)
    for o in parts:
        o.parent = root
    root.location = loc
    root.rotation_euler = (0, 0, rot)
    return root
