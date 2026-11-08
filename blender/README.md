# Building sprites (Blender)

`build_sprites.py` builds every Lantern building from code and renders the isometric sprites the
web town uses. Nothing is hand-modelled, so anyone can regenerate them.

```bash
# from the repo root (Blender 4.2+; tested on 5.2, Apple Silicon GPU via Metal)
blender -b -P blender/build_sprites.py -- --scale 2 --samples 64 --format webp
# subset:  --kinds senior,office   --variants night,burning
```

Output: `web/public/sprites/<kind>_<variant>.webp` (transparent, shadows baked in).
A full run (5 kinds × 5 variants) takes about 15 minutes on an M1.

| kinds | variants |
|---|---|
| `senior` `apartments` `office` `shelter` `homes` | `night` (Night Watch) · `dusk` (Golden Hour) · `maquette` (Studio Maquette) · `burning` · `lost` |

## How the sprites line up with the map

- Orthographic camera at the true isometric angle (X 54.736°, Z 45°): the same projection as the
  SVG ground plane in `web/src/town/iso.ts`.
- 1 m in Blender = 4 map units. The sprite frame is 520 × 380 units with the building's footprint
  centre at (220, 220). `SPRITE_BOX` in `web/src/town/scene.ts` must match `BOX_W/BOX_H/ANCHOR_*` here.
- The web app scales each sprite to the building's footprint from the `building` table.
- A shadow catcher bakes the building's shadow into the transparent PNG/WebP, so it falls onto the map.
- Animated effects (flames, smoke, walking residents, rings, tags) are **not** baked. They are drawn
  live in SVG on top, so they react to Spacetime state.

Only the sun or moon casts shadows. Fire, lamp and ember lights are shadowless on purpose, because otherwise they
paint huge fake shadows across the catcher.

## Window map

`blender -b -P blender/build_sprites.py -- --export-windows` writes `web/src/town/windows.json`:
the on-screen outline of every window and door pane per building kind, in sprite-frame units.
The web app uses it to light, flicker, darken or set fire to each room on its own.
Re-run it whenever a building's facade changes.

## Ground plate

`build_ground.py` renders the whole board in one image per look: terrain (watered green in town,
golden dry grass toward the hills, chaparral on the hills), asphalt with cracks and lane paint,
concrete sidewalks with scored joints and real curbs, the park (striped lawn, gravel paths, pond,
playground, benches), the parking lots with parked cars, and the soil cut along the board edge.

```bash
blender -b -P blender/build_ground.py -- --looks dusk,night,maquette --scale 2 --samples 64
```

Output: `web/public/sprites/ground_<look>.webp` plus a smaller `ground_<look>_lite.webp` for phones
(needs `cwebp`). The frame covers view box x 0..1440, y 96..968 (`GROUND_PLATE` in `scene.ts`).
The layout numbers at the top of the script mirror `scene.ts` and `mockWorld.ts`.

## Vehicles

`vehicles.py` holds the vehicle models (fastback sedan, crossover SUV, pickup, evacuation van,
fire engine). `build_vehicles.py` renders each one facing the four street directions:

```bash
blender -b -P blender/build_vehicles.py -- --looks dusk,night --scale 3 --samples 48
```

Output: `web/public/sprites/veh_<model>_<e|w|s|n>_<look>.webp`, frame 80 × 60 with the vehicle's
ground centre at (40, 36) (`VEH_BOX` in `web/src/town/vehicleData.ts`). Night renders have the
head and tail lights on.
