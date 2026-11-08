import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MapView } from './town/MapView';
import { useMockWorld } from './town/mockWorld';
import { PALETTES } from './town/palettes';
import { groundUrl, propUrl, spriteUrl } from './town/scene';
import { vehUrl } from './town/vehicleData';
import type { BuildingKind, Pack } from './town/types';
import { TopBar, type Look } from './ui/TopBar';
import { Dock } from './ui/Dock';
import { sound } from './audio/sound';

export default function App() {
  const world = useMockWorld();
  const { sim, buildings, cells, approved, events, units } = world;
  const [look, setLook] = useState<Look>(() => {
    const l = new URLSearchParams(window.location.search).get('look');
    return l === 'night' || l === 'dusk' || l === 'maquette' ? l : 'auto';
  });
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const sel = new URLSearchParams(window.location.search).get('select');
    return sel ? Number(sel) : null;
  });

  // Warm the image cache so switching look or status never flashes an empty building.
  useEffect(() => {
    const kinds: BuildingKind[] = ['senior', 'apartments', 'office', 'shelter', 'homes'];
    for (const k of kinds) for (const v of ['night', 'dusk', 'maquette', 'burning', 'gutted', 'lost']) new Image().src = spriteUrl(k, v);
    for (const t of ['oak', 'palm', 'shrub', 'euc'] as const) for (const v of ['night', 'dusk', 'maquette'] as const) new Image().src = propUrl(t, v);
    new Image().src = propUrl('snag', 'night');
    // the ground plate and the vehicles, so starting the fire never shows an empty board
    const small = window.innerWidth < 760;
    for (const p of ['dusk', 'night', 'maquette'] as const) new Image().src = groundUrl(p, small);
    for (const m of ['sedanW', 'sedanK', 'sedanR', 'suvS', 'suvB', 'pickup', 'van', 'engine'] as const)
      for (const h of ['e', 'w', 's', 'n'] as const) for (const l of ['dusk', 'night']) new Image().src = vehUrl(m, h, l);
  }, []);

  // Demo deep link: ?phase=fire&ticks=30&evac=12&prep=12&look=night&select=12
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const q = new URLSearchParams(window.location.search);
    for (const id of (q.get('prep') ?? '').split(',').filter(Boolean)) {
      world.approveFix(Number(id), 'van');
      world.approveFix(Number(id), 'brush');
    }
    if (q.get('phase') === 'fire') {
      world.setPhase('fire');
      for (const id of (q.get('evac') ?? '').split(',').filter(Boolean)) world.startEvacuation(Number(id));
      const n = Number(q.get('ticks') ?? 0);
      if (n > 0) world.advance(n);
      if (q.get('pause') === '1') world.togglePause();
    }
  }, [world]);

  // The map frames the town in the space the floating bar and panel leave free.
  const dockRef = useRef<HTMLElement>(null);
  const [insets, setInsets] = useState({ top: 64, bottom: 240, left: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const d = dockRef.current?.getBoundingClientRect();
      const top = 12;
      // wide screens: the panel is a column on the left; phones: a sheet along the bottom
      const side = window.innerWidth > 760;
      const bottom = side ? 0 : d ? window.innerHeight - d.top + 8 : 240;
      const left = side && d ? d.right + 8 : 0;
      setInsets((p) => (Math.abs(p.top - top) > 4 || Math.abs(p.bottom - bottom) > 24 || Math.abs(p.left - left) > 4 ? { top, bottom, left } : p));
    };
    const ro = new ResizeObserver(measure);
    if (dockRef.current) ro.observe(dockRef.current);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  const pack: Pack = look === 'auto' ? (sim.phase === 'prep' ? 'dusk' : 'night') : look;
  // Phones and reduced-motion users get the lighter effects path (no noise textures, blur or blend modes).
  const [lite] = useState(() => window.innerWidth < 760 || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const selected = buildings.find((b) => b.id === selectedId) ?? null;

  // ---- sound: fire loudness follows burning buildings + fire cells; events trigger alert tones
  const [muted, setMuted] = useState(sound.muted);
  const burningBuildings = buildings.filter((b) => b.status === 'burning').length;
  const burningCells = sim.phase === 'fire' ? cells.reduce((n, c) => n + (c.state === 1 ? 1 : 0), 0) : 0;
  const fireLevel = sim.phase !== 'fire' ? 0 : Math.min(1, burningBuildings * 0.3 + burningCells / 140) * (sim.running ? 1 : 0.35);
  useEffect(() => { sound.setLevel(fireLevel); }, [fireLevel]);
  const lastEvent = useRef(0);
  useEffect(() => {
    const e = events[0];
    if (!e || e.id === lastEvent.current) return;
    const first = lastEvent.current === 0 && events.length > 1;
    lastEvent.current = e.id;
    if (first) return; // do not replay history after a deep link
    if (e.kind === 'dispatch') sound.siren(4.5);
    else if (e.kind === 'collapse') sound.crash(1);
    else if (e.kind === 'gutted') sound.crash(0.45);
    else if (e.tone === 'bad') sound.alert('fire');
    else if (e.tone === 'warn') sound.alert('behind');
    else if (e.tone === 'good') sound.alert('good');
  }, [events]);
  const toggleMute = () => { sound.unlock(); sound.setMuted(!muted); setMuted(!muted); };
  const startFire = () => { setSelectedId(null); world.setPhase('fire'); };
  const prepare = () => { setSelectedId(null); world.setPhase('prep'); };

  return (
    <div className="app" style={{ background: PALETTES[pack].bg }} onPointerDownCapture={() => sound.unlock()} onKeyDownCapture={() => sound.unlock()}>
      <MapView
        sim={sim} buildings={buildings} fireCells={cells} pack={pack}
        selectedId={selectedId} onSelect={setSelectedId}
        topInset={insets.top} bottomInset={insets.bottom} leftInset={insets.left} lite={lite} units={units}
      />
        <Dock
          ref={dockRef}
          sim={sim} buildings={buildings} approved={approved} events={events} selected={selected}
          onSelect={setSelectedId}
          onApprove={world.approveFix}
          onEvacuate={world.startEvacuation}
          onStartFire={startFire}
          onRestart={() => { world.reset(); setSelectedId(null); }}
          units={units} cells={cells}
          onDispatch={world.dispatchUnit}
          onRelease={world.releaseUnit}
          pack={pack}
          topLimit={insets.top}
          bar={
            <TopBar
              sim={sim} look={look} onLook={setLook}
              onPrepare={prepare} onStartFire={startFire}
              onTogglePause={world.togglePause}
              muted={muted} onToggleMute={toggleMute}
              onReset={() => { world.reset(); setSelectedId(null); }}
            />
          }
        />
    </div>
  );
}
