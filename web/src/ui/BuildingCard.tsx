import type { Building, Sim } from '../town/types';
import { FIXES, REFERENCE_ETA_MIN, type FixKey } from '../town/mockWorld';
import { statusTag } from '../town/status';
import { STATUS_COLORS } from '../town/palettes';
import { KIND_LABEL, fmtMin, fmtUsd } from './format';

interface CardProps {
  b: Building;
  sim: Sim;
  approved: FixKey[];
  onApprove: (key: FixKey) => void;
  onEvacuate: () => void;
  onClose: () => void;
}

function riskColor(r: number) {
  return r >= 70 ? STATUS_COLORS.red : r >= 40 ? STATUS_COLORS.amber : STATUS_COLORS.green;
}

function Race({ b }: { b: Building }) {
  const eta = b.fireEtaMin;
  const need = b.evacNeededMin;
  const known = eta >= 0;
  const max = Math.max(need, known ? eta : 0) * 1.12 || 1;
  const late = known && need > eta;
  const gap = known ? Math.abs(eta - need) : 0;
  return (
    <section className="race" aria-label="Fire arrival versus evacuation time">
      <div className="race-nums">
        <div><span className="lbl">Fire arrives in</span><span className="big" style={{ color: STATUS_COLORS.red }}>{fmtMin(eta)}</span></div>
        <div><span className="lbl">Evacuation needs</span><span className="big">{fmtMin(need)}</span></div>
      </div>
      <div className="race-bar" aria-hidden="true">
        <div className="race-evac" style={{ width: `${(100 * need) / max}%`, background: late ? STATUS_COLORS.red : STATUS_COLORS.green }} />
        {known && <div className="race-fire" style={{ left: `${(100 * eta) / max}%` }} />}
      </div>
      <p className={`verdict ${late ? 'bad' : 'ok'}`}>
        {!known ? 'Fire has no path to this building right now.' : late ? `Evacuation would finish ${fmtMin(gap)} after the fire arrives.` : `Evacuation finishes ${fmtMin(gap)} before the fire.`}
      </p>
    </section>
  );
}

export function BuildingCard({ b, sim, approved, onApprove, onEvacuate, onClose }: CardProps) {
  const tag = statusTag(b, sim.phase);
  const shelter = b.kind === 'shelter';
  const canEvac = sim.phase === 'fire' && !b.evacStarted && b.status !== 'lost' && b.status !== 'burning';

  return (
    <aside className="card" aria-label={`${b.name} details`}>
      <div className="sheet-handle" aria-hidden="true" />
      <div className="card-head">
        <div>
          <div className="eyebrow">{KIND_LABEL[b.kind]}</div>
          <h2>{b.name}</h2>
        </div>
        <span className="chip" style={{ color: tag.color, borderColor: tag.color }}>{tag.text}</span>
        <button type="button" className="icon-btn close" aria-label="Close details" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>

      {!shelter && (
        <dl className="facts">
          <div><dt>Residents</dt><dd>{b.residents}</dd></div>
          <div><dt>Need help</dt><dd>{b.needsHelp}</dd></div>
          <div><dt>Staff</dt><dd>{b.staff}</dd></div>
          <div><dt>Vans</dt><dd>{b.vans}</dd></div>
        </dl>
      )}

      {shelter && <p className="muted">Destination for every evacuation. Residents check in here.</p>}

      {!shelter && sim.phase === 'prep' && (
        <>
          <section className="block">
            <div className="row"><span className="lbl">Fire risk</span><span className="big" style={{ color: riskColor(b.risk) }}>{Math.round(b.risk)}</span></div>
            <div className="meter" aria-hidden="true"><div style={{ width: `${b.risk}%`, background: riskColor(b.risk) }} /></div>
            <div className="row"><span className="lbl">Evacuation needs</span><span className="mid">{fmtMin(b.evacNeededMin)}</span></div>
          </section>

          <section className="block">
            <div className="row"><h3>Fixes</h3><span className="lbl">Budget left {fmtUsd(sim.budgetLeft)}</span></div>
            <ul className="fixes">
              {FIXES.map((f) => {
                const done = approved.includes(f.key);
                const afford = sim.budgetLeft >= f.cost;
                return (
                  <li key={f.key} className={done ? 'done' : ''}>
                    <div className="fix-text">
                      <span className="fix-name">{f.name}</span>
                      <span className="fix-meta">{fmtUsd(f.cost)} · {f.addVans ? `+${f.addVans} van` : `−${f.riskDrop} risk`}</span>
                    </div>
                    {done ? (
                      <span className="fix-done">Approved</span>
                    ) : (
                      <button type="button" className="btn small" disabled={!afford} onClick={() => onApprove(f.key)}>{afford ? 'Approve' : 'Over budget'}</button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {b.prepared ? (
            <div className="badge">Prepared · better insurance rating</div>
          ) : (
            <p className="hint">Prepared when risk is under 40 and evacuation takes under {fmtMin(REFERENCE_ETA_MIN)}.</p>
          )}
        </>
      )}

      {!shelter && sim.phase !== 'prep' && (
        <>
          {b.status !== 'lost' && b.status !== 'clear' && <Race b={b} />}
          {canEvac && <button type="button" className="btn primary" onClick={onEvacuate}>Start evacuation</button>}
          {b.evacStarted && (
            <div className="progress" aria-label="Evacuation progress">
              <div className="row"><span className="lbl">Residents out</span><span className="mid">{b.peopleOut} of {b.residents}</span></div>
              <div className="meter"><div style={{ width: `${(100 * b.peopleOut) / Math.max(1, b.residents)}%`, background: STATUS_COLORS.green }} /></div>
            </div>
          )}
          {b.status === 'lost' && <p className="muted">Building lost. {b.residents - b.peopleOut} residents were still inside.</p>}
          {b.status === 'clear' && <p className="muted">Everyone is out and accounted for.</p>}
        </>
      )}
    </aside>
  );
}
