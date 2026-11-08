import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Town } from './Town';
import type { Building, FireCell, Pack, Sim } from './types';
import { VIEW_H, VIEW_W, project } from './iso';
import { SPRITE, spriteScale } from './scene';

interface Cam { x: number; y: number; k: number } // viewBox top-left (svg units) + zoom (px per unit)

interface MapViewProps {
  sim: Sim;
  buildings: Building[];
  fireCells: FireCell[];
  pack: Pack;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  children?: ReactNode; // overlay chrome (chips, legend)
}

const PHONE = 760;
const MAX_K = 2.4;
// region of the board worth looking at; the camera centre is kept inside it
const BOUNDS = { x0: 60, x1: 1380, y0: 140, y1: 950 };

function fitCam(w: number, h: number): Cam {
  const k = Math.min(w / VIEW_W, h / VIEW_H) * 0.98;
  return { k, x: (VIEW_W - w / k) / 2, y: (VIEW_H - h / k) / 2 + 12 };
}

/** Phones open zoomed onto the town core (buildings + fire front) instead of a tiny full board. */
function initialCam(w: number, h: number): Cam {
  const fit = fitCam(w, h);
  if (w >= PHONE) return fit;
  // show the whole town core (Building 3 on the left to the fire front on the right) across the phone width
  const k = Math.max(fit.k, Math.min(0.66, Math.max(w / 860, h / 1080)));
  return centerOn({ x: 0, y: 0, k }, 700, 560, w, h);
}

function centerOn(c: Cam, cx: number, cy: number, w: number, h: number): Cam {
  return { k: c.k, x: cx - w / (2 * c.k), y: cy - h / (2 * c.k) };
}

function clampCam(c: Cam, w: number, h: number): Cam {
  const minK = fitCam(w, h).k * 0.9;
  const k = Math.min(MAX_K, Math.max(minK, c.k));
  let cx = c.x + w / (2 * c.k);
  let cy = c.y + h / (2 * c.k);
  cx = Math.min(BOUNDS.x1, Math.max(BOUNDS.x0, cx));
  cy = Math.min(BOUNDS.y1, Math.max(BOUNDS.y0, cy));
  return { k, x: cx - w / (2 * k), y: cy - h / (2 * k) };
}

export function MapView({ sim, buildings, fireCells, pack, selectedId, onSelect, children }: MapViewProps) {
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
  const cam = w && h ? clampCam(userCam ?? initialCam(w, h), w, h) : null;
  const camRef = useRef(cam);
  useLayoutEffect(() => {
    camRef.current = cam;
  });

  const zoomAt = (px: number, py: number, f: number) => {
    const c = camRef.current;
    if (!c) return;
    const k2 = Math.min(MAX_K, Math.max(fitCam(w, h).k * 0.9, c.k * f));
    const wx = c.x + px / c.k;
    const wy = c.y + py / c.k;
    setUserCam(clampCam({ k: k2, x: wx - px / k2, y: wy - py / k2 }, w, h));
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
    if (pointers.current.size === 0) moved.current = 0;
    pointers.current.set(e.pointerId, local(e));
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
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
      if (moved.current > 4) setUserCam(clampCam({ k: c.k, x: c.x - dx / c.k, y: c.y - dy / c.k }, w, h));
    } else if (pointers.current.size === 2) {
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

  const zoomButton = (f: number) => zoomAt(w / 2, h / 2, f);

  // On phones the details sheet covers the lower half: pan the tapped building into the space above it.
  const select = (id: number | null) => {
    onSelect(id);
    const c = camRef.current;
    const b = id == null ? null : buildings.find((x) => x.id === id);
    if (!c || !b || w >= PHONE) return;
    const [sx, sy] = project(b.x + b.w / 2, b.y + b.h / 2, (SPRITE[b.kind].roof * spriteScale(b)) / 2);
    setUserCam(clampCam({ k: c.k, x: sx - w / (2 * c.k), y: sy - (h * 0.24) / c.k }, w, h));
  };
  const tagScale = cam ? Math.min(2.6, Math.max(1, 0.8 / cam.k)) : 1;
  const viewBox = cam ? `${cam.x.toFixed(1)} ${cam.y.toFixed(1)} ${(w / cam.k).toFixed(1)} ${(h / cam.k).toFixed(1)}` : `0 0 ${VIEW_W} ${VIEW_H}`;

  return (
    <div
      ref={ref}
      className="map"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClickCapture={(e) => {
        if (moved.current > 8 && !(e.target as HTMLElement).closest('.map-chrome')) {
          e.stopPropagation();
          e.preventDefault();
        }
      }}
    >
      {cam && (
        <Town sim={sim} buildings={buildings} fireCells={fireCells} pack={pack} selectedId={selectedId} onSelect={select} viewBox={viewBox} tagScale={tagScale} />
      )}
      {children}
      <div className="map-chrome zoom" role="group" aria-label="Map zoom">
        <button type="button" aria-label="Zoom in" onClick={() => zoomButton(1.35)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomButton(1 / 1.35)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>
        </button>
        <button type="button" aria-label="Show whole map" onClick={() => setUserCam(fitCam(w, h))}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
        </button>
      </div>
    </div>
  );
}
