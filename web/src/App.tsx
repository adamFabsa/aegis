import { useEffect, useRef, useState } from 'react';
import { Town } from './town/Town';
import { statusTag } from './town/status';
import { useMockWorld } from './town/mockWorld';
import { PALETTES, STATUS_COLORS } from './town/palettes';
import type { Pack } from './town/types';

type Look = 'auto' | Pack;

function fmtMin(m: number): string {
  if (m < 0 || !Number.isFinite(m)) return '—';
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return h ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
}

function fmtClock(min: number): string {
  const h = Math.floor(min / 60);
  return `T+${h}:${String(min % 60).padStart(2, '0')}`;
}

function LanternMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#F2A93B" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 3h6" /><path d="M12 3v2" />
      <path d="M7 8a5 5 0 0 1 10 0v8a3 3 0 0 1-3 3h-4a3 3 0 0 1-3-3z" />
      <path d="M12 10c1.2 1.3 1.6 2.4 1 3.6a1.2 1.2 0 0 1-2 0c-.6-1.2-.2-2.3 1-3.6z" />
      <path d="M9 21h6" />
    </svg>
  );
}

export default function App() {
  const world = useMockWorld();
  const { sim, buildings, cells } = world;
  const [look, setLook] = useState<Look>(() => {
    const l = new URLSearchParams(window.location.search).get('look');
    return l === 'night' || l === 'dusk' || l === 'maquette' ? l : 'auto';
  });
  const [selectedId, setSelectedId] = useState<number | null>(12);

  // On phones the town is wider than the screen: start the pan centred on the map.
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stageRef.current;
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = (el.scrollWidth - el.clientWidth) * 0.55;
  }, []);

  // Demo deep link: ?phase=fire&ticks=30&evac=12&prep=12&look=night
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const q = new URLSearchParams(window.location.search);
    for (const id of (q.get('prep') ?? '').split(',').filter(Boolean)) world.togglePrepared(Number(id));
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
      <header className="topbar">
        <div className="brand">
          <LanternMark />
          <div>
            <div className="brand-name">Lantern</div>
            <div className="brand-sub">Eaton Fire replay · simulated neighborhood</div>
          </div>
        </div>

        <div className="controls">
          <div className="seg" role="group" aria-label="Phase">
            <button type="button" className={sim.phase === 'prep' ? 'on' : ''} onClick={() => world.setPhase('prep')}>Prep</button>
            <button type="button" className={sim.phase !== 'prep' ? 'on fire' : ''} onClick={() => sim.phase === 'prep' && world.setPhase('fire')}>Fire</button>
          </div>
          <div className="seg" role="group" aria-label="Look">
            {(['auto', 'night', 'dusk', 'maquette'] as Look[]).map((l) => (
              <button key={l} type="button" className={look === l ? 'on' : ''} onClick={() => setLook(l)}>
                {l === 'auto' ? 'Auto' : PALETTES[l].label}
              </button>
            ))}
          </div>
          <div className="clock" aria-live="polite">{fmtClock(sim.simMinutes)}</div>
          {sim.phase === 'fire' && (
            <button type="button" className="ghost" onClick={world.togglePause}>{sim.running ? 'Pause' : 'Resume'}</button>
          )}
          <button type="button" className="ghost" onClick={() => { world.reset(); setSelectedId(12); }}>Reset</button>
        </div>

        <div className="counters">
          <div className="counter"><span className="num" style={{ color: STATUS_COLORS.green }}>{safe}/{total}</span><span className="lbl">People out</span></div>
          <div className="counter"><span className="num" style={{ color: atRisk ? STATUS_COLORS.red : undefined }}>{atRisk}</span><span className="lbl">At risk</span></div>
          <div className="counter"><span className="num" style={{ color: lost ? STATUS_COLORS.gray : undefined }}>{lost}</span><span className="lbl">Lost</span></div>
        </div>
      </header>

      <main className="stage-wrap">
        <div className="stage" ref={stageRef} style={{ background: PALETTES[pack].bg }}>
          <Town sim={sim} buildings={buildings} fireCells={cells} pack={pack} selectedId={selectedId} onSelect={setSelectedId} />
          <div className="wind-chip">Wind toward SW · {sim.windMph} mph</div>
          <div className="sim-note">Simulated neighborhood · local mock sim until Spacetime is connected</div>
        </div>

        {selected && (
          <aside className="card" aria-label={`${selected.name} details`}>
            <div className="card-head">
              <h2>{selected.name}</h2>
              {(() => {
                const t = statusTag(selected, sim.phase);
                return <span className="chip" style={{ color: t.color, borderColor: t.color }}>{t.text}</span>;
              })()}
            </div>
            <div className="card-kind">{selected.kind} · {selected.residents} residents · {selected.needsHelp} need help · {selected.staff} staff · {selected.vans} van{selected.vans === 1 ? '' : 's'}</div>

            {selected.kind === 'shelter' ? (
              <p className="muted">Evacuation destination for every building.</p>
            ) : sim.phase === 'prep' ? (
              <>
                <div className="metrics">
                  <div><span className="lbl">Risk</span><span className="big">{Math.round(selected.risk)}</span></div>
                  <div><span className="lbl">Evacuation needs</span><span className="big">{fmtMin(selected.evacNeededMin)}</span></div>
                </div>
                <button type="button" className={selected.prepared ? 'btn ghost' : 'btn primary'} onClick={() => world.togglePrepared(selected.id)}>
                  {selected.prepared ? 'Undo prep fixes' : 'Approve prep fixes (van + brush)'}
                </button>
                {selected.prepared && <div className="badge">Prepared · better insurance rating</div>}
              </>
            ) : (
              <>
                <div className="metrics">
                  <div><span className="lbl">Fire arrives in</span><span className="big" style={{ color: STATUS_COLORS.red }}>{fmtMin(selected.fireEtaMin)}</span></div>
                  <div><span className="lbl">Evacuation needs</span><span className="big">{fmtMin(selected.evacNeededMin)}</span></div>
                </div>
                {!selected.evacStarted && selected.status !== 'lost' && selected.status !== 'burning' ? (
                  <button type="button" className="btn primary" onClick={() => world.startEvacuation(selected.id)}>Start evacuation</button>
                ) : (
                  <div className="progress" aria-label="Evacuation progress">
                    <div className="bar"><div style={{ width: `${(100 * selected.peopleOut) / Math.max(1, selected.residents)}%` }} /></div>
                    <span>{selected.peopleOut} of {selected.residents} out</span>
                  </div>
                )}
              </>
            )}
          </aside>
        )}
      </main>
    </div>
  );
}
