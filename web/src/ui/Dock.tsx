import { forwardRef } from 'react';
import type { Building, Sim } from '../town/types';
import { FIXES, REFERENCE_ETA_MIN, type FixKey, type LogEvent } from '../town/mockWorld';
import { STATUS_COLORS } from '../town/palettes';
import { statusTag } from '../town/status';
import { KIND_LABEL, fmtMin, fmtUsd } from './format';

interface DockProps {
  sim: Sim;
  buildings: Building[];
  approved: Record<number, FixKey[]>;
  events: LogEvent[];
  selected: Building | null;
  onSelect: (id: number | null) => void;
  onApprove: (id: number, key: FixKey) => void;
  onEvacuate: (id: number) => void;
  onStartFire: () => void;
  onRestart: () => void;
}

const riskColor = (r: number) => (r >= 70 ? STATUS_COLORS.red : r >= 40 ? STATUS_COLORS.amber : STATUS_COLORS.green);

/** Most urgent first: burning, behind, then the smallest margin between fire arrival and evacuation time. */
function urgency(b: Building): number {
  if (b.status === 'burning' && !b.evacStarted) return -2000;
  if (b.status === 'behind') return -1000 + (b.fireEtaMin - b.evacNeededMin);
  if (b.status === 'lost') return 9000;
  if (b.status === 'clear') return 8000;
  if (b.status === 'evacuating') return 4000 + (b.peopleOut / Math.max(1, b.residents)) * 100;
  return b.fireEtaMin >= 0 ? b.fireEtaMin - b.evacNeededMin : 6000;
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="back" onClick={onClick}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
      All buildings
    </button>
  );
}

function Feed({ events }: { events: LogEvent[] }) {
  const e = events[0];
  if (!e) return null;
  return (
    <div className={`feed ${e.tone}`} aria-live="polite">
      <span className="feed-dot" aria-hidden="true" />
      <span key={e.id} className="feed-text">{e.text}</span>
    </div>
  );
}

// ------------------------------------------------------------------ prepare
function PrepList({ sim, buildings, onSelect, onStartFire }: DockProps) {
  const list = buildings.filter((b) => b.kind !== 'shelter').sort((a, b) => b.risk - a.risk);
  const prepared = list.filter((b) => b.prepared).length;
  return (
    <>
      <div className="dock-head">
        <div>
          <h2>Prepare your buildings</h2>
          <p className="sub">{fmtUsd(sim.budgetLeft)} left · {prepared} of {list.length} prepared · tap one to fix it</p>
        </div>
        <button type="button" className="btn fire" onClick={onStartFire}>
          Start the fire
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </button>
      </div>
      <ul className="cards" aria-label="Buildings by risk">
        {list.map((b) => (
          <li key={b.id}>
            <button type="button" className="bcard" onClick={() => onSelect(b.id)}>
              <span className="bcard-risk" style={{ color: b.prepared ? STATUS_COLORS.green : riskColor(b.risk) }}>
                {b.prepared ? (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-label="Prepared"><path d="M5 12l5 5 9-10" /></svg>
                ) : Math.round(b.risk)}
              </span>
              <span className="bcard-name">{b.name}</span>
              <span className="bcard-meta">{b.prepared ? 'Prepared' : `Risk · evac ${fmtMin(b.evacNeededMin)}`}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function PrepDetail({ sim, selected: b, approved, onSelect, onApprove }: DockProps & { selected: Building }) {
  const done = approved[b.id] ?? [];
  return (
    <>
      <BackButton onClick={() => onSelect(null)} />
      <div className="dock-head">
        <div>
          <div className="eyebrow">{KIND_LABEL[b.kind]} · {b.residents} residents · {b.needsHelp} need help</div>
          <h2>{b.name}</h2>
        </div>
        <div className="kpis">
          <div className="kpi"><span className="kpi-val" style={{ color: riskColor(b.risk) }}>{Math.round(b.risk)}</span><span className="kpi-lbl">Risk</span></div>
          <div className="kpi"><span className="kpi-val">{fmtMin(b.evacNeededMin)}</span><span className="kpi-lbl">Evacuation</span></div>
        </div>
      </div>
      <ul className="fix-grid" aria-label="Fixes">
        {FIXES.map((f) => {
          const on = done.includes(f.key);
          const afford = sim.budgetLeft >= f.cost;
          return (
            <li key={f.key}>
              <button type="button" className={`fix ${on ? 'on' : ''}`} disabled={on || !afford} onClick={() => onApprove(b.id, f.key)} aria-pressed={on}>
                <span className="fix-top">
                  <span className="fix-effect">{f.addVans ? `+${f.addVans} van` : `−${f.riskDrop} risk`}</span>
                  <span className="fix-check" aria-hidden="true">
                    {on && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg>}
                  </span>
                </span>
                <span className="fix-name">{f.name}</span>
                <span className="fix-cost">{on ? 'Approved' : afford ? fmtUsd(f.cost) : `${fmtUsd(f.cost)} · over budget`}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {b.prepared ? (
        <div className="badge">Prepared · better insurance rating</div>
      ) : (
        <p className="hint">Prepared when risk is under 40 and evacuation takes under {fmtMin(REFERENCE_ETA_MIN)}. {fmtUsd(sim.budgetLeft)} left.</p>
      )}
    </>
  );
}

// ------------------------------------------------------------------ fire
function Race({ b }: { b: Building }) {
  const eta = b.fireEtaMin;
  const need = b.evacNeededMin;
  const known = eta >= 0;
  const max = Math.max(need, known ? eta : 0) * 1.12 || 1;
  const late = known && need > eta;
  return (
    <div className="race">
      <div className="race-bar" aria-hidden="true">
        <div className="race-evac" style={{ width: `${(100 * need) / max}%`, background: late ? STATUS_COLORS.red : STATUS_COLORS.green }} />
        {known && <div className="race-fire" style={{ left: `${(100 * eta) / max}%` }} />}
      </div>
      <p className={`verdict ${late ? 'bad' : 'ok'}`}>
        {!known ? 'The fire has no path here right now.' : late ? `Evacuation would end ${fmtMin(need - eta)} after the fire arrives.` : `Evacuation ends ${fmtMin(eta - need)} before the fire.`}
      </p>
    </div>
  );
}

function RowAction({ b, sim, onEvacuate }: { b: Building; sim: Sim; onEvacuate: (id: number) => void }) {
  if (b.status === 'lost') return <span className="row-state muted">Lost</span>;
  if (b.status === 'clear') return <span className="row-state ok">All out</span>;
  if (b.evacStarted) {
    const pct = (100 * b.peopleOut) / Math.max(1, b.residents);
    return (
      <span className="row-progress" aria-label={`${b.peopleOut} of ${b.residents} out`}>
        <span className="mini-bar"><span style={{ width: `${pct}%` }} /></span>
        <span>{b.peopleOut}/{b.residents}</span>
      </span>
    );
  }
  if (b.status === 'burning') return <span className="row-state bad">Burning</span>;
  if (sim.phase !== 'fire') return null;
  return (
    <button type="button" className={`btn small ${b.status === 'behind' ? 'urgent' : ''}`} onClick={(e) => { e.stopPropagation(); onEvacuate(b.id); }}>
      Evacuate
    </button>
  );
}

function FireList(p: DockProps) {
  const { sim, buildings, events, onSelect, onEvacuate } = p;
  const list = buildings.filter((b) => b.kind !== 'shelter').sort((a, b) => urgency(a) - urgency(b));
  const total = list.reduce((s, b) => s + b.residents, 0);
  const out = list.reduce((s, b) => s + b.peopleOut, 0);
  const atRisk = list.filter((b) => b.status === 'behind' || b.status === 'burning').length;
  const lost = list.filter((b) => b.status === 'lost').length;
  return (
    <>
      <div className="dock-head">
        <div>
          <h2>Who needs help first</h2>
          <p className="sub"><b className="ok">{out}</b> of {total} out · <b className={atRisk ? 'bad' : ''}>{atRisk}</b> at risk · <b>{lost}</b> lost</p>
        </div>
      </div>
      <Feed events={events} />
      <ul className="rows" aria-label="Buildings by urgency">
        {list.map((b) => {
          const tag = statusTag(b, sim.phase);
          const detail = b.evacStarted || b.status === 'lost' || b.status === 'clear'
            ? `${b.residents} residents · ${b.needsHelp} need help`
            : `${b.fireEtaMin >= 0 ? `Fire in ${fmtMin(b.fireEtaMin)}` : 'No fire path yet'} · evacuation ${fmtMin(b.evacNeededMin)}`;
          return (
            <li key={b.id}>
              <div className="row" role="button" tabIndex={0} onClick={() => onSelect(b.id)} onKeyDown={(e) => { if (e.key === 'Enter') onSelect(b.id); }}>
                <span className="row-bar" style={{ background: tag.color }} aria-hidden="true" />
                <span className="row-text">
                  <span className="row-name">{b.name}</span>
                  <span className="row-detail">{detail}</span>
                </span>
                <RowAction b={b} sim={sim} onEvacuate={onEvacuate} />
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function FireDetail(p: DockProps & { selected: Building }) {
  const { selected: b, sim, onSelect, onEvacuate } = p;
  const tag = statusTag(b, sim.phase);
  const canEvac = sim.phase === 'fire' && !b.evacStarted && b.status !== 'lost' && b.status !== 'burning';
  return (
    <>
      <BackButton onClick={() => onSelect(null)} />
      <div className="dock-head">
        <div>
          <div className="eyebrow">{KIND_LABEL[b.kind]} · {b.residents} residents · {b.needsHelp} need help · {b.vans} van{b.vans === 1 ? '' : 's'}</div>
          <h2>{b.name}</h2>
        </div>
        <span className="chip" style={{ color: tag.color, borderColor: tag.color }}>{tag.text}</span>
      </div>
      {b.kind !== 'shelter' && b.status !== 'lost' && b.status !== 'clear' && (
        <>
          <div className="kpis wide">
            <div className="kpi"><span className="kpi-val" style={{ color: STATUS_COLORS.red }}>{fmtMin(b.fireEtaMin)}</span><span className="kpi-lbl">Fire arrives in</span></div>
            <div className="kpi"><span className="kpi-val">{fmtMin(b.evacNeededMin)}</span><span className="kpi-lbl">Evacuation needs</span></div>
          </div>
          <Race b={b} />
        </>
      )}
      {canEvac && <button type="button" className="btn primary wide" onClick={() => onEvacuate(b.id)}>Start evacuation</button>}
      {b.evacStarted && (
        <div className="progress">
          <div className="progress-row"><span>Residents out</span><b>{b.peopleOut} of {b.residents}</b></div>
          <div className="meter"><div style={{ width: `${(100 * b.peopleOut) / Math.max(1, b.residents)}%` }} /></div>
        </div>
      )}
      {b.status === 'lost' && <p className="hint">Building lost. {b.residents - b.peopleOut} residents were still inside.</p>}
      {b.status === 'clear' && <p className="hint">Everyone is out and accounted for.</p>}
      {b.kind === 'shelter' && <p className="hint">Destination for every evacuation.</p>}
    </>
  );
}

// ------------------------------------------------------------------ results
function ResultsView({ sim, buildings, onRestart }: DockProps) {
  const list = buildings.filter((b) => b.kind !== 'shelter');
  const total = list.reduce((s, b) => s + b.residents, 0);
  const out = list.reduce((s, b) => s + b.peopleOut, 0);
  const lost = list.filter((b) => b.status === 'lost');
  const damage = lost.reduce((s, b) => s + b.valueUsd, 0);
  return (
    <>
      <div className="dock-head">
        <div>
          <div className="eyebrow">The fire is out · {Math.floor(sim.simMinutes / 60)}h {sim.simMinutes % 60}m after ignition</div>
          <h2>The best claim is the one that never happens</h2>
        </div>
        <button type="button" className="btn primary" onClick={onRestart}>Run again</button>
      </div>
      <dl className="result-grid">
        <div><dt>People out</dt><dd className="ok">{out}<small>/{total}</small></dd></div>
        <div><dt>Buildings lost</dt><dd className={lost.length ? 'bad' : 'ok'}>{lost.length}</dd></div>
        <div><dt>Damage</dt><dd>{fmtUsd(damage)}</dd></div>
        <div><dt>Insurance claims</dt><dd>{lost.length}</dd></div>
      </dl>
      <p className="hint">With Lantern. The without-Lantern comparison arrives with the Spacetime baseline run. All numbers are simulated.</p>
    </>
  );
}

export const Dock = forwardRef<HTMLElement, DockProps>(function Dock(props, ref) {
  const { sim, selected } = props;
  let body;
  if (sim.phase === 'ended' && !selected) body = <ResultsView {...props} />;
  else if (sim.phase === 'prep') body = selected && selected.kind !== 'shelter' ? <PrepDetail {...props} selected={selected} /> : <PrepList {...props} />;
  else body = selected ? <FireDetail {...props} selected={selected} /> : <FireList {...props} />;
  return (
    <section ref={ref} className="dock map-chrome" aria-label="Control panel">
      <div className="dock-grip" aria-hidden="true" />
      {body}
    </section>
  );
});
