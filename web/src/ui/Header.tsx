import type { Sim } from '../town/types';
import { fmtClock, fmtUsd } from './format';

interface HeaderProps {
  sim: Sim;
  safe: number;
  total: number;
  atRisk: number;
  lost: number;
  onPhase: (p: 'prep' | 'fire') => void;
  onTogglePause: () => void;
  onReset: () => void;
}

function LanternMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#F2A93B" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 3h6" /><path d="M12 3v2" />
      <path d="M7 8a5 5 0 0 1 10 0v8a3 3 0 0 1-3 3h-4a3 3 0 0 1-3-3z" />
      <path d="M12 10c1.2 1.3 1.6 2.4 1 3.6a1.2 1.2 0 0 1-2 0c-.6-1.2-.2-2.3 1-3.6z" />
      <path d="M9 21h6" />
    </svg>
  );
}

export function Header({ sim, safe, total, atRisk, lost, onPhase, onTogglePause, onReset }: HeaderProps) {
  const fire = sim.phase !== 'prep';
  return (
    <header className="topbar">
      <div className="brand">
        <LanternMark />
        <div className="brand-text">
          <div className="brand-name">Lantern</div>
          <div className="brand-sub">Eaton Fire replay · simulated neighborhood</div>
        </div>
        <button type="button" className="icon-btn reset-phone" aria-label="Reset simulation" onClick={onReset}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
        </button>
      </div>

      <div className="phasebar">
        <div className="seg" role="group" aria-label="Phase">
          <button type="button" className={!fire ? 'on' : ''} onClick={() => onPhase('prep')}>Prep</button>
          <button type="button" className={fire ? 'on fire' : ''} onClick={() => !fire && onPhase('fire')}>Fire</button>
        </div>
        <div className="clock" aria-live="off">
          <span className="clock-label">{sim.phase === 'ended' ? 'Fire out at' : fire ? 'Since ignition' : 'Prep budget'}</span>
          <span className="clock-time">{fire ? fmtClock(sim.simMinutes) : fmtUsd(sim.budgetLeft)}</span>
        </div>
        {sim.phase === 'fire' && (
          <button type="button" className="icon-btn" aria-label={sim.running ? 'Pause' : 'Resume'} onClick={onTogglePause}>
            {sim.running ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z" /></svg>
            )}
          </button>
        )}
        <button type="button" className="icon-btn reset-desk" aria-label="Reset simulation" onClick={onReset}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>
        </button>
      </div>

      <dl className="stats">
        <div className="stat"><dt>People out</dt><dd className="ok">{safe}<small>/{total}</small></dd></div>
        <div className="stat"><dt>At risk</dt><dd className={atRisk ? 'bad' : ''}>{atRisk}</dd></div>
        <div className="stat"><dt>Lost</dt><dd className={lost ? 'muted' : ''}>{lost}</dd></div>
      </dl>
    </header>
  );
}
