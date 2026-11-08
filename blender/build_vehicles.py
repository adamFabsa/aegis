"""
Lantern vehicle sprites: modern cars, the evacuation van and the fire engine, each rendered facing the
four street directions with the same true-iso camera as the buildings, shadows baked in.

Usage (from the repo root):
  blender -b -P blender/build_vehicles.py -- --looks dusk,night --scale 3 --samples 48

Output: web/public/sprites/veh_<model>_<heading>_<look>.webp, heading e/w/s/n = map +x/-x/+y/-y.
Frame: 80 x 60 SVG units, ground centre of the vehicle at (40, 36) (VEH_BOX in web/src/town/scene.ts).
"""
import bpy, math, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_sprites as bs  # noqa: E402
import vehicles  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(name, default):
    return argv[argv.index(name) + 1] if name in argv else default

LOOKS = arg('--looks', 'dusk,night').split(',')
MODELS = arg('--models', ','.join(vehicles.MODELS)).split(',')
SCALE = float(arg('--scale', '3'))
SAMPLES = int(arg('--samples', '48'))
OUT = arg('--out', os.path.join(bs.ROOT, 'web', 'public', 'sprites'))
VW, VH, AX, AY = 80, 60, 40, 36
# map heading -> rotation of a +X-facing model (map +y is Blender -Y)
HEADINGS = dict(e=0.0, w=math.pi, s=-math.pi / 2, n=math.pi / 2)

def main():
    os.makedirs(OUT, exist_ok=True)
    bs.BOX_W, bs.BOX_H, bs.ANCHOR_X, bs.ANCHOR_Y = VW, VH, AX, AY
    for look in LOOKS:
        v = bs.VARIANT[look]
        for model in MODELS:
            bpy.ops.wm.read_factory_settings(use_empty=True)
            bs.setup_render(v)
            sc = bpy.context.scene
            sc.render.resolution_x = int(VW * SCALE)
            sc.render.resolution_y = int(VH * SCALE)
            sc.cycles.samples = SAMPLES
            sc.render.image_settings.file_format = 'WEBP'
            sc.render.image_settings.quality = 88
            bs.setup_camera()
            bs.setup_world(v)
            catcher = bs.boxes('catcher', [(-30, 30, -30, 30, -0.02, -0.001)], bs.make_mat('c', '#888888'))
            catcher.is_shadow_catcher = True
            M = vehicles.vmats(night=v['lamps'], maq=False)
            root = vehicles.build(model, M)
            scol, sstr, sdir, sang = v['sun']
            bs.light('SUN', 'sun', (0, 0, 50), sstr, scol, source=sdir, angle=sang)
            for hd, rot in HEADINGS.items():
                root.rotation_euler = (0, 0, rot)
                out = os.path.join(OUT, f'veh_{model}_{hd}_{look}.webp')
                sc.render.filepath = out
                bpy.ops.render.render(write_still=True)
                print(f'[veh] {out}', flush=True)
    print('[veh] all done', flush=True)

main()
