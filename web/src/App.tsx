import { useEffect, useRef, useState } from 'react';
import { MapView } from './town/MapView';
import { useMockWorld } from './town/mockWorld';
import { PALETTES, STATUS_COLORS } from './town/palettes';
import type { Pack } from './town/types';
import { Header } from './ui/Header';
import { BuildingCard } from './ui/BuildingCard';
import { Results } from './ui/Results';
import { propUrl, spriteUrl } from './town/scene';
import type { BuildingKind } from './town/types';

type Look = 'auto' | Pack;
const LOOKS: { id: Look; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'night', label: 'Night' },
  { id: 'dusk', label: 'Dusk' },
  { id: 'maquette', label: 'Model' },
];

export default function App() {
  const world = useMockWorld();
  const { sim, buildings, cells, approved } = world;
  const [look, setLook] = useState<Look>(() => {
    const l = new URLSearchParams(window.location.search).get('look');
    return l === 'night' || l === 'dusk' || l === 'maquette' ? l : 'auto';
  });
  // phones start with the whole map visible; desktop opens Building 12's card
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    const sel = new URLSearchParams(window.location.search).get('select');
    return sel ? Number(sel) : window.innerWidth >= 760 ? 12 : null;
  });

  // Warm the image cache so switching look or status never flashes an empty building.
  useEffect(() => {
    const kinds: BuildingKind[] = ['senior', 'apartments', 'office', 'shelter', 'homes'];
    for (const k of kinds) for (const v of ['night', 'dusk', 'maquette', 'burning', 'lost']) new Image().src = spriteUrl(k, v);
    for (const t of ['oak', 'palm', 'shrub'] as const) for (const v of ['night', 'dusk', 'maquette'] as const) new Image().src = propUrl(t, v);
    new Image().src = propUrl('snag', 'night');
  }, []);
  const [hideResults, setHideResults] = useState(false);

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

  const pack: Pack = look === 'auto' ? (sim.phase === 'prep' ? 'dusk' : 'night') : look;
  const selected = buildings.find((b) => b.id === selectedId) ?? null;
  const people = buildings.filter((b) => b.kind !== 'shelter');
  const total = people.reduce((s, b) => s + b.residents, 0);
  const safe = people.reduce((s, b) => s + b.peopleOut, 0); // anyone already out is safe, even if the building is later lost
  const atRisk = people.filter((b) => b.status === 'behind' || b.status === 'burning').length;
  const lost = people.filter((b) => b.status === 'lost').length;

  return (
    <div className="app">
      <Header
        sim={sim} safe={safe} total={total} atRisk={atRisk} lost={lost}
        onPhase={world.setPhase}
        onTogglePause={world.togglePause}
        onReset={() => { world.reset(); setSelectedId(window.innerWidth >= 760 ? 12 : null); }}
      />

      <main className={`main ${selected ? 'has-card' : ''} ${sim.phase === 'ended' && !hideResults ? 'has-results' : ''}`} style={{ background: PALETTES[pack].bg }}>
        <MapView sim={sim} buildings={buildings} fireCells={cells} pack={pack} selectedId={selectedId} onSelect={setSelectedId}>
          <div className="map-chrome looks" role="group" aria-label="Look">
            {LOOKS.map((l) => (
              <button key={l.id} type="button" className={look === l.id ? 'on' : ''} onClick={() => setLook(l.id)}>{l.label}</button>
            ))}
          </div>
          <div className="map-chrome wind" aria-label="Wind">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 8h11a3 3 0 1 0-3-3" /><path d="M3 12h16a3 3 0 1 1-3 3" /><path d="M3 16h7" /></svg>
            SW · {sim.windMph} mph
          </div>
          <div className="map-chrome legend" aria-label="Legend">
            <span><i style={{ background: STATUS_COLORS.green }} />Prepared · clear</span>
            <span><i style={{ background: STATUS_COLORS.amber }} />Evacuating</span>
            <span><i style={{ background: STATUS_COLORS.red }} />Behind · burning</span>
            <span><i style={{ background: STATUS_COLORS.gray }} />Lost</span>
          </div>
          {!selected && sim.phase !== 'ended' && <div className="map-hint">Tap a building</div>}
          {sim.phase === 'ended' && !hideResults && (
            <Results sim={sim} buildings={buildings} onClose={() => setHideResults(true)} onRestart={() => { world.reset(); setHideResults(false); }} />
          )}
        </MapView>

        {selected && (
          <BuildingCard
            b={selected}
            sim={sim}
            approved={approved[selected.id] ?? []}
            onApprove={(k) => world.approveFix(selected.id, k)}
            onEvacuate={() => world.startEvacuation(selected.id)}
            onClose={() => setSelectedId(null)}
          />
        )}
      </main>
      <footer className="simnote">Simulated neighborhood · fire calibrated to the Eaton Fire · local mock until Spacetime is connected</footer>
    </div>
  );
}
