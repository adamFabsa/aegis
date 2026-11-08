// The phone: Lantern AI's step-by-step instructions (default), a resident checking in, and staff claiming
// help tasks. Drawn inside a phone frame on wide screens, as a tab on phones, and full screen at ?view=phone.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Building, Person, ScenarioResult, Sim, Task } from '../town/types';
import { staffOf, type Unit } from '../town/mockWorld';
import type { BuildingProfile, FixView, Measure } from '../town/world';
import { advise, type Action, type Instruction } from './advisor';
import { fmtClock, fmtUsd } from './format';
import { PersonPicker, type PickItem, type PickTone } from './PersonPicker';

/** A resident's state as a pill in the picker. */
function residentTag(x: Person): { tone: PickTone; tag?: string } {
  switch (x.status) {
    case 'pinged': return x.escalated && !x.replyText ? { tone: 'bad', tag: 'No reply' } : { tone: 'warn', tag: 'Asked' };
    case 'cant_move': return { tone: 'bad', tag: 'Needs help' };
    case 'claimed': return { tone: 'warn', tag: 'Help coming' };
    case 'safe': return { tone: 'ok', tag: 'Safe' };
    case 'out': return { tone: 'ok', tag: 'Out' };
    case 'left_behind': return { tone: 'bad', tag: 'Left behind' };
    default: return { tone: 'idle' };
  }
}

export interface PhoneProps {
  sim: Sim;
  buildings: Building[];
  persons: Person[];
  tasks: Task[];
  /** live calls resolve to the server's error message (null = ok); the mock answers synchronously */
  onReply: (personId: number, choice: 'safe' | 'cant_move' | 'text', text?: string) => Answer | void;
  onClaim: (taskId: number, staff: string) => Answer;
  onDone: (taskId: number) => Answer | void;
  initialRole?: 'advisor' | 'resident' | 'staff';
  initialPerson?: number;
  initialStaff?: string;
  /** Lantern AI (the advisor tab): shown when fixesFor is given */
  units?: Unit[];
  fixesFor?: (buildingId: number) => FixView[];
  approved?: Record<number, string[]>;
  profileFor?: (buildingId: number) => BuildingProfile | undefined;
  checklistFor?: (buildingId: number) => Measure[];
  results?: { with: ScenarioResult; without: ScenarioResult };
  selectedId?: number | null;
  onApprove?: (buildingId: number, key: string) => void;
  onRecommend?: () => void;
  onEvacuate?: (buildingId: number) => void;
  onDispatch?: (buildingId: number) => Answer | void;
  onAssign?: (taskId: number) => Answer;
  onSelect?: (buildingId: number | null) => void;
  workerOnline?: boolean;
}

type Answer = string | null | Promise<string | null>;
const staffName = (claimedBy: string) => claimedBy.replace(' · on-site', '');

function Bubble({ from, children }: { from: 'lantern' | 'me'; children: React.ReactNode }) {
  return <p className={`bubble ${from}`}>{children}</p>;
}

function ResidentView({ sim, buildings, persons, tasks, onReply, initialPerson }: PhoneProps) {
  const [pid, setPid] = useState(() => initialPerson ?? persons.find((p) => p.name === 'Maria R.')?.id ?? persons[0]?.id ?? 0);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reply = async (choice: 'safe' | 'cant_move' | 'text', t?: string) => { const r = await onReply(pid, choice, t); setError(typeof r === 'string' ? r : null); };
  const p = persons.find((x) => x.id === pid);
  const groups = useMemo(() => buildings.filter((b) => b.kind !== 'shelter').map((b) => ({ b, list: persons.filter((x) => x.buildingId === b.id) })), [buildings, persons]);
  if (!p) return null;
  const b = buildings.find((x) => x.id === p.buildingId)!;
  const task = tasks.find((t) => t.personId === p.id && !t.done) ?? tasks.find((t) => t.personId === p.id);
  const pinged = p.status !== 'inside';
  const answered = p.status === 'safe' || p.status === 'cant_move' || p.status === 'claimed' || p.status === 'out' || p.replyText;
  const canAnswer = pinged && p.status !== 'out' && p.status !== 'left_behind' && sim.phase === 'fire';
  // what the resident said (from the phone, or the reply the simulation answered for them)
  const myReply = p.replyText || (p.status === 'safe' ? "I'm safe" : p.status === 'cant_move' ? "I can't get out" : '');
  return (
    <div className="phone-body">
      <PersonPicker label="resident" placeholder="Search name, building or need" value={String(pid)}
        onChange={(id) => { setPid(Number(id)); setError(null); }}
        items={groups.flatMap(({ b: g, list }) => list.map((x): PickItem => ({
          id: String(x.id), name: x.name, group: g.name,
          sub: `${g.kind === 'homes' ? g.name : `Floor ${x.floor}`}${x.note ? ` · ${x.note}` : ''}`,
          ...residentTag(x),
        })))} />
      <div className="chat" aria-live="polite">
        {!pinged ? (
          <Bubble from="lantern">{sim.phase === 'prep' ? `Hi ${p.name.split(' ')[0]}, Lantern watches the fire risk for ${b.name}. Nothing to do right now.`
            : sim.phase === 'ended' ? `The fire is out. ${b.name} did not need to evacuate. Lantern will message you if anything changes.`
              : `Fire is burning in the hills. ${b.name} has not been asked to leave yet. Keep this phone close.`}</Bubble>
        ) : (
          <Bubble from="lantern">Fire is approaching {b.name}. Evacuation has started. Are you safe?</Bubble>
        )}
        {myReply && <Bubble from="me">{myReply}</Bubble>}
        {p.escalated && !myReply && p.status !== 'out' && <Bubble from="lantern">No reply yet, so we have asked staff to check on you.</Bubble>}
        {pinged && answered && p.status === 'safe' && <Bubble from="lantern">Thank you. Walk to Shelter A at the community center, following the green route.</Bubble>}
        {p.status === 'cant_move' && <Bubble from="lantern">Staff have been told. Stay where you are, close the door, and keep this phone with you.</Bubble>}
        {p.status === 'claimed' && task?.claimedBy && <Bubble from="lantern">Help is on the way: {staffName(task.claimedBy)} is coming to floor {p.floor}.</Bubble>}
        {p.status === 'out' && <Bubble from="lantern">You are out and checked in. Shelter A has water, beds and medical staff.</Bubble>}
        {p.status === 'left_behind' && <Bubble from="lantern">We lost contact with you. Firefighters have your floor and room.</Bubble>}
      </div>
      {error && <p className="phone-error" role="alert">{error}</p>}
      {canAnswer && p.status === 'pinged' && (
        <div className="phone-actions">
          <div className="phone-btns">
            <button type="button" className="btn primary" onClick={() => void reply('safe')}>I'm safe</button>
            <button type="button" className="btn fire" onClick={() => void reply('cant_move')}>I can't get out</button>
          </div>
          <form className="phone-text" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { void reply('text', text.trim()); setText(''); } }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Or type a message" aria-label="Message to Lantern" />
            <button type="submit" className="btn small" disabled={!text.trim()}>Send</button>
          </form>
        </div>
      )}
    </div>
  );
}

function StaffView({ buildings, persons, tasks, onClaim, onDone, initialStaff }: PhoneProps) {
  // each name once: the generated rosters can repeat a first name across buildings
  const crew = useMemo(() => {
    const seen = new Set<string>();
    return buildings.filter((b) => b.staff > 0 && b.kind !== 'shelter')
      .map((b) => ({ b, names: staffOf(b).filter((n) => !seen.has(n) && !!seen.add(n)) }))
      .filter((g) => g.names.length > 0);
  }, [buildings]);
  const [me, setMe] = useState(initialStaff ?? crew[0]?.names[0] ?? 'Alex');
  const [error, setError] = useState<string | null>(null);
  const open = tasks.filter((t) => !t.done).sort((a, b) => b.priority - a.priority || a.createdTick - b.createdTick);
  const mine = open.filter((t) => t.claimedBy === me);
  const rest = open.filter((t) => t.claimedBy !== me);
  const row = (t: Task) => {
    const p = persons.find((x) => x.id === t.personId);
    const b = buildings.find((x) => x.id === t.buildingId);
    return (
      <li key={t.id} className={`task ${t.claimedBy === me ? 'mine' : ''}`}>
        <span className="task-text">
          <b>{p?.name}</b>
          <small>{b?.name} · floor {p?.floor}{p?.note ? ` · ${p.note}` : ''}{p?.escalated && !p.replyText ? ' · no reply' : ''}</small>
          {t.claimedBy && t.claimedBy !== me && <small className="claimed">Claimed by {staffName(t.claimedBy)}{t.auto ? ' (on-site staff)' : ''}</small>}
        </span>
        {t.claimedBy === me ? (
          <button type="button" className="btn small" onClick={async () => { const r = await onDone(t.id); setError(typeof r === 'string' ? r : null); }}>Done</button>
        ) : !t.claimedBy ? (
          <button type="button" className="btn small urgent" onClick={async () => setError(await onClaim(t.id, me))}>Claim</button>
        ) : null}
      </li>
    );
  };
  return (
    <div className="phone-body">
      <PersonPicker label="staff member" placeholder="Search staff or building" value={me}
        onChange={(n) => { setMe(n); setError(null); }}
        items={crew.flatMap(({ b, names }) => names.map((n): PickItem => {
          const jobs = open.filter((t) => t.claimedBy === n).length;
          return { id: n, name: n, group: b.name, sub: `On duty at ${b.name}`, tone: jobs ? 'warn' : 'idle', tag: jobs ? `${jobs} task${jobs === 1 ? '' : 's'}` : undefined };
        }))} />
      {error && <p className="phone-error" role="alert">{error}</p>}
      {mine.length > 0 && <><h4 className="phone-h">Your tasks</h4><ul className="tasks">{mine.map(row)}</ul></>}
      <h4 className="phone-h">Open tasks · most urgent first</h4>
      {rest.length ? <ul className="tasks">{rest.map(row)}</ul> : <p className="phone-empty">No one is waiting for help right now.</p>}
    </div>
  );
}

/** People and money chips on an instruction. */
function Impact({ it }: { it: Instruction }) {
  if (!it.people && !it.usd) return null;
  return (
    <span className="ai-impact">
      {it.people ? <span className="chip people">{it.people} {it.people === 1 ? 'person' : 'people'}</span> : null}
      {it.usd ? <span className="chip money">{fmtUsd(it.usd)} claims</span> : null}
    </span>
  );
}

function AdvisorView(props: PhoneProps) {
  const { sim, buildings, persons, tasks } = props;
  const advice = useMemo(() => advise({
    sim, buildings, persons, tasks, units: props.units ?? [], fixesFor: props.fixesFor ?? (() => []),
    profileFor: props.profileFor, checklistFor: props.checklistFor, results: props.results, selectedId: props.selectedId, canAssign: !!props.onAssign,
  }, props.approved ?? {}), [sim, buildings, persons, tasks, props.units, props.fixesFor, props.profileFor, props.checklistFor, props.results, props.selectedId, props.approved, props.onAssign]);
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  // Only a card the list has not shown before slides in. A CSS animation would replay whenever React moves a
  // card to a new rank (a DOM move restarts it), so the entrance is a one-off Web Animation started from the
  // card's ref; cards that leave are forgotten, so one that comes back later slides in again.
  const shown = useRef(new Set<string>());
  const ids = advice.items.map((it) => it.id).join('|');
  useEffect(() => {
    const now = new Set(ids.split('|'));
    for (const id of shown.current) if (!now.has(id)) shown.current.delete(id);
  }, [ids]);
  const enter = (id: string) => (el: HTMLLIElement | null) => {
    if (!el || shown.current.has(id)) return;
    shown.current.add(id);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    el.animate?.([{ opacity: 0, transform: 'translateY(8px) scale(0.985)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  };
  const [error, setError] = useState<string | null>(null);
  // a pressed button stays disabled until the shared state moves on (the card then changes or disappears)
  const stamp = `${sim.phase}:${sim.tick}:${sim.budgetLeft}`;
  const last = useRef(stamp);
  useEffect(() => { if (last.current !== stamp) { last.current = stamp; setBusy(new Set()); } }, [stamp]);
  const act = async (a: Action, id: string) => {
    setBusy((b) => new Set(b).add(id));
    setError(null);
    let r: string | null | void = null;
    if (a.kind === 'approve') props.onApprove?.(a.buildingId, a.fixKey);
    else if (a.kind === 'plan') props.onRecommend?.();
    else if (a.kind === 'evacuate') props.onEvacuate?.(a.buildingId);
    else if (a.kind === 'dispatch') r = await props.onDispatch?.(a.buildingId);
    else if (a.kind === 'assign') {
      // one assign_staff per resident; a grouped card sends staff to all of them
      const rs = await Promise.all(a.taskIds.map((t) => props.onAssign?.(t)));
      r = rs.find((x): x is string => typeof x === 'string' && !!x) ?? null;
    }
    else props.onSelect?.(a.buildingId);
    if (a.kind === 'select') setBusy((b) => { const n = new Set(b); n.delete(id); return n; });
    if (typeof r === 'string') { setError(r); setBusy((b) => { const n = new Set(b); n.delete(id); return n; }); }
  };
  return (
    <div className="phone-body ai">
      <div className="ai-head">
        <p className="ai-kicker"><span className="ai-spark" aria-hidden="true" />Lantern AI · {sim.phase === 'prep' ? 'before the fire' : sim.phase === 'fire' ? 'live' : 'debrief'}</p>
        {/* updated in place (no remount, no fade): the headline is never blank between two updates */}
        <h3 className="ai-headline">{advice.headline}</h3>
        <p className="ai-detail">{advice.detail}</p>
        {advice.stats.length > 0 && (
          <dl className="ai-stats">
            {advice.stats.map((x) => <div key={x.label}><dd className={x.tone ?? ''}>{x.value}</dd><dt>{x.label}</dt></div>)}
          </dl>
        )}
      </div>
      {advice.note && (
        <blockquote className="ai-note">
          <span className="ai-note-by">{props.workerOnline ? `Lantern AI on ${advice.note.building}` : `Why ${advice.note.building} is at risk`}</span>
          {advice.note.text}
        </blockquote>
      )}
      {error && <p className="phone-error" role="alert">{error}</p>}
      <ol className="ai-list" aria-live="polite">
        {advice.items.map((it, i) => (
          // stable keys: a card that stays keeps its element and only its text changes
          <li key={it.id} ref={enter(it.id)} className={`ai-card ${it.tone}`}>
            <span className="ai-step" aria-hidden="true">{it.tone === 'good' ? '✓' : it.tone === 'info' ? '•' : i + 1}</span>
            <div className="ai-body">
              <b className="ai-title">{it.title}</b>
              <span className="ai-why">{it.why}</span>
              {it.quote && <q className="ai-quote">{it.quote}</q>}
              {(it.people || it.usd || it.action) && (
                <span className="ai-row">
                  <Impact it={it} />
                  {it.action && (
                    <button type="button" className={`btn small ${it.tone === 'now' && it.action.kind !== 'select' ? 'urgent' : 'go'}`} disabled={busy.has(it.id)} onClick={() => void act(it.action!, it.id)}>
                      {busy.has(it.id) && it.action.kind !== 'select' ? 'Sent…' : it.action.label}
                    </button>
                  )}
                </span>
              )}
            </div>
          </li>
        ))}
      </ol>
      {advice.plan && props.onRecommend && (
        <button type="button" className="btn primary wide ai-plan" disabled={busy.has('plan')} onClick={() => void act({ kind: 'plan', label: '' }, 'plan')}>
          Approve all {advice.plan.count} · {fmtUsd(advice.plan.cost)}
        </button>
      )}
      {sim.phase === 'ended' && <p className="ai-tag">Like a good neighbor, Lantern was there, before the fire.</p>}
      <p className="ai-foot">Risk from a model trained on 132,522 CAL FIRE damage inspections · fire calibrated to the 2025 Eaton Fire{props.workerOnline ? ' · notes and replies read by the AI worker' : ''}</p>
    </div>
  );
}

type Role = 'advisor' | 'resident' | 'staff';

export function Phone(props: PhoneProps & { framed?: boolean; onClose?: () => void }) {
  const hasAdvisor = !!props.fixesFor;
  const [role, setRole] = useState<Role>(props.initialRole ?? (hasAdvisor ? 'advisor' : 'resident'));
  const openTasks = props.tasks.filter((t) => !t.done && !t.claimedBy).length;
  const tabs: { id: Role; label: string; count?: number }[] = [
    ...(hasAdvisor ? [{ id: 'advisor' as const, label: 'AI coach' }] : []),
    { id: 'resident', label: 'Resident' },
    { id: 'staff', label: 'Staff', count: openTasks || undefined },
  ];
  const inner = (
    <>
      <div className="phone-status"><span>{props.sim.phase === 'prep' ? '9:41' : fmtClock(props.sim.simMinutes + 9 * 60 + 41)}</span>{props.onClose && <button type="button" className="phone-close" aria-label="Hide phone" onClick={props.onClose}>×</button>}</div>
      <div className="phone-app">
        <div className="phone-title">
          <span>Lantern</span>
          <span className="sf-badge" title="Built for the State Farm challenge"><img src="/brand/state-farm.svg" alt="State Farm" /></span>
        </div>
        <div className="tabs phone-tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={role === t.id} className={role === t.id ? 'on' : ''} onClick={() => setRole(t.id)}>
              {t.label}{t.count ? <span className="tab-count">{t.count}</span> : null}
            </button>
          ))}
        </div>
        <div className="phone-view" key={role}>
          {role === 'advisor' ? <AdvisorView {...props} /> : role === 'resident' ? <ResidentView {...props} /> : <StaffView {...props} />}
        </div>
      </div>
    </>
  );
  return props.framed ? <div className="phone-frame map-chrome" aria-label="Phone">{inner}</div> : <div className="phone-plain">{inner}</div>;
}
