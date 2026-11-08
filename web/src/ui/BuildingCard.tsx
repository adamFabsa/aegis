// The building's own card, on the map, pointing at the building (wide screens; phones use the panel sheet).
// The map camera writes the SVG viewBox straight onto the element (no React re-render), so the card does
// not take its position from props: it follows an invisible anchor Town draws on the selected building's roof
// (data-building-anchor), re-placed the moment the viewBox changes and checked again on every frame.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Building } from '../town/types';
import type { WorldApi } from '../town/world';
import { STATUS_COLORS } from '../town/palettes';
import { statusTag } from '../town/status';
import { expectedLoss } from './impact';
import { prepPlan } from './advisor';
import { KIND_LABEL, fmtMin, fmtUsd } from './format';

type CardWorld = Pick<WorldApi,
  'sim' | 'buildings' | 'persons' | 'tasks' | 'units' | 'approved' | 'fixesFor' | 'profileFor' | 'checklistFor' |
  'approveFix' | 'startEvacuation' | 'dispatchUnit'>;

interface Props {
  b: Building;
  world: CardWorld;
  /** screen x where the free map starts (right edge of the left panel) */
  left: number;
  /** width covered on the right (the drawn phone) */
  right: number;
  top?: number;
  onClose: () => void;
}

const MIN_RISK = 5;
/** arrow tip this far above the roof centre */
const GAP = 16;
const ARROW = 9;
/** keep clear of the zoom column on the map's right edge */
const ZOOM_W = 58;
const riskColor = (r: number) => (r >= 70 ? STATUS_COLORS.red : r >= 40 ? STATUS_COLORS.amber : STATUS_COLORS.green);

export function BuildingCard({ b, world, left, right, top = 12, onClose }: Props) {
  const pos = useRef<HTMLDivElement>(null);
  useAnchor(pos, b.id, left, right, top);

  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);

  const { sim } = world;
  const shelter = b.kind === 'shelter';
  const pill = pillFor(b, sim.phase);
  return (
    <div ref={pos} className="bcard-pos" role="dialog" aria-label={`${b.name} details`}>
      <div key={b.id} className="bcard">
        <header className="bcard-head">
          <b className="bcard-name">{b.name}</b>
          {pill ? <span className="bcard-pill" style={{ color: pill.color, background: `color-mix(in srgb, ${pill.color} 16%, transparent)` }}>{pill.text}</span> : <span />}
          <button type="button" className="bcard-x" aria-label="Close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
          <small className="bcard-sub">{KIND_LABEL[b.kind]}{!shelter && b.residents ? ` · ${b.residents} residents` : ''}</small>
        </header>
        {shelter ? <ShelterBody world={world} /> : sim.phase === 'prep' ? <PrepBody b={b} world={world} /> : sim.phase === 'fire' ? <FireBody b={b} world={world} /> : <EndedBody b={b} />}
      </div>
    </div>
  );
}

function pillFor(b: Building, phase: WorldApi['sim']['phase']): { text: string; color: string } | null {
  if (b.kind === 'shelter') return null;
  if (phase === 'prep') return b.prepared ? { text: 'Prepared ✓', color: STATUS_COLORS.green } : { text: 'Not prepared', color: STATUS_COLORS.amber };
  if (phase === 'ended') {
    if (b.status === 'lost') return { text: 'Lost', color: STATUS_COLORS.gray };
    return b.touched ? { text: 'Damaged', color: STATUS_COLORS.amber } : { text: 'Standing', color: STATUS_COLORS.green };
  }
  return statusTag(b, phase);
}

function Stat({ value, label, sub, color }: { value: ReactNode; label: string; sub?: ReactNode; color?: string }) {
  return (
    <div>
      <dd style={color ? { color } : undefined}>{value}{sub != null && <small>{sub}</small>}</dd>
      <dt>{label}</dt>
    </div>
  );
}

/** The race: when the fire arrives, how long getting everyone out takes, and the margin. */
function Race({ b }: { b: Building }) {
  const eta = b.fireEtaMin;
  const need = b.evacNeededMin;
  if (eta < 0) {
    return (
      <dl className="bcard-stats">
        <Stat label="fire arrives" value="—" sub=" no path" />
        <Stat label="evacuation" value={fmtMin(need)} />
      </dl>
    );
  }
  const late = need > eta;
  return (
    <dl className="bcard-stats">
      <Stat label="fire arrives" value={eta === 0 ? 'Now' : fmtMin(eta)} color={eta === 0 ? STATUS_COLORS.red : undefined} />
      <Stat label="evacuation" value={fmtMin(need)} color={late ? STATUS_COLORS.red : STATUS_COLORS.green} />
      <Stat label={late ? 'too slow' : 'to spare'} value={fmtMin(Math.abs(eta - need))} color={late ? STATUS_COLORS.red : STATUS_COLORS.green} />
    </dl>
  );
}

// ------------------------------------------------------------------ prepare
function PrepBody({ b, world }: { b: Building; world: CardWorld }) {
  const profile = world.profileFor?.(b.id);
  const loss = expectedLoss(b, profile);
  const lossBefore = expectedLoss(b, profile, b.baseRisk);
  const checklist = world.checklistFor?.(b.id) ?? [];
  const documented = checklist.filter((m) => m.status === 'met').length;
  const done = world.approved[b.id] ?? [];
  // Lantern AI's ranking for the whole neighborhood (the phone coach's list), narrowed to this building
  const next = useMemo(() => prepPlan(world, (id, key) => (world.approved[id] ?? []).includes(key)).find((s) => s.b.id === b.id),
    [world, b.id]);
  const [justApproved, setJustApproved] = useState<string | null>(null);
  useEffect(() => {
    if (!justApproved) return;
    const t = setTimeout(() => setJustApproved(null), 2600);
    return () => clearTimeout(t);
  }, [justApproved]);
  const lowered = b.baseRisk - b.risk >= 1;
  const measure = next && checklist.find((m) => String(m.fixId) === next.f.key && m.status !== 'met');

  return (
    <>
      <dl className="bcard-stats">
        <Stat label="risk" value={Math.round(b.risk)} color={riskColor(b.risk)} sub={lowered ? ` was ${Math.round(b.baseRisk)}` : undefined} />
        {loss !== undefined && <Stat label="expected claim" value={fmtUsd(Math.round(loss))} color={lossBefore !== undefined && loss < lossBefore - 1 ? STATUS_COLORS.green : undefined} />}
        <Stat label="need help" value={b.needsHelp} sub={`/${b.residents}`} />
      </dl>
      <Race b={b} />
      {checklist.length > 0 && (
        <div className="bcard-check" aria-label={`Insurer checklist: ${documented} of ${checklist.length} documented`}>
          <span>Insurer checklist</span>
          <span className="bcard-dots" aria-hidden="true">
            {checklist.map((m) => <i key={m.measure} className={m.status} title={m.measure} />)}
          </span>
          <b>{documented} of {checklist.length}</b>
        </div>
      )}
      {next ? (
        <div className="bcard-ai">
          <p className="bcard-kicker">Lantern AI · best next fix</p>
          <p className="bcard-fix">{next.f.name}</p>
          <p className="bcard-why">
            {next.f.addVans > 0
              ? next.people > 0 ? `Gets the ${next.people} residents who need help out before the fire` : `Adds ${next.f.addVans} van: a faster evacuation`
              : `Risk ${Math.round(b.risk)} → ${Math.max(MIN_RISK, Math.round(b.risk - next.f.riskDrop))}${next.usd > 0 ? ` · claim −${fmtUsd(Math.round(next.usd))}` : ''}`}
            {measure ? ' · +1 insurer measure' : ''}
          </p>
          <button type="button" className="btn small primary-small" onClick={() => { world.approveFix(b.id, next.f.key); setJustApproved(next.f.name); }}>
            Approve · {fmtUsd(next.f.cost)}
          </button>
        </div>
      ) : (
        <p className="bcard-done">
          {b.prepared ? '✓ Prepared. ' : ''}{done.length ? `${done.length} fix${done.length === 1 ? '' : 'es'} approved. ` : ''}
          {world.fixesFor(b.id).some((f) => !done.includes(f.key)) ? 'Nothing else here makes Lantern’s plan.' : 'Nothing left to fix here.'}
        </p>
      )}
      {justApproved && <p className="bcard-flash" role="status">✓ Approved: {justApproved}</p>}
    </>
  );
}

// ------------------------------------------------------------------ fire
function FireBody({ b, world }: { b: Building; world: CardWorld }) {
  const { sim, units, tasks } = world;
  const engine = units.find((u) => u.targetId === b.id && (u.status === 'enroute' || u.status === 'onscene'));
  const free = units.find((u) => u.status === 'ready');
  const waiting = tasks.filter((t) => t.buildingId === b.id && !t.done).length;
  // same rule as the panel's "Start evacuation"
  const canEvac = sim.phase === 'fire' && !b.evacStarted && b.status !== 'lost' && b.status !== 'burning' && b.kind !== 'shelter';
  const canSend = sim.phase === 'fire' && !!free && !engine && b.status !== 'lost' && b.kind !== 'shelter';
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error]);
  const send = async () => {
    setError(null);
    const r = await world.dispatchUnit(b.id);
    if (typeof r === 'string' && r) setError(r);
  };
  const pct = (100 * b.peopleOut) / Math.max(1, b.residents);

  return (
    <>
      {b.status !== 'lost' && b.status !== 'clear' && <Race b={b} />}
      <div className="bcard-out">
        <div className="progress-row"><span>Residents out</span><b>{b.peopleOut} of {b.residents}</b></div>
        <div className="meter"><div style={{ width: `${pct}%`, background: b.status === 'lost' ? STATUS_COLORS.gray : undefined }} /></div>
      </div>
      {(waiting > 0 || engine) && (
        <ul className="bcard-lines">
          {waiting > 0 && <li className="warn">{waiting} waiting for staff</li>}
          {engine && <li className="unit">{engine.name} {engine.status === 'onscene' ? 'on scene' : 'en route'}</li>}
        </ul>
      )}
      {b.status === 'lost' && <p className="bcard-done">Collapsed. {b.residents - b.peopleOut > 0 ? `${b.residents - b.peopleOut} were still inside.` : 'Everyone was already out.'}</p>}
      {(canEvac || canSend) && (
        <div className="bcard-actions">
          {canEvac && (
            <button type="button" className={`btn small ${b.status === 'behind' || (b.fireEtaMin >= 0 && b.evacNeededMin > b.fireEtaMin) ? 'urgent' : 'primary-small'}`} onClick={() => world.startEvacuation(b.id)}>
              Evacuate
            </button>
          )}
          {canSend && free && <button type="button" className="btn small engine" onClick={send}>Send {free.name}</button>}
        </div>
      )}
      {error && <p className="bcard-error" role="alert">{error}</p>}
    </>
  );
}

// ------------------------------------------------------------------ after the fire
function EndedBody({ b }: { b: Building }) {
  const lost = b.status === 'lost';
  const inside = Math.max(0, b.residents - b.peopleOut);
  return (
    <>
      <dl className="bcard-stats">
        <Stat label="evacuated" value={b.peopleOut} sub={`/${b.residents}`} color={b.residents && b.peopleOut >= b.residents ? STATUS_COLORS.green : undefined} />
        {lost && <Stat label="still inside" value={inside} color={inside ? STATUS_COLORS.red : STATUS_COLORS.green} />}
      </dl>
      <p className="bcard-done">
        {lost ? (inside ? 'It collapsed in the fire.' : 'It collapsed after everyone got out.')
          : `${b.touched ? 'The fire reached it, but it held.' : 'It never caught fire.'}${b.residents && b.peopleOut >= b.residents ? ' Everyone got out.' : ''}`}
      </p>
    </>
  );
}

// ------------------------------------------------------------------ shelter
function ShelterBody({ world }: { world: CardWorld }) {
  const real = world.buildings.filter((x) => x.kind !== 'shelter');
  const out = real.reduce((n, x) => n + x.peopleOut, 0);
  const total = real.reduce((n, x) => n + x.residents, 0);
  const clear = real.filter((x) => x.status === 'clear').length;
  return (
    <>
      <dl className="bcard-stats">
        <Stat label="people out" value={out} sub={`/${total}`} color={out ? STATUS_COLORS.green : undefined} />
        <Stat label="buildings all out" value={clear} sub={`/${real.length}`} color={clear ? STATUS_COLORS.green : undefined} />
      </dl>
      <p className="bcard-done">Every evacuation ends here; Lantern counts residents in as they arrive.</p>
    </>
  );
}

// ------------------------------------------------------------------ anchoring
/**
 * Keeps the card above the anchor on the roof. The screen point comes from the anchor's own coordinates and
 * the SVG's viewBox (no layout reads), so it can run every frame; a MutationObserver on the viewBox re-places
 * it in the same task the camera writes, so the card never trails the town by a frame.
 */
function useAnchor(ref: RefObject<HTMLDivElement | null>, id: number, left: number, right: number, top: number) {
  const box = useRef({ left, right, top });
  useLayoutEffect(() => { box.current = { left, right, top }; }, [left, right, top]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let anchor: SVGCircleElement | null = null;
    let svg: SVGSVGElement | null = null;
    let svgRect = { left: 0, top: 0, width: 0, height: 0 };
    let size = { w: el.offsetWidth, h: el.offsetHeight };
    // layout-reading values are cached and refreshed on resize, so the per-frame check never forces a layout
    let view = { w: window.innerWidth, h: window.innerHeight };
    let last = '';
    let raf = 0;
    const mo = new MutationObserver(() => place());
    const ro = new ResizeObserver(() => {
      size = { w: el.offsetWidth, h: el.offsetHeight };
      if (svg) { const r = svg.getBoundingClientRect(); svgRect = { left: r.left, top: r.top, width: r.width, height: r.height }; }
      place();
    });
    ro.observe(el);
    const find = () => {
      if (anchor?.isConnected) return true;
      anchor = document.querySelector<SVGCircleElement>(`[data-building-anchor="${id}"]`);
      const s = anchor?.ownerSVGElement ?? null;
      if (s !== svg) {
        mo.disconnect();
        if (svg) ro.unobserve(svg);
        svg = s;
        if (svg) {
          mo.observe(svg, { attributes: true, attributeFilter: ['viewBox'] });
          ro.observe(svg);
          const r = svg.getBoundingClientRect();
          svgRect = { left: r.left, top: r.top, width: r.width, height: r.height };
        }
      }
      return !!anchor;
    };
    const place = () => {
      let state = 'off';
      if (find() && anchor && svg) {
        const vb = svg.viewBox.baseVal;
        if (vb && vb.width > 0 && vb.height > 0 && svgRect.width > 0) {
          // preserveAspectRatio="xMidYMid meet"
          const k = Math.min(svgRect.width / vb.width, svgRect.height / vb.height);
          const ax = svgRect.left + (svgRect.width - vb.width * k) / 2 + (anchor.cx.baseVal.value - vb.x) * k;
          const ay = svgRect.top + (svgRect.height - vb.height * k) / 2 + (anchor.cy.baseVal.value - vb.y) * k;
          const B = box.current;
          const { w: vw, h: vh } = view;
          const x0 = B.left + 8;
          const x1 = vw - B.right - ZOOM_W;
          const onScreen = ax >= B.left && ax <= vw - B.right && ay >= 0 && ay <= vh;
          if (onScreen) {
            const { w, h } = size;
            let x = Math.min(Math.max(ax - w / 2, x0), Math.max(x0, x1 - w));
            // above the building; below it when there is no room above
            let below = false;
            let y = ay - GAP - ARROW - h;
            if (y < B.top) { below = true; y = ay + GAP + ARROW; }
            y = Math.min(Math.max(y, B.top), vh - h - 8);
            const dpr = window.devicePixelRatio || 1;
            x = Math.round(x * dpr) / dpr;
            y = Math.round(y * dpr) / dpr;
            const arrow = Math.round(Math.min(w - 18, Math.max(18, ax - x)));
            state = `${x} ${y} ${arrow} ${below ? 1 : 0}`;
          }
        }
      }
      if (state === last) return;
      last = state;
      if (state === 'off') { el.classList.add('off'); return; }
      const [x, y, arrow, below] = state.split(' ');
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.style.setProperty('--arrow', `${arrow}px`);
      el.classList.toggle('below', below === '1');
      el.classList.remove('off');
    };
    const loop = () => { place(); raf = requestAnimationFrame(loop); };
    loop();
    const onResize = () => { view = { w: window.innerWidth, h: window.innerHeight }; if (svg) { const r = svg.getBoundingClientRect(); svgRect = { left: r.left, top: r.top, width: r.width, height: r.height }; } place(); };
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(raf); mo.disconnect(); ro.disconnect(); window.removeEventListener('resize', onResize); };
  }, [ref, id]);
}
