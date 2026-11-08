// Pick-mode state for choosing where the fire starts: shared by the scenario bar (toggle + hint banner)
// and the map (crosshair + the click on the ground, in map units).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Result, WorldApi } from '../town/world';
import { CELL, COLS, ROWS } from '../town/iso';

/** Server errors read as sentences ("nothing to burn there: …" → "Nothing to burn there: …"). */
export function tidy(msg: string): string {
  const m = msg.trim();
  return m ? m[0].toUpperCase() + m.slice(1) : 'Something went wrong';
}

/** A reducer call that never answers (connection dropped) must not leave a button spinning forever. */
export async function settle(r: Result, ms = 20000): Promise<string | null> {
  let t = 0;
  const late = new Promise<string>((res) => { t = window.setTimeout(() => res('No answer from the Aegis server. Try again.'), ms); });
  try {
    return await Promise.race([Promise.resolve(r), late]);
  } finally {
    clearTimeout(t);
  }
}

export interface ScenarioPick {
  /** pick mode is on: the next click on the ground moves the fire start */
  picking: boolean;
  /** the server is re-running the fire from the picked spot */
  busy: boolean;
  error: string | null;
  start: () => void;
  cancel: () => void;
  /** map point (map units) clicked while picking; undefined when not picking */
  onPick?: (x: number, y: number) => void;
}

export function useScenarioPick(world: WorldApi): ScenarioPick {
  const { setIgnition } = world;
  const phase = world.sim.phase;
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the fire starting (or a reset from another device) ends pick mode
  const [phaseSeen, setPhaseSeen] = useState(phase);
  if (phaseSeen !== phase) {
    setPhaseSeen(phase);
    setPicking(false);
    setError(null);
  }
  const active = picking && phase === 'prep' && !!setIgnition;
  const cancel = useCallback(() => { setPicking(false); setError(null); }, []);
  const start = useCallback(() => { setError(null); setPicking(true); }, []);

  useEffect(() => {
    if (!active) return;
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [active, cancel]);

  const inFlight = useRef(false);
  const onPick = useCallback(async (x: number, y: number) => {
    if (!setIgnition || inFlight.current) return;
    const cx = Math.floor(x / CELL);
    const cy = Math.floor(y / CELL);
    if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) { setError('That is off the map: pick a spot on the board.'); return; }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const err = await settle(setIgnition(cx, cy));
    inFlight.current = false;
    setBusy(false);
    if (err) setError(tidy(err));
    else setPicking(false);
  }, [setIgnition]);

  return { picking: active, busy, error, start, cancel, onPick: active ? onPick : undefined };
}
