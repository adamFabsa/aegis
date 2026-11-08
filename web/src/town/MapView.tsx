import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Town } from './Town';
import { useAssetVersion } from './assets';
import type { Building, FireCell, Ghost, Pack, Sim } from './types';
import { TICK_SECONDS, type Unit } from './mockWorld';
import { PALETTES } from './palettes';
import { WindCompass } from './wind';
import { VIEW_H, VIEW_W, project, unproject } from './iso';
import { SPRITE, spriteScale } from './scene';

interface Cam { x: number; y: number; k: number } // viewBox top-left (svg units) + zoom (px per unit)
interface Ins { top: number; bottom: number; left: number; right: number }

interface MapViewProps {
  sim: Sim;
  buildings: Building[];
  fireCells: FireCell[];
  pack: Pack;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  /** Screen pixels covered by floating chrome; the camera frames the town in the space left over. */
  topInset?: number;
  bottomInset?: number;
  leftInset?: number;
  rightInset?: number;
  /** wide screens: reopen the phone beside the map */
  onPhone?: () => void;
  /** view rotation in 90 degree steps, and how to change it */
  rotation?: number;
  onRotate?: (dir: 1 | -1) => void;
  lite?: boolean;
  units?: Unit[];
  /** real seconds per server tick (live 1.0, mock 0.7): fire engines drive at the speed this implies */
  tickSeconds?: number;
  /** scenario: trees and brush scatter, where the fire starts, and picking a new fire start (map units) */
  plantSeed?: number;
  ignition?: { x: number; y: number; picked: boolean } | null;
  onPickGround?: (x: number, y: number) => void;
}

/** How long the old look (dusk / night, fire damage) takes to dissolve into the new one. */
const FADE_MS = 2000;

/**
 * Keeps the frame the map just left (look, phase, buildings, fire cells) for FADE_MS after the look or
 * phase changes, so Town can dissolve it over the new one instead of swapping everything in one frame.
 * The snapshot is taken in a layout effect, so the frame with the change is never painted without it.
 */
function useGhost(pack: Pack, phase: Sim['phase'], buildings: Building[], cells: FireCell[]): Ghost | null {
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const last = useRef<Omit<Ghost, 'epoch'> | null>(null);
  useLayoutEffect(() => {
    const prev = last.current;
    last.current = { pack, phase, buildings, cells };
    if (prev && (prev.pack !== pack || prev.phase !== phase)) setGhost({ ...prev, epoch: performance.now() });
  }, [pack, phase, buildings, cells]);
  useEffect(() => {
    if (!ghost) return;
    const t = setTimeout(() => setGhost(null), FADE_MS + 200);
    return () => clearTimeout(t);
  }, [ghost]);
  return ghost;
}

const PHONE = 760;
const MAX_K = 2.4;
// region of the board worth looking at; the camera centre is kept inside it
const BOUNDS = { x0: 60, x1: 1380, y0: 140, y1: 950 };

/** The free rectangle the town is framed in, between the floating chrome. */
function band(w: number, h: number, I: Ins) {
  const vw = Math.max(120, w - I.left - I.right);
  const vh = Math.max(80, h - I.top - I.bottom);
  return { vw, vh, mx: I.left + vw / 2, my: I.top + vh / 2 };
}

/** Put board point (cx, cy) at the middle of the free band. */
function centerOn(k: number, cx: number, cy: number, w: number, h: number, I: Ins): Cam {
  const { mx, my } = band(w, h, I);
  return { k, x: cx - mx / k, y: cy - my / k };
}

function fitCam(w: number, h: number, I: Ins): Cam {
  const { vw, vh } = band(w, h, I);
  const k = Math.min(vw / VIEW_W, vh / (VIEW_H - 120)) * 0.98;
  return centerOn(k, VIEW_W / 2, 540, w, h, I);
}

/** Phones open zoomed onto the town core (buildings + fire front) instead of a tiny full board. */
function initialCam(w: number, h: number, I: Ins): Cam {
  const fit = fitCam(w, h, I);
  const { vw, vh } = band(w, h, I);
  if (w >= PHONE) return centerOn(fit.k * 1.06, 720, 540, w, h, I);
  const k = Math.max(fit.k, Math.min(0.66, Math.max(vw / 860, vh / 1080)));
  return centerOn(k, 700, 560, w, h, I);
}

/** Keep zoom sane and the band centre over the board. */
function clampCam(c: Cam, w: number, h: number, I: Ins): Cam {
  const { mx, my } = band(w, h, I);
  const minK = fitCam(w, h, I).k * 0.9;
  const k = Math.min(MAX_K, Math.max(minK, c.k));
  let cx = c.x + mx / c.k;
  let cy = c.y + my / c.k;
  cx = Math.min(BOUNDS.x1, Math.max(BOUNDS.x0, cx));
  cy = Math.min(BOUNDS.y1, Math.max(BOUNDS.y0, cy));
  return { k, x: cx - mx / k, y: cy - my / k };
}

export function MapView({ sim, buildings, fireCells, pack, selectedId, onSelect, topInset = 0, bottomInset = 0, leftInset = 0, rightInset = 0, onPhone, rotation = 0, onRotate, lite = false, units, tickSeconds = TICK_SECONDS, plantSeed, ignition, onPickGround }: MapViewProps) {
  const ghost = useGhost(pack, sim.phase, buildings, fireCells);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [userCam, setUserCam] = useState<Cam | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const moved = useRef(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { w, h } = size;
  // The framing glides when the chrome around the map changes (the phone appearing when the fire
  // starts, the panel resizing) instead of the whole town jumping in one frame.
  const target = useMemo(() => ({ top: topInset, bottom: bottomInset, left: leftInset, right: rightInset }), [topInset, bottomInset, leftInset, rightInset]);
  const [I, setI] = useState(target);
  const shownI = useRef(target); // the insets actually on screen, mid-glide included
  useLayoutEffect(() => {
    const from = shownI.current;
    if (from === target) return;
    const t0 = performance.now();
    const D = 650;
    let raf = 0;
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / D);
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      const mix = (a: number, b: number) => a + (b - a) * e;
      const next = u >= 1 ? target : { top: mix(from.top, target.top), bottom: mix(from.bottom, target.bottom), left: mix(from.left, target.left), right: mix(from.right, target.right) };
      shownI.current = next;
      setI(next);
      if (u < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  const cam = w && h ? clampCam(userCam ?? initialCam(w, h, I), w, h, I) : null;
  const camRef = useRef(cam);
  useLayoutEffect(() => {
    camRef.current = cam;
  });

  // Latest layout values for the stable select callback below.
  const live = useRef({ w, h, I, buildings, onSelect });
  useLayoutEffect(() => {
    live.current = { w, h, I, buildings, onSelect };
  });

  // Eased camera moves for the buttons and for picking a building: zoom in log space, pan linearly.
  const anim = useRef(0);
  const animateTo = useCallback((target: Cam) => {
    cancelAnimationFrame(anim.current);
    const L = live.current;
    const from = camRef.current;
    if (!from) { setUserCam(target); return; }
    const B = band(L.w, L.h, L.I);
    const c0 = { x: from.x + B.mx / from.k, y: from.y + B.my / from.k };
    const c1 = { x: target.x + B.mx / target.k, y: target.y + B.my / target.k };
    const t0 = performance.now();
    const D = 420;
    const step = (now: number) => {
      const u = Math.min(1, (now - t0) / D);
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      const k = Math.exp(Math.log(from.k) + (Math.log(target.k) - Math.log(from.k)) * e);
      const cx = c0.x + (c1.x - c0.x) * e;
      const cy = c0.y + (c1.y - c0.y) * e;
      setUserCam({ k, x: cx - B.mx / k, y: cy - B.my / k });
      if (u < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  }, []);
  useEffect(() => () => cancelAnimationFrame(anim.current), []);

  const zoomAt = (px: number, py: number, f: number) => {
    const c = camRef.current;
    if (!c) return;
    const k2 = Math.min(MAX_K, Math.max(fitCam(w, h, I).k * 0.9, c.k * f));
    const wx = c.x + px / c.k;
    const wy = c.y + py / c.k;
    setUserCam(clampCam({ k: k2, x: wx - px / k2, y: wy - py / k2 }, w, h, I));
  };

  // wheel zoom needs a non-passive listener so the page does not scroll
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const local = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.map-chrome')) return;
    cancelAnimationFrame(anim.current);
    if (pointers.current.size === 0) moved.current = 0;
    pointers.current.set(e.pointerId, local(e));
    // no pointer capture yet: capturing on down retargets a plain click to the map itself (buildings never get it)
  };
  /** Once the pointer really drags, keep the gesture even if it leaves the map. */
  const capture = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    if (!el.hasPointerCapture(e.pointerId)) el.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    const c = camRef.current;
    if (!c) return;
    if (pointers.current.size === 1) {
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      moved.current += Math.abs(dx) + Math.abs(dy);
      if (moved.current > 4) { capture(e); setUserCam(clampCam({ k: c.k, x: c.x - dx / c.k, y: c.y - dy / c.k }, w, h, I)); }
    } else if (pointers.current.size === 2) {
      capture(e);
      const other = [...pointers.current.entries()].find(([id]) => id !== e.pointerId)![1];
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
      const d1 = Math.hypot(p.x - other.x, p.y - other.y);
      moved.current += 20;
      if (d0 > 0) zoomAt((p.x + other.x) / 2, (p.y + other.y) / 2, d1 / d0);
    }
    pointers.current.set(e.pointerId, p);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
  };

  const zoomButton = (f: number) => {
    const c = camRef.current;
    if (!c) return;
    const B = band(w, h, I);
    const k2 = Math.min(MAX_K, Math.max(fitCam(w, h, I).k * 0.9, c.k * f));
    const cx = c.x + B.mx / c.k;
    const cy = c.y + B.my / c.k;
    animateTo(clampCam({ k: k2, x: cx - B.mx / k2, y: cy - B.my / k2 }, w, h, I));
  };

  // Tapping a building (on the map or in the panel) pans it into the free space above the panel.
  const select = useCallback((id: number | null) => {
    const L = live.current;
    L.onSelect(id);
    const c = camRef.current;
    const b = id == null ? null : L.buildings.find((x) => x.id === id);
    if (!c || !b) return;
    const [sx, sy] = project(b.x + b.w / 2, b.y + b.h / 2, (SPRITE[b.kind].roof * spriteScale(b)) / 2);
    animateTo(clampCam(centerOn(c.k, sx, sy, L.w, L.h, L.I), L.w, L.h, L.I));
  }, [animateTo]);

  // A new fire start (new scenario, or picked) glides into view if it is off screen or under the map controls.
  const lastIgnition = useRef(ignition);
  useEffect(() => {
    const prev = lastIgnition.current;
    lastIgnition.current = ignition;
    const c = camRef.current;
    if (!ignition || !prev || !c || (prev.x === ignition.x && prev.y === ignition.y)) return;
    const L = live.current;
    const B = band(L.w, L.h, L.I);
    const [sx, sy] = project(ignition.x, ignition.y);
    const px = (sx - c.x) * c.k;
    const py = (sy - c.y) * c.k;
    // room for the marker's callout (up and in) and the zoom column on the right
    const x0 = L.I.left + 40, x1 = L.I.left + B.vw - 100, y0 = L.I.top + 110, y1 = L.I.top + B.vh - 40;
    const dx = px < x0 ? px - x0 : px > x1 ? px - x1 : 0;
    const dy = py < y0 ? py - y0 : py > y1 ? py - y1 : 0;
    if (dx || dy) animateTo(clampCam({ k: c.k, x: c.x + dx / c.k, y: c.y + dy / c.k }, L.w, L.h, L.I));
  }, [ignition, animateTo]);

  // When the town turns, keep the spot that was in the middle of the view in the middle, and fade the turn.
  const lastRot = useRef(rotation);
  useLayoutEffect(() => {
    const prev = lastRot.current;
    if (prev === rotation) return;
    lastRot.current = rotation;
    const c = camRef.current;
    if (!c) return;
    const B = band(w, h, I);
    const [mx, my] = unproject(c.x + B.mx / c.k, c.y + B.my / c.k, prev);
    const [nx, ny] = project(mx, my);
    setUserCam(clampCam(centerOn(c.k, nx, ny, w, h, I), w, h, I));
    const el = svgRef.current;
    if (el) { el.classList.remove('turning'); void el.getBoundingClientRect(); el.classList.add('turning'); }
  }, [rotation, w, h, I]);

  // Q / E turn the town
  useEffect(() => {
    if (!onRotate) return;
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select')) return;
      if (e.key === 'q' || e.key === 'Q') onRotate(-1);
      if (e.key === 'e' || e.key === 'E') onRotate(1);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onRotate]);

  // Marker size only changes in steps, so pinch-zoom does not re-render the town every frame.
  const tagScale = cam ? Math.round(Math.min(2.6, Math.max(1, 0.8 / cam.k)) * 5) / 5 : 1;
  const viewBox = cam ? `${cam.x.toFixed(1)} ${cam.y.toFixed(1)} ${(w / cam.k).toFixed(1)} ${(h / cam.k).toFixed(1)}` : `0 0 ${VIEW_W} ${VIEW_H}`;

  // Panning writes the viewBox directly instead of re-rendering hundreds of SVG nodes.
  const svgRef = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    svgRef.current?.setAttribute('viewBox', viewBox);
  });
  const ready = cam !== null;
  const assets = useAssetVersion();
  const town = useMemo(
    () => (ready ? <Town sim={sim} buildings={buildings} fireCells={fireCells} pack={pack} selectedId={selectedId} onSelect={select} svgRef={svgRef} tagScale={tagScale} lite={lite} units={units} rotation={rotation} assets={assets} ghost={ghost} tickSeconds={tickSeconds}
      plantSeed={plantSeed} ignition={ignition} onPick={onPickGround} /> : null),
    [ready, sim, buildings, fireCells, pack, selectedId, select, tagScale, lite, units, rotation, assets, ghost, tickSeconds, plantSeed, ignition, onPickGround],
  );

  return (
    <div
      ref={ref}
      className={onPickGround ? 'map picking' : 'map'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerUp}
      onClickCapture={(e) => {
        if (moved.current > 8 && !(e.target as HTMLElement).closest('.map-chrome')) {
          e.stopPropagation();
          e.preventDefault();
        }
      }}
    >
      {/* the old sky dissolves over the new one (CSS cannot interpolate between two gradients) */}
      {ghost && ghost.pack !== pack && <div key={ghost.epoch} className="pack-veil pack-out" style={{ background: PALETTES[ghost.pack].bg }} aria-hidden="true" />}
      {town}
      <div className="map-chrome zoom" role="group" aria-label="Map zoom" style={rightInset ? { right: rightInset } : undefined}>
        <WindCompass dirDeg={sim.windDirDeg} mph={sim.windMph} />
        {onPhone && (
          <button type="button" aria-label="Show phone" onClick={onPhone}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></svg>
          </button>
        )}
        {onRotate && (
          <>
            <button type="button" className="rot" aria-label="Turn the view left (Q)" title="Turn left (Q)" onClick={() => onRotate(-1)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.6" /><path d="M4 4v4.5h4.5" /></svg>
            </button>
            <button type="button" className="rot" aria-label="Turn the view right (E)" title="Turn right (E)" onClick={() => onRotate(1)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6" /><path d="M20 4v4.5h-4.5" /></svg>
            </button>
          </>
        )}
        <button type="button" aria-label="Zoom in" onClick={() => zoomButton(1.35)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomButton(1 / 1.35)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
        </button>
        <button type="button" aria-label="Show whole map" onClick={() => animateTo(fitCam(w, h, I))}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
        </button>
      </div>
    </div>
  );
}
