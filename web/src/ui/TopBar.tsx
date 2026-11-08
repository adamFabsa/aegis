import { useRef, useState, type CSSProperties } from 'react';
import type { Pack, Sim } from '../town/types';
import { fmtClock, fmtUsd } from './format';

export type Look = 'auto' | Pack;

interface TopBarProps {
  sim: Sim;
  look: Look;
  onLook: (l: Look) => void;
  onPrepare: () => void;
  onStartFire: () => void;
  onTogglePause: () => void;
  onReset: () => void;
  speed: 1 | 2 | 4;
  onSpeed: (s: 1 | 2 | 4) => void;
  muted: boolean;
  onToggleMute: () => void;
  /** a random scenario's name ("Scenario #48213"); the Eaton demo map leaves it out */
  scenarioLabel?: string;
}

const LOOKS: { id: Look; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'Golden hour while preparing, night during the fire' },
  { id: 'night', label: 'Night Watch', hint: 'Moonlit, lit windows' },
  { id: 'dusk', label: 'Golden Hour', hint: 'Warm low sun' },
  { id: 'maquette', label: 'Studio Model', hint: 'White architectural model' },
];

function LanternMark() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#F2A93B" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 3h6" /><path d="M12 3v2" />
      <path d="M7 8a5 5 0 0 1 10 0v8a3 3 0 0 1-3 3h-4a3 3 0 0 1-3-3z" />
      <path d="M12 10c1.2 1.3 1.6 2.4 1 3.6a1.2 1.2 0 0 1-2 0c-.6-1.2-.2-2.3 1-3.6z" />
      <path d="M9 21h6" />
    </svg>
  );
}

export function TopBar({ sim, look, onLook, onPrepare, onStartFire, onTogglePause, onReset, speed, onSpeed, muted, onToggleMute, scenarioLabel }: TopBarProps) {
  const [menu, setMenu] = useState(false);
  const [menuPos, setMenuPos] = useState<CSSProperties>({});
  const menuBtn = useRef<HTMLButtonElement>(null);
  const toggleMenu = () => {
    const r = menuBtn.current?.getBoundingClientRect();
    if (r) {
      // a floating popover, so the panel's scroll area never clips it; opens upward from a bottom sheet
      const up = r.top > window.innerHeight / 2;
      setMenuPos({ right: Math.max(8, window.innerWidth - r.right), ...(up ? { bottom: window.innerHeight - r.top + 8 } : { top: r.bottom + 8 }) });
    }
    setMenu((m) => !m);
  };
  const step = sim.phase === 'prep' ? 0 : sim.phase === 'fire' ? 1 : 2;
  const steps = [
    { label: 'Prepare', onClick: onPrepare },
    { label: 'Fire', onClick: onStartFire },
    { label: 'Results', onClick: undefined },
  ];

  return (
    <header className="topbar">
      <div className="logo">
        <LanternMark />
        <span>Lantern</span>
      </div>
      <p className="tb-sub">{scenarioLabel ?? 'Eaton Fire replay'} · built for <img className="sf-inline" src="/brand/state-farm.svg" alt="State Farm" /></p>

      <ol className="stepper" aria-label="Simulation steps">
        {steps.map((s, i) => (
          <li key={s.label} className={i === step ? 'current' : i < step ? 'done' : ''}>
            <button
              type="button"
              disabled={!s.onClick || i === step || (i === 1 && step === 2)}
              onClick={s.onClick}
              aria-current={i === step ? 'step' : undefined}
            >
              <span className="num" aria-hidden="true">
                {i < step ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5 9-10" /></svg>
                ) : i + 1}
              </span>
              <span className="label">{s.label}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="tb-tools">
      <div className={`status-pill ${sim.phase}`}>
        {sim.phase === 'prep' ? (
          <><span className="pill-lbl">Budget</span><span className="pill-val">{fmtUsd(sim.budgetLeft)}</span></>
        ) : (
          <>
            <span className="pill-lbl">{sim.phase === 'ended' ? 'Out at' : 'T+'}</span>
            <span className="pill-val">{fmtClock(sim.simMinutes)}</span>
            {sim.phase === 'fire' && (
              <button type="button" className="pill-btn" aria-label={sim.running ? 'Pause' : 'Resume'} onClick={onTogglePause}>
                {sim.running ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z" /></svg>
                )}
              </button>
            )}
            {sim.phase === 'fire' && (
              <button type="button" className="pill-btn speed" aria-label={`Speed ${speed} times, change`} onClick={() => onSpeed(speed === 1 ? 2 : speed === 2 ? 4 : 1)}>{speed}×</button>
            )}
          </>
        )}
      </div>

      <button type="button" className={`icon-btn sound ${muted ? 'off' : ''}`} aria-label={muted ? 'Turn sound on' : 'Turn sound off'} aria-pressed={!muted} onClick={onToggleMute}>
        {muted ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" /><path d="M17 9l5 6M22 9l-5 6" /></svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" /><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" /></svg>
        )}
      </button>
      <div className="menu-wrap">
        <button ref={menuBtn} type="button" className="icon-btn" aria-label="Settings" aria-expanded={menu} onClick={toggleMenu}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
        </button>
        {menu && (
          <>
          <div className="menu-scrim" onClick={() => setMenu(false)} />
          <div className="menu" role="menu" style={menuPos}>
            <div className="menu-title">Look</div>
            {LOOKS.map((l) => (
              <button key={l.id} type="button" role="menuitemradio" aria-checked={look === l.id} className={look === l.id ? 'on' : ''} onClick={() => { onLook(l.id); setMenu(false); }}>
                <span className="radio" aria-hidden="true" />
                <span><b>{l.label}</b><small>{l.hint}</small></span>
              </button>
            ))}
            <div className="menu-sep" />
            <button type="button" role="menuitem" className="danger" onClick={() => { onReset(); setMenu(false); }}>Reset everything</button>
            <p className="menu-note">Simulated neighborhood. Fire calibrated to the Eaton Fire.</p>
          </div>
          </>
        )}
      </div>
      </div>
    </header>
  );
}
