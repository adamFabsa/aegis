import type { Building, Sim } from '../town/types';
import { fmtClock, fmtUsd } from './format';

interface ResultsProps {
  sim: Sim;
  buildings: Building[];
  onRestart: () => void;
  onClose: () => void;
}

/** Shown when the fire burns out. The "without Lantern" column arrives with run_baseline (spec §4). */
export function Results({ sim, buildings, onRestart, onClose }: ResultsProps) {
  const homes = buildings.filter((b) => b.kind !== 'shelter');
  const total = homes.reduce((s, b) => s + b.residents, 0);
  const out = homes.reduce((s, b) => s + b.peopleOut, 0);
  const lost = homes.filter((b) => b.status === 'lost');
  const damage = lost.reduce((s, b) => s + b.valueUsd, 0);
  return (
    <section className="map-chrome results" aria-label="Results">
      <div className="results-head">
        <div>
          <div className="eyebrow">Fire is out · {fmtClock(sim.simMinutes)} after ignition</div>
          <h2>With Lantern</h2>
        </div>
        <button type="button" className="icon-btn close" aria-label="Hide results" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      <dl className="results-grid">
        <div><dt>People out</dt><dd className="ok">{out}<small>/{total}</small></dd></div>
        <div><dt>Buildings lost</dt><dd className={lost.length ? 'bad' : 'ok'}>{lost.length}</dd></div>
        <div><dt>Damage</dt><dd>{fmtUsd(damage)}</dd></div>
        <div><dt>Insurance claims</dt><dd>{lost.length}</dd></div>
      </dl>
      <p className="hint">“The best claim is the one that never happens.” The without-Lantern comparison appears once the Spacetime baseline run is connected. All numbers are simulated.</p>
      <button type="button" className="btn primary" onClick={onRestart}>Run it again</button>
    </section>
  );
}
