// Random scenarios on the same town (live only): roll a new world, go back to the Eaton demo map, or pick
// where the fire starts by clicking the ground. The server re-scores every building and re-runs the fire
// (scenario.ts), so the dock, the markers and the phone's AI coach all follow on their own.
import { useState, type CSSProperties } from 'react';
import type { WorldApi } from '../town/world';
import { settle, tidy, type ScenarioPick } from './scenarioPick';

const ICON = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const Dice = () => (
  <svg {...ICON}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
    {[[8.5, 8.5], [15.5, 8.5], [12, 12], [8.5, 15.5], [15.5, 15.5]].map(([x, y]) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.2" fill="currentColor" stroke="none" />)}
  </svg>
);
const MapIcon = () => <svg {...ICON}><path d="M9 4 3.5 6.3v13.5L9 17.5l6 2.5 5.5-2.3V4.2L15 6.5z" /><path d="M9 4v13.5M15 6.5V20" /></svg>;
const Crosshair = () => <svg {...ICON}><circle cx="12" cy="12" r="6.5" /><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /></svg>;
const Flame = () => <svg {...ICON} width={20} height={20}><path d="M12 3c.5 3 4.5 5 4.5 10a4.5 4.5 0 0 1-9 0c0-2.5 1.5-3.5 1.8-6 1.6 1 2.7 2.4 2.7 4.5" /></svg>;

interface ScenarioBarProps {
  world: WorldApi;
  pick: ScenarioPick;
  /** a new world arrived (clear the selection) */
  onNew?: () => void;
  /** phones: icon buttons only */
  compact?: boolean;
  style?: CSSProperties;
  /** screen pixels the panel (left) and the drawn phone (right) cover, to centre the hint over the map */
  band?: { left: number; right: number };
}

export function ScenarioBar({ world, pick, onNew, compact = false, style, band = { left: 0, right: 0 } }: ScenarioBarProps) {
  const { scenario, newScenario } = world;
  const [pending, setPending] = useState<'new' | 'demo' | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!scenario || !newScenario) return null; // the offline mock has no scenarios

  const prep = world.sim.phase === 'prep';
  const canPick = prep && !!world.setIgnition;
  const run = async (n: number, kind: 'new' | 'demo') => {
    if (pending) return;
    pick.cancel();
    setPending(kind);
    setError(null);
    const err = await settle(newScenario(n));
    setPending(null);
    if (err) setError(tidy(err));
    else onNew?.();
  };
  const roll = () => void run(1 + Math.floor(Math.random() * 99999), 'new');
  const demo = () => void run(0, 'demo');
  const togglePick = () => (pick.picking ? pick.cancel() : pick.start());

  const sub = error ?? (scenario.picked ? 'Fire start picked' : scenario.number ? 'Random scenario' : 'Eaton Fire replay');
  const busyLabel = pending === 'new' ? 'Generating…' : null;

  const banner = pick.picking && (
    <div className="pick-banner map-chrome" role="status" aria-live="polite"
      style={compact ? undefined : { left: `calc(${band.left}px + (100vw - ${band.left + band.right}px) / 2)`, maxWidth: `calc(100vw - ${band.left + band.right + 32}px)` }}>
      <span className="pb-flame"><Flame /></span>
      <span className="pb-text">
        <b>{pick.busy ? 'Re-running the fire from there…' : `${compact ? 'Tap' : 'Click'} where the fire should start`}</b>
        {pick.error
          ? <small className="err">{pick.error}</small>
          : <small>{pick.busy ? 'Aegis re-ranks every building for the new fire start.' : 'Grass or brush. Aegis re-runs the fire from there.'}</small>}
      </span>
      <button type="button" className="sc-btn" onClick={pick.cancel}>Cancel</button>
    </div>
  );

  if (compact) {
    return (
      <>
        <div className="scenario-bar compact map-chrome" role="group" aria-label={`Scenario: ${scenario.label}`} style={style}>
          <span className="sc-num" title={scenario.label}>{scenario.number ? `#${scenario.number}` : 'Demo'}</span>
          <button type="button" className={`sc-btn${pending === 'new' ? ' busy' : ''}`} onClick={roll} disabled={!!pending} aria-label={busyLabel ?? 'New scenario'} title={busyLabel ?? 'New scenario'}><Dice /></button>
          {scenario.number !== 0 && <button type="button" className={`sc-btn${pending === 'demo' ? ' busy' : ''}`} onClick={demo} disabled={!!pending} aria-label="Demo map" title="Demo map"><MapIcon /></button>}
          {canPick && <button type="button" className={`sc-btn pick${pick.picking ? ' on' : ''}`} onClick={togglePick} disabled={!!pending} aria-pressed={pick.picking} aria-label="Pick fire start" title="Pick fire start"><Crosshair /></button>}
        </div>
        {banner}
      </>
    );
  }

  return (
    <>
      <div className="scenario-bar map-chrome" role="group" aria-label="Scenario" style={style}>
        <span className="sc-label">
          <small className={error ? 'err' : undefined}>{sub}</small>
          <b>{scenario.label}</b>
        </span>
        <button type="button" className={`sc-btn${pending === 'new' ? ' busy' : ''}`} onClick={roll} disabled={!!pending}><Dice />{busyLabel ?? 'New scenario'}</button>
        {scenario.number !== 0 && <button type="button" className={`sc-btn${pending === 'demo' ? ' busy' : ''}`} onClick={demo} disabled={!!pending}><MapIcon />{pending === 'demo' ? 'Loading…' : 'Demo map'}</button>}
        {canPick && <button type="button" className={`sc-btn pick${pick.picking ? ' on' : ''}`} onClick={togglePick} disabled={!!pending} aria-pressed={pick.picking}><Crosshair />Pick fire start</button>}
      </div>
      {banner}
    </>
  );
}
