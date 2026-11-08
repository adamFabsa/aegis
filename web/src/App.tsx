import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MapView } from './town/MapView';
import { useMockWorld } from './town/mockWorld';
import { useLiveWorld } from './town/liveWorld';
import { PALETTES } from './town/palettes';
import { groundUrl, propUrl, spriteUrl } from './town/scene';
import { setViewRotation } from './town/iso';
import { ready, useAssetVersion } from './town/assets';
import { vehUrl } from './town/vehicleData';
import type { BuildingKind, Pack } from './town/types';
import { TopBar, type Look } from './ui/TopBar';
import { Dock } from './ui/Dock';
import { Phone } from './ui/Phone';
import { BuildingCard } from './ui/BuildingCard';
import { ScenarioBar } from './ui/ScenarioBar';
import { useScenarioPick } from './ui/scenarioPick';
import { sound } from './audio/sound';

// Live SpacetimeDB world by default; ?mock=1 runs B's offline stand-in (no server needed).
// Chosen once per page load, so the hook order never changes.
const MOCK = new URLSearchParams(window.location.search).get('mock') === '1';
const useWorld = MOCK ? useMockWorld : useLiveWorld;

export default function App() {
  const world = useWorld();
  const { sim, buildings, cells, approved, events, units } = world;
  const appReady = !world.connection || (world.connection.state === 'live' && buildings.length > 0);
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
    // re-attach once the live world has arrived (the dock is not on screen while connecting)
  }, [appReady]);

  // camera turns in 90 degree steps; set before anything below projects a point
  const [rotation, setRotation] = useState(() => Number(new URLSearchParams(window.location.search).get('rot') ?? 0) % 4);
  setViewRotation(rotation);
  const onRotate = useCallback((dir: 1 | -1) => setRotation((r) => (r + dir + 4) % 4), []);
  const closeCard = useCallback(() => setSelectedId(null), []);
  // the turn buttons appear only once the turned renders exist for this look
  useAssetVersion();

  const pack: Pack = look === 'auto' ? (sim.phase === 'prep' ? 'dusk' : 'night') : look;
  // Phones and reduced-motion users get the lighter effects path (no noise textures, blur or blend modes).
  const [lite] = useState(() => window.innerWidth < 760 || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const selected = buildings.find((b) => b.id === selectedId) ?? null;
  // random scenarios: where the fire starts, the trees' scatter, and picking a new fire start on the map
  const pick = useScenarioPick(world);
  const scenario = world.scenario;
  const ignition = useMemo(() => (scenario ? { x: scenario.ignitionX, y: scenario.ignitionY, picked: scenario.picked } : null), [scenario]);

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

  // layout: phones get the phone as a panel tab; wide screens get a drawn phone beside the map
  const [vw, setVw] = useState(() => window.innerWidth);
  useEffect(() => { const on = () => setVw(window.innerWidth); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on); }, []);
  const [phoneOpen, setPhoneOpen] = useState(true);
  const phoneLayout = vw <= 760;
  // the phone carries Lantern AI's instructions in every phase, so it is on screen from the start
  const showFrame = vw >= 1180 && phoneOpen;
  const phoneProps = {
    sim, buildings, persons: world.persons, tasks: world.tasks,
    onReply: world.replyCheckin, onClaim: world.claimTask, onDone: world.completeTask,
    units, fixesFor: world.fixesFor, approved, profileFor: world.profileFor, checklistFor: world.checklistFor,
    results: world.results, selectedId, workerOnline: world.live?.workerOnline,
    onApprove: world.approveFix, onRecommend: world.approveRecommended, onEvacuate: world.startEvacuation,
    onDispatch: world.dispatchUnit, onAssign: world.assignStaff, onSelect: setSelectedId,
  };
  const view = new URLSearchParams(window.location.search).get('view');
  const startFire = () => { setSelectedId(null); world.setPhase('fire'); };
  const prepare = () => { setSelectedId(null); world.setPhase('prep'); };

  // Live mode: wait for the server's first snapshot before drawing the town.
  const conn = world.connection;
  if (conn && !appReady) {
    const offline = new URL(window.location.href);
    offline.searchParams.set('mock', '1');
    return (
      <div className="phone-page" style={{ justifyContent: 'center', textAlign: 'center' }}>
        <p className="eyebrow">Lantern</p>
        <h2>{conn.state === 'error' ? 'Can’t reach the Lantern server' : 'Connecting to Lantern…'}</h2>
        <p className="hint">{conn.server}{conn.message ? ` · ${conn.message}` : ''}</p>
        {conn.state === 'error' && <button type="button" className="btn primary wide" onClick={() => window.location.assign(offline.toString())}>Open the offline demo instead</button>}
      </div>
    );
  }

  // ?view=phone: the phone on its own, full screen (judges' own phones, live-synced through Spacetime)
  if (view === 'phone') {
    const q = new URLSearchParams(window.location.search);
    return (
      <div className="phone-page">
        <Phone {...phoneProps} initialRole={q.get('role') === 'staff' ? 'staff' : q.get('role') === 'resident' ? 'resident' : undefined} initialPerson={q.get('id') ? Number(q.get('id')) : undefined} initialStaff={q.get('name') ?? undefined} />
        {sim.phase === 'prep' && <button type="button" className="btn fire wide" onClick={startFire}>Start the fire</button>}
      </div>
    );
  }

  return (
    <div className="app" style={{ background: PALETTES[pack].bg }} onPointerDownCapture={() => sound.unlock()} onKeyDownCapture={() => sound.unlock()}>
      <MapView
        sim={sim} buildings={buildings} fireCells={cells} pack={pack}
        selectedId={selectedId} onSelect={setSelectedId}
        topInset={insets.top} bottomInset={insets.bottom} leftInset={insets.left} rightInset={showFrame ? 336 : 0} lite={lite} units={units}
        rotation={rotation} onRotate={[1, 2, 3].every((r) => ready(spriteUrl('homes', pack, r)) && ready(spriteUrl('office', pack, r))) ? onRotate : undefined}
        onPhone={vw >= 1180 && !phoneOpen ? () => setPhoneOpen(true) : undefined}
        // the live module ticks once per second; the mock runs its own clock
        tickSeconds={MOCK ? undefined : 1}
        plantSeed={scenario?.number || 7} ignition={ignition} onPickGround={pick.onPick}
      />
      {phoneLayout ? (
        <>
          {world.live && <LiveChip tick={sim.tick} phase={sim.phase} devices={world.live.devices} worker={world.live.workerOnline} style={{ right: 8, top: 'calc(180px + env(safe-area-inset-top))' }} />}
          <ScenarioBar world={world} pick={pick} onNew={() => setSelectedId(null)} compact style={{ right: 8, top: 'calc(216px + env(safe-area-inset-top))' }} />
        </>
      ) : (
        // live chip and scenario bar side by side along the bottom of the map
        <div className="chrome-row" style={{ left: insets.left + 4, bottom: 16 }}>
          {world.live && <LiveChip tick={sim.tick} phase={sim.phase} devices={world.live.devices} worker={world.live.workerOnline} style={{}} />}
          <ScenarioBar world={world} pick={pick} onNew={() => setSelectedId(null)} band={{ left: insets.left, right: showFrame ? 336 : 0 }} />
        </div>
      )}
      {/* wide screens: the selected building's card on the map, pointing at it (phones: the panel sheet) */}
      {selected && !phoneLayout && (
        <BuildingCard b={selected} world={world} left={insets.left} right={showFrame ? 336 : 0} top={insets.top} onClose={closeCard} />
      )}
      {showFrame && <Phone {...phoneProps} framed onClose={() => setPhoneOpen(false)} />}
        <Dock
          ref={dockRef}
          sim={sim} buildings={buildings} approved={approved} events={events} selected={selected}
          onSelect={setSelectedId}
          onApprove={world.approveFix}
          fixesFor={world.fixesFor}
          prepared={world.prepared}
          onRecommend={world.approveRecommended}
          onEndCompare={world.endAndCompare}
          profileFor={world.profileFor}
          checklistFor={world.checklistFor}
          onEvacuate={world.startEvacuation}
          onStartFire={startFire}
          onRestart={() => { world.reset(); setSelectedId(null); }}
          units={units} cells={cells}
          onDispatch={world.dispatchUnit}
          onRelease={world.releaseUnit}
          pack={pack}
          topLimit={insets.top}
          persons={world.persons}
          tasks={world.tasks}
          results={world.results}
          phone={phoneLayout ? <Phone {...phoneProps} /> : undefined}
          bar={
            <TopBar
              sim={sim} look={look} onLook={setLook}
              onPrepare={prepare} onStartFire={startFire}
              onTogglePause={world.togglePause}
              speed={world.speed} onSpeed={world.setSpeed}
              muted={muted} onToggleMute={toggleMute}
              onReset={() => { world.reset(); setSelectedId(null); }}
            />
          }
        />
    </div>
  );
}

/** Proof the app runs on SpacetimeDB: the shared tick and every connected device, live. */
function LiveChip({ tick, phase, devices, worker, style }: { tick: number; phase: string; devices: number; worker: boolean; style: React.CSSProperties }) {
  return (
    <div className="wind live-chip map-chrome" style={style} aria-label={`Live on SpacetimeDB, ${devices} devices connected`}>
      <span className="dot" aria-hidden="true" />
      <span>
        <b>Live on SpacetimeDB</b>
        <small>{phase === 'fire' ? `tick ${tick} · ` : ''}{devices} device{devices === 1 ? '' : 's'}{worker ? ' · AI worker on' : ''}</small>
      </span>
    </div>
  );
}
