import { forwardRef, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Building, FireCell, Pack, Person, ScenarioResult, Sim, Task } from '../town/types';
import type { LogEvent, Unit } from '../town/mockWorld';
import type { BuildingProfile, FixView, Measure, PreparedRule } from '../town/world';
import { expectedLoss, fixAvoids, portfolio } from './impact';
import { headcount, prepPlan, windFrom } from './advisor';
import { STATUS_COLORS } from '../town/palettes';
import { statusTag } from '../town/status';
import { spriteUrl, spriteVariant } from '../town/scene';
import { KIND_LABEL, fmtClock, fmtMin, fmtUsd } from './format';

/** "1h 18m" → "1h18", for one-line list rows */
function fmtShort(min: number): string {
  if (min < 0 || !Number.isFinite(min)) return '—';
  const m = Math.round(min);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m}m`;
}

interface DockProps {
  sim: Sim;
  buildings: Building[];
  approved: Record<number, string[]>;
  events: LogEvent[];
  selected: Building | null;
  pack: Pack;
  onSelect: (id: number | null) => void;
  onApprove: (id: number, key: string) => void;
  /** the fixes offered for a building (live: the fix table; mock: B's list) */
  fixesFor: (buildingId: number) => FixView[];
  /** when a building counts as prepared */
  prepared: PreparedRule;
  /** "Aegis recommends": approve the best-value fixes that fit the budget (live only) */
  onRecommend?: () => void;
  /** run the rest of the fire instantly and show the comparison (live only) */
  onEndCompare?: () => void;
  /** live only: building profile (fire reach, data sources) and the insurer mitigation checklist */
  profileFor?: (buildingId: number) => BuildingProfile | undefined;
  checklistFor?: (buildingId: number) => Measure[];
  onEvacuate: (id: number) => void;
  onStartFire: () => void;
  onRestart: () => void;
  units: Unit[];
  cells: FireCell[];
  onDispatch: (buildingId: number) => void;
  onRelease: (unitId: number) => void;
  /** Screen y the phone sheet may grow up to. */
  topLimit: number;
  /** App bar (logo, steps, clock, sound, settings) shown at the top of the panel. */
  bar?: ReactNode;
  persons: Person[];
  tasks: Task[];
  results?: { with: ScenarioResult; without: ScenarioResult };
  /** phones: the resident/staff phone lives in a tab of the panel */
  phone?: ReactNode;
}


interface View { head: ReactNode; body: ReactNode; foot?: ReactNode }
type Tab = 'people' | 'units' | 'phone';

// ------------------------------------------------------------------ small pieces
function TruckIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 16V8h11v8M13 11h4l3 3v2h-7" /><circle cx="6.5" cy="17.5" r="1.8" /><circle cx="16.5" cy="17.5" r="1.8" /><path d="M2 6h8" />
    </svg>
  );
}
const Arrow = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
const Check = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
);

/** A crop of the building's own Blender render, in its current state (burning, gutted, collapsed). */
function Thumb({ b, pack, hero = false }: { b: Building; pack: Pack; hero?: boolean }) {
  const variant = spriteVariant(pack, b.status, b.damage ?? 0);
  return (
    <span className={hero ? 'hero' : 'thumb'} aria-hidden="true">
      <img src={spriteUrl(b.kind, variant)} alt="" draggable={false} />
    </span>
  );
}

function unitFor(units: Unit[], buildingId: number) {
  return units.find((u) => u.targetId === buildingId && (u.status === 'enroute' || u.status === 'onscene'));
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

function Back({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="back" onClick={onClick}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
      All buildings
    </button>
  );
}

function Stats({ items }: { items: { label: string; value: ReactNode; tone?: 'ok' | 'bad' | '' }[] }) {
  return (
    <dl className="stats">
      {items.map((s) => (
        <div key={s.label}><dd className={s.tone ?? ''}>{s.value}</dd><dt>{s.label}</dt></div>
      ))}
    </dl>
  );
}

function Ticker({ events }: { events: LogEvent[] }) {
  const e = events[0];
  if (!e) return null;
  return (
    <p className={`ticker ${e.tone}`} aria-live="polite">
      <span className="ticker-dot" aria-hidden="true" />
      <span key={e.id} className="ticker-text">{e.text}</span>
    </p>
  );
}

function clickable(onClick: () => void) {
  return { role: 'button', tabIndex: 0, onClick, onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } };
}

// ------------------------------------------------------------------ prepare
function prepList(p: DockProps): View {
  const { sim, buildings, onSelect, onStartFire, pack } = p;
  const list = buildings.filter((b) => b.kind !== 'shelter').sort((a, b) => b.risk - a.risk);
  const prepared = list.filter((b) => b.prepared).length;
  const avgRisk = Math.round(list.reduce((s, b) => s + b.risk, 0) / Math.max(1, list.length));
  const loss = portfolio(list, p.profileFor);
  const spent = list.reduce((s, b) => s + p.fixesFor(b.id).filter((f) => (p.approved[b.id] ?? []).includes(f.key)).reduce((t, f) => t + f.cost, 0), 0);
  // what "Approve recommended fixes" would do right now (the server's approve_recommended, mirrored by the coach)
  const plan = p.onRecommend ? prepPlan({ sim, buildings, persons: [], tasks: [], units: [], fixesFor: p.fixesFor, profileFor: p.profileFor }, (id, key) => (p.approved[id] ?? []).includes(key)) : [];
  const left = list.flatMap((b) => p.fixesFor(b.id).filter((f) => !(p.approved[b.id] ?? []).includes(f.key)));
  const planLabel = plan.length ? 'Approve recommended fixes'
    : left.length && left.every((f) => f.cost > sim.budgetLeft) ? 'Budget spent' : 'All set';
  return {
    head: (
      <>
        <p className="eyebrow step">Step 1 of 3</p>
        <h2 className="list-title">Prepare the neighborhood</h2>
        <Stats items={[
          { label: 'budget left', value: fmtUsd(sim.budgetLeft) },
          { label: 'prepared', value: <>{prepared}<small>/{list.length}</small></>, tone: prepared === list.length ? 'ok' : '' },
          ...(loss ? [{ label: 'expected loss', value: fmtUsd(Math.round(loss.now)), tone: (loss.avoided > 0 ? 'ok' : '') as 'ok' | '' }] : [{ label: 'average risk', value: avgRisk, tone: (avgRisk >= 70 ? 'bad' : '') as 'bad' | '' }]),
        ]} />
      </>
    ),
    body: (
      <>
        {loss && (
          <p className="hint impact-line">
            {loss.avoided > 0
              ? <>Prep so far avoids <b>{fmtUsd(Math.round(loss.avoided))}</b> of expected loss for <b>{fmtUsd(spent)}</b> spent.</>
              : <>Expected loss if an Eaton-like fire starts: <b>{fmtUsd(Math.round(loss.now))}</b> across the portfolio.</>}
          </p>
        )}
        <h3 className="section">Highest risk first</h3>
        <ul className="list" aria-label="Buildings by risk">
          {list.map((b) => (
            <li key={b.id} className="item" {...clickable(() => onSelect(b.id))}>
              <Thumb b={b} pack={pack} />
              <span className="item-text">
                <span className="item-name">{b.name}</span>
                <span className="item-detail">{b.residents} residents · evacuation {fmtMin(b.evacNeededMin)}</span>
              </span>
              {b.prepared ? (
                <span className="score ok"><Check size={18} /><small>ready</small></span>
              ) : (
                <span className="score" style={{ color: riskColor(b.risk) }}>{Math.round(b.risk)}<small>risk</small></span>
              )}
            </li>
          ))}
        </ul>
      </>
    ),
    foot: (
      <>
        {p.onRecommend && <button type="button" className="btn secondary wide" disabled={!plan.length} onClick={p.onRecommend}>{planLabel}</button>}
        <button type="button" className="btn fire wide" onClick={onStartFire}>Start the fire <Arrow /></button>
      </>
    ),
  };
}

function prepDetail(p: DockProps, b: Building): View {
  const { sim, approved, onSelect, onApprove, pack } = p;
  const done = approved[b.id] ?? [];
  const ref = p.prepared.referenceEta(b);
  const profile = p.profileFor?.(b.id);
  const lossNow = expectedLoss(b, profile);
  const lossBefore = expectedLoss(b, profile, b.baseRisk);
  const checklist = p.checklistFor?.(b.id) ?? [];
  const documented = checklist.filter((m) => m.status === 'met').length;
  return {
    head: (
      <>
        <Back onClick={() => onSelect(null)} />
        <p className="eyebrow">{KIND_LABEL[b.kind]}</p>
        <h2>{b.name}</h2>
        <Stats items={[
          { label: 'risk', value: <span style={{ color: riskColor(b.risk) }}>{Math.round(b.risk)}</span> },
          { label: 'evacuation', value: fmtMin(b.evacNeededMin), tone: ref >= 0 && b.evacNeededMin > ref ? 'bad' : '' },
          { label: 'need help', value: <>{b.needsHelp}<small>/{b.residents}</small></> },
        ]} />
      </>
    ),
    body: (
      <>
        <Thumb b={b} pack={pack} hero />
        {b.explanation && (
          <div className="note">
            <h3 className="section">Why it is at risk</h3>
            <p>{b.explanation}</p>
          </div>
        )}
        {profile && lossNow !== undefined && (
          <>
            <h3 className="section">Business impact</h3>
            <dl className="facts">
              <div><dt>expected loss</dt><dd className={lossBefore !== undefined && lossNow < lossBefore ? 'ok' : ''}>{fmtUsd(Math.round(lossNow))}</dd></div>
              <div><dt>fire reaches it</dt><dd>{Math.round(profile.reachProbability * 100)}%</dd></div>
              <div><dt>building value</dt><dd>{fmtUsd(b.valueUsd)}</dd></div>
            </dl>
            <p className="hint">
              {lossBefore !== undefined && lossNow < lossBefore ? `Down from ${fmtUsd(Math.round(lossBefore))} before fixes. ` : ''}
              Value × chance an Eaton-like fire reaches it × chance it is lost if reached.
            </p>
          </>
        )}
        <h3 className="section">Fixes</h3>
        <ul className="list" aria-label="Fixes">
          {p.fixesFor(b.id).map((f) => {
            const on = done.includes(f.key);
            const afford = sim.budgetLeft >= f.cost;
            return (
              <li key={f.key}>
                <button type="button" className={`item fix ${on ? 'on' : ''}`} disabled={on || !afford} onClick={() => onApprove(b.id, f.key)} aria-pressed={on}>
                  <span className="tick" aria-hidden="true">{on && <Check />}</span>
                  <span className="item-text">
                    <span className="item-name">{f.name}</span>
                    <span className="item-detail">{f.addVans ? `Adds ${f.addVans} van, faster evacuation` : `Lowers risk by ${f.riskDrop}${f.simulated ? ' (simulated)' : ''}${profile && !on && fixAvoids(b, profile, f) > 0 ? ` · avoids ${fmtUsd(Math.round(fixAvoids(b, profile, f)))}` : ''}`}</span>
                  </span>
                  <span className="cost">{on ? 'Done' : afford ? fmtUsd(f.cost) : 'Over budget'}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {checklist.length > 0 && (
          <>
            <h3 className="section">Insurance mitigation · {documented} of {checklist.length} documented</h3>
            <ul className="list checklist" aria-label="Insurance mitigation measures">
              {checklist.map((m) => (
                <li key={m.measure} className="item static">
                  <span className={`tick measure ${m.status}`} aria-hidden="true">{m.status === 'met' ? <Check /> : m.status === 'missing' ? '✕' : '?'}</span>
                  <span className="item-text">
                    <span className="item-name measure-name">{m.measure}</span>
                    <span className="item-detail">{m.note}</span>
                  </span>
                  <span className={`state ${m.status === 'met' ? 'ok' : m.status === 'missing' ? 'bad' : 'muted'}`}>{m.status === 'met' ? 'Documented' : m.status === 'missing' ? 'Missing' : 'Unverified'}</span>
                </li>
              ))}
            </ul>
            <p className="hint">California’s Safer from Wildfires rule (10 CCR § 2644.9) requires insurers that price wildfire risk to discount documented mitigation; the state cites 4% to 40%+.</p>
          </>
        )}
        <p className="hint">
          {b.prepared ? `Prepared. Risk is under ${p.prepared.riskMax} and evacuation beats the fire, so the building earns a better insurance rating.`
            : ref >= 0 ? `Prepared when risk is under ${p.prepared.riskMax} and evacuation takes under ${fmtMin(ref)}${ref === b.fireEtaMin ? ', when a fire like Eaton would reach it' : ''}.`
              : `Prepared when risk is under ${p.prepared.riskMax}. A fire like Eaton is not expected to reach it.`}
        </p>
        {profile && <p className="hint sources">{profile.sources}</p>}
      </>
    ),
    foot: (
      <div className="foot-row">
        <span className="foot-note">{fmtUsd(sim.budgetLeft)} left</span>
        <button type="button" className="btn ghost" onClick={() => onSelect(null)}>Done</button>
      </div>
    ),
  };
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
      <div className="race-legend"><span>Evacuation {fmtMin(need)}</span><span className="bad">Fire {fmtMin(eta)}</span></div>
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
  if (b.status === 'lost') return <span className="state muted">Collapsed</span>;
  if (b.status === 'clear') return <span className="state ok">All out</span>;
  if (b.evacStarted) {
    const pct = (100 * b.peopleOut) / Math.max(1, b.residents);
    return (
      <span className="progress-mini" aria-label={`${b.peopleOut} of ${b.residents} out`}>
        <span>{b.peopleOut}/{b.residents}</span>
        <span className="mini-bar"><span style={{ width: `${pct}%` }} /></span>
      </span>
    );
  }
  if (b.status === 'burning') return <span className="state bad">{(b.damage ?? 0) >= 2 ? 'Gutted' : 'Burning'}</span>;
  if (sim.phase !== 'fire') return null;
  return (
    <button type="button" className={`btn small ${b.status === 'behind' ? 'urgent' : ''}`} onClick={(e) => { e.stopPropagation(); onEvacuate(b.id); }}>
      Evacuate
    </button>
  );
}

const STAGES = ['Intact', 'Burning', 'Gutted', 'Collapsed'];

function Structure({ b }: { b: Building }) {
  const stage = b.status === 'lost' ? 3 : b.status === 'burning' ? Math.max(1, b.damage ?? 1) : 0;
  return (
    <ol className="structure" aria-label={`Structure: ${STAGES[stage]}`}>
      {STAGES.map((s, i) => (
        <li key={s} className={i < stage ? 'past' : i === stage ? `now s${i}` : ''}>{s}</li>
      ))}
    </ol>
  );
}

function Log({ events, sim }: { events: LogEvent[]; sim: Sim }) {
  if (!events.length) return null;
  // the log carries ticks; the sim's own minutes per tick so far turn them into the top bar's clock (speed changes)
  const perTick = sim.tick > 0 ? sim.simMinutes / sim.tick : sim.minutesPerTick;
  return (
    <>
      <h3 className="section">Incident log</h3>
      <ol className="log" aria-label="Incident log">
        {events.slice(0, 8).map((e) => (
          <li key={e.id} className={e.tone}>
            <time>{fmtClock(Math.min(sim.simMinutes, Math.round(e.tick * perTick)))}</time>
            <span>{e.text}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

function fireHead(p: DockProps, tab: Tab, setTab: (t: Tab) => void): ReactNode {
  const list = p.buildings.filter((b) => b.kind !== 'shelter');
  const total = p.persons.length;
  // the coach's headcount: safe = out or confirmed safe; unaccounted = told to leave and not yet out or safe
  const { accounted, unaccounted } = headcount(p.persons, p.buildings);
  const safe = accounted.length;
  const missing = unaccounted.length;
  const atRisk = list.filter((b) => b.status === 'behind' || b.status === 'burning').length;
  const free = p.units.filter((u) => u.status === 'ready').length;
  return (
    <>
      <p className="eyebrow step">Step 2 of 3 · {windFrom(p.sim.windDirDeg)} wind {p.sim.windMph} mph</p>
      <h2 className="list-title">Fire response</h2>
      <Stats items={[
        { label: 'people safe', value: <>{safe}<small>/{total}</small></>, tone: safe === total ? 'ok' : '' },
        { label: 'unaccounted', value: missing, tone: missing ? 'bad' : '' },
        { label: 'buildings at risk', value: atRisk, tone: atRisk ? 'bad' : '' },
        ...(p.units.length ? [{ label: 'units free', value: <>{free}<small>/{p.units.length}</small></> }] : []),
      ]} />
      <div className="tabs" role="tablist" aria-label="Fire view">
        <button type="button" role="tab" aria-selected={tab === 'people'} className={tab === 'people' ? 'on' : ''} onClick={() => setTab('people')}>Residents</button>
        {p.units.length > 0 && (
          <button type="button" role="tab" aria-selected={tab === 'units'} className={tab === 'units' ? 'on' : ''} onClick={() => setTab('units')}>
            <span className="long">Incident command</span><span className="short">Command</span>
          </button>
        )}
        {p.phone && <button type="button" role="tab" aria-selected={tab === 'phone'} className={tab === 'phone' ? 'on' : ''} onClick={() => setTab('phone')}>Phone</button>}
      </div>
      <Ticker events={p.events} />
    </>
  );
}

function fireList(p: DockProps): ReactNode {
  const { sim, buildings, onSelect, onEvacuate, pack } = p;
  const list = buildings.filter((b) => b.kind !== 'shelter').sort((a, b) => urgency(a) - urgency(b));
  return (
    <>
      <h3 className="section">Who needs help first</h3>
      <ul className="list" aria-label="Buildings by urgency">
        {list.map((b) => {
          const tag = statusTag(b, sim.phase);
          const u = unitFor(p.units, b.id);
          const detail = b.evacStarted || b.status === 'lost' || b.status === 'clear'
            ? `${b.residents} residents · ${b.needsHelp} need help`
            : b.status === 'burning'
              ? `${b.residents - b.peopleOut} still inside`
              : b.fireEtaMin >= 0 ? `Fire ${fmtShort(b.fireEtaMin)} · out in ${fmtShort(b.evacNeededMin)}` : `No fire path · out in ${fmtShort(b.evacNeededMin)}`;
          return (
            <li key={b.id} className="item" {...clickable(() => onSelect(b.id))}>
              <span className="thumb-wrap">
                <Thumb b={b} pack={pack} />
                <span className="dot" style={{ background: tag.color }} aria-hidden="true" />
              </span>
              <span className="item-text">
                <span className="item-name">{b.name}{u && <span className="item-unit" title={u.name}><TruckIcon size={14} /></span>}</span>
                <span className="item-detail wrap">{detail}</span>
              </span>
              <RowAction b={b} sim={sim} onEvacuate={onEvacuate} />
            </li>
          );
        })}
      </ul>
    </>
  );
}

function incident(p: DockProps): ReactNode {
  const { sim, buildings, units, cells, onSelect, onDispatch, onRelease, pack } = p;
  const burning = cells.filter((c) => c.state === 1).length;
  const hills = cells.filter((c) => c.fuel >= 1 || c.state === 2).length || 1;
  const burned = cells.filter((c) => c.state === 2).length;
  const free = units.filter((u) => u.status === 'ready').length;
  const needs = buildings
    .filter((b) => b.kind !== 'shelter' && !unitFor(units, b.id) && (b.status === 'behind' || b.status === 'burning' || (b.fireEtaMin >= 0 && b.fireEtaMin < 90 && b.status !== 'lost' && b.status !== 'clear')))
    .sort((a, b) => (a.status === 'burning' ? -1 : 0) - (b.status === 'burning' ? -1 : 0) || a.fireEtaMin - b.fireEtaMin)
    .slice(0, 4);
  return (
    <>
      <dl className="facts">
        <div><dt>Burning now</dt><dd className={burning ? 'bad' : ''}>{burning} cells</dd></div>
        <div><dt>Hills burned</dt><dd>{Math.min(100, Math.round((100 * burned) / hills))}%</dd></div>
        <div><dt>Wind from</dt><dd>{windFrom(sim.windDirDeg)} · {sim.windMph} mph</dd></div>
      </dl>
      {needs.length > 0 && (
        <>
          <h3 className="section">Needs a unit</h3>
          <ul className="list" aria-label="Buildings that need a unit">
            {needs.map((b) => (
              <li key={b.id} className="item" {...clickable(() => onSelect(b.id))}>
                <Thumb b={b} pack={pack} />
                <span className="item-text">
                  <span className="item-name">{b.name}</span>
                  <span className="item-detail">{b.status === 'burning' ? 'Burning' : `Fire in ${fmtMin(b.fireEtaMin)}`} · {b.residents - b.peopleOut} inside</span>
                </span>
                <button type="button" className="btn small urgent" disabled={!free} onClick={(e) => { e.stopPropagation(); onDispatch(b.id); }}>Send unit</button>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3 className="section">Units</h3>
      <ul className="list" aria-label="Units">
        {units.map((u) => {
          const b = buildings.find((x) => x.id === u.targetId);
          const text = u.status === 'ready' ? 'At staging, ready' : u.status === 'enroute' ? `Responding to ${b?.name}` : u.status === 'returning' ? 'Returning to staging'
            : b?.status === 'burning' ? `On scene at ${b.name}, water on` : `Standing by at ${b?.name}`;
          return (
            <li key={u.id} className="item static">
              <span className={`unit-badge ${u.status}`}><TruckIcon /></span>
              <span className="item-text"><span className="item-name">{u.name}</span><span className="item-detail">{text}</span></span>
              {(u.status === 'enroute' || u.status === 'onscene') && <button type="button" className="btn small" onClick={() => onRelease(u.id)}>Return</button>}
            </li>
          );
        })}
      </ul>
      <Log events={p.events} sim={sim} />
    </>
  );
}

function fireDetail(p: DockProps, b: Building): View {
  const { sim, onSelect, onEvacuate, pack } = p;
  const tag = statusTag(b, sim.phase);
  const canEvac = sim.phase === 'fire' && !b.evacStarted && b.status !== 'lost' && b.status !== 'burning' && b.kind !== 'shelter';
  const u = unitFor(p.units, b.id);
  const free = p.units.find((x) => x.status === 'ready');
  const canSend = p.units.length > 0 && sim.phase === 'fire' && b.kind !== 'shelter' && b.status !== 'lost' && !u;
  return {
    head: (
      <>
        <Back onClick={() => onSelect(null)} />
        <p className="eyebrow">{KIND_LABEL[b.kind]} · {b.residents} residents · {b.vans} van{b.vans === 1 ? '' : 's'}</p>
        <div className="title-row">
          <h2>{b.name}</h2>
          <span className="state" style={{ color: tag.color }}>{tag.text}</span>
        </div>
      </>
    ),
    body: (
      <>
        <Thumb b={b} pack={pack} hero />
        {b.kind !== 'shelter' && <Structure b={b} />}
        {b.kind !== 'shelter' && b.status !== 'lost' && b.status !== 'clear' && <Race b={b} />}
        {u && <p className="unit-line"><TruckIcon /> {u.name} {u.status === 'enroute' ? 'is on the way' : b.status === 'burning' ? 'is on scene, water on the building' : 'is on scene, crew standing by'}</p>}
        {b.evacStarted && (
          <div className="progress">
            <div className="progress-row"><span>Residents out</span><b>{b.peopleOut} of {b.residents}</b></div>
            <div className="meter"><div style={{ width: `${(100 * b.peopleOut) / Math.max(1, b.residents)}%` }} /></div>
          </div>
        )}
        {(() => {
          // the same headcount as the panel header and the coach: everyone told to leave who is not out or safe yet,
          // the ones waiting for staff first
          const rank = (s: Person['status']) => (s === 'cant_move' ? 0 : s === 'claimed' ? 1 : 2);
          const missing = headcount(p.persons, p.buildings).unaccounted.filter((x) => x.buildingId === b.id).sort((x, y) => rank(x.status) - rank(y.status));
          if (!missing.length) return null;
          const tag = (x: Person) => (x.status === 'cant_move' ? ', waiting for staff' : x.status === 'claimed' ? ', staff on the way' : x.status === 'left_behind' ? ', left behind' : '');
          return (
            <div className="names">
              <h3 className="section">Unaccounted · {missing.length}</h3>
              <p>{missing.slice(0, 12).map((x) => `${x.name} (fl ${x.floor}${x.note ? `, ${x.note}` : ''}${tag(x)})`).join(' · ')}{missing.length > 12 ? ` and ${missing.length - 12} more` : ''}</p>
            </div>
          );
        })()}
        {b.status === 'lost' && <p className="hint">The building collapsed. {b.residents - b.peopleOut > 0 ? `${b.residents - b.peopleOut} residents were still inside.` : 'Everyone was already out.'}</p>}
        {b.status === 'clear' && <p className="hint">Everyone is out and accounted for.</p>}
        {b.kind === 'shelter' && <p className="hint">Destination for every evacuation. {b.residents} beds.</p>}
      </>
    ),
    foot: canEvac || canSend ? (
      <div className="foot-row">
        {canEvac && <button type="button" className="btn primary grow" onClick={() => onEvacuate(b.id)}>Start evacuation</button>}
        {canSend && (
          <button type="button" className="btn secondary grow" disabled={!free} onClick={() => p.onDispatch(b.id)}>
            <TruckIcon /> {free ? `Send ${free.name}` : 'All units busy'}
          </button>
        )}
      </div>
    ) : undefined,
  };
}

// ------------------------------------------------------------------ results
function results(p: DockProps): View {
  const { sim, buildings, onRestart, onSelect, pack } = p;
  const list = buildings.filter((b) => b.kind !== 'shelter');
  const w = p.results?.with;
  const wo = p.results?.without;
  const rows: { label: string; a: string; b: string; better: boolean }[] = w && wo ? [
    { label: 'People safe', a: `${w.peopleSafe}/${w.peopleTotal}`, b: `${wo.peopleSafe}/${wo.peopleTotal}`, better: w.peopleSafe > wo.peopleSafe },
    { label: 'Buildings lost', a: `${w.buildingsLost}`, b: `${wo.buildingsLost}`, better: w.buildingsLost < wo.buildingsLost },
    { label: 'Damage', a: fmtUsd(w.damageUsd), b: fmtUsd(wo.damageUsd), better: w.damageUsd < wo.damageUsd },
    { label: 'Insurance claims', a: `${w.claims}`, b: `${wo.claims}`, better: w.claims < wo.claims },
  ] : [];
  return {
    head: (
      <>
        <p className="eyebrow">The fire is out · {Math.floor(sim.simMinutes / 60)}h {sim.simMinutes % 60}m after ignition</p>
        <h2>The best claim is the one that never happens</h2>
      </>
    ),
    body: (
      <>
        {rows.length > 0 && (
          <table className="compare">
            <thead><tr><th /><th>With Aegis</th><th>Without</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}><th scope="row">{r.label}</th><td className={r.better ? 'ok' : ''}>{r.a}</td><td>{r.b}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">Without Aegis: the same fire with no fixes, no fire units, and evacuation only once the fire is 10 minutes away. Simulated neighborhood; fire calibrated to the real Eaton Fire.</p>
        <h3 className="section">Every building</h3>
        <ul className="list">
          {list.sort((a, b) => urgency(b) - urgency(a)).map((b) => (
            <li key={b.id} className="item" {...clickable(() => onSelect(b.id))}>
              <Thumb b={b} pack={pack} />
              <span className="item-text">
                <span className="item-name">{b.name}</span>
                <span className="item-detail">{b.peopleOut} of {b.residents} out</span>
              </span>
              <span className={`state ${b.status === 'lost' ? 'muted' : b.touched ? 'warn' : 'ok'}`}>{b.status === 'lost' ? 'Collapsed' : b.touched ? 'Damaged' : 'Standing'}</span>
            </li>
          ))}
        </ul>
      </>
    ),
    foot: <button type="button" className="btn primary wide" onClick={onRestart}>Run again</button>,
  };
}

// ------------------------------------------------------------------ the panel: side column on wide screens, a draggable sheet on phones
const PHONE = 760;

function usePhone() {
  const [phone, setPhone] = useState(() => window.innerWidth <= PHONE);
  const [vh, setVh] = useState(() => window.innerHeight);
  useEffect(() => {
    const on = () => { setPhone(window.innerWidth <= PHONE); setVh(window.innerHeight); };
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return { phone, vh };
}

export const Dock = forwardRef<HTMLElement, DockProps>(function Dock(props, ref) {
  const { sim, selected, topLimit } = props;
  const [tab, setTab] = useState<Tab>('people');
  const { phone, vh } = usePhone();

  // sheet heights: peek (title + main button), half, full
  const snaps = [Math.max(250, Math.round(vh * 0.32)), Math.round(vh * 0.54), Math.max(Math.round(vh * 0.54), vh - topLimit - 56)];
  const [snap, setSnap] = useState(1);
  const [dragH, setDragH] = useState<number | null>(null);
  const drag = useRef<{ y: number; h: number; moved: boolean; id: number } | null>(null);
  const justDragged = useRef(false);

  // a building picked on the map should be readable without dragging the sheet up first
  const selId = selected?.id ?? null;
  const [lastSel, setLastSel] = useState(selId);
  if (selId !== lastSel) {
    setLastSel(selId);
    if (selId != null && snap < 1) setSnap(1);
  }
  // the body starts at the top whenever the view changes
  const bodyRef = useRef<HTMLDivElement>(null);
  const viewKey = `${sim.phase}-${selId}-${tab}`;
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [viewKey]);

  let view: View;
  if (sim.phase === 'ended' && !selected) view = results(props);
  else if (sim.phase === 'prep') view = selected && selected.kind !== 'shelter' ? prepDetail(props, selected) : prepList(props);
  else if (selected) view = fireDetail(props, selected);
  else view = {
    head: fireHead(props, tab, setTab),
    body: tab === 'people' ? fireList(props) : tab === 'units' && props.units.length ? incident(props) : tab === 'phone' ? props.phone : fireList(props),
    foot: props.onEndCompare && sim.phase === 'fire' ? <button type="button" className="btn secondary wide" onClick={props.onEndCompare}>Skip to the end and compare</button> : undefined,
  };

  const onDown = (e: React.PointerEvent) => {
    if (!phone) return;
    drag.current = { y: e.clientY, h: dragH ?? snaps[snap], moved: false, id: e.pointerId };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = d.y - e.clientY;
    if (!d.moved && Math.abs(dy) < 8) return;
    if (!d.moved) { d.moved = true; (e.currentTarget as HTMLElement).setPointerCapture(d.id); }
    setDragH(Math.min(snaps[2], Math.max(snaps[0] - 40, d.h + dy)));
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      if ((e.target as HTMLElement).closest('.grip')) setSnap((s) => (s + 1) % 3);
      return;
    }
    justDragged.current = true;
    setTimeout(() => { justDragged.current = false; }, 0);
    const h = dragH ?? d.h;
    const v = d.h - h; // positive: dragged down
    let best = 0;
    snaps.forEach((s, i) => { if (Math.abs(s - h) < Math.abs(snaps[best] - h)) best = i; });
    // a short flick still moves one step in the direction of the drag
    if (best === snap && Math.abs(v) > 40) best = Math.max(0, Math.min(2, snap + (v > 0 ? -1 : 1)));
    setSnap(best);
    setDragH(null);
  };

  const height = phone ? (dragH ?? snaps[snap]) : undefined;
  return (
    <section
      ref={ref}
      className={`panel map-chrome ${dragH != null ? 'dragging' : ''}`}
      style={height ? { height } : undefined}
      aria-label="Control panel"
    >
      <div className="panel-head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onClickCapture={(e) => { if (justDragged.current) e.stopPropagation(); }}>
        <button type="button" className="grip" aria-label="Resize panel"><span /></button>
        {props.bar}
        <div className="head-view">{view.head}</div>
      </div>
      <div className="panel-body" ref={bodyRef}>{view.body}</div>
      {view.foot && <div className="panel-foot">{view.foot}</div>}
    </section>
  );
});
