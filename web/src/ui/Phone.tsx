// The phone panel from the spec: a resident checking in, and staff claiming help tasks.
// Drawn inside a phone frame on wide screens, as a tab on phones, and full screen at ?view=phone.
import { useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import type { Building, Person, Sim, Task } from '../town/types';
import { staffOf } from '../town/mockWorld';
import { fmtClock } from './format';

export interface PhoneProps {
  sim: Sim;
  buildings: Building[];
  persons: Person[];
  tasks: Task[];
  onReply: (personId: number, choice: 'safe' | 'cant_move' | 'text', text?: string) => void;
  onClaim: (taskId: number, staff: string) => string | null;
  onDone: (taskId: number) => void;
  initialRole?: 'resident' | 'staff';
  initialPerson?: number;
  initialStaff?: string;
}

function Bubble({ from, children }: { from: 'lantern' | 'me'; children: React.ReactNode }) {
  return <p className={`bubble ${from}`}>{children}</p>;
}

function ResidentView({ sim, buildings, persons, tasks, onReply, initialPerson }: PhoneProps) {
  const [pid, setPid] = useState(() => initialPerson ?? persons.find((p) => p.name === 'Maria R.')?.id ?? persons[0]?.id ?? 0);
  const [text, setText] = useState('');
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
      <label className="phone-pick">
        <span>Resident</span>
        <select value={pid} onChange={(e) => setPid(Number(e.target.value))}>
          {groups.map(({ b: g, list }) => (
            <optgroup key={g.id} label={g.name}>
              {list.map((x) => <option key={x.id} value={x.id}>{x.name}{x.needsHelp ? ` (${x.note})` : ''}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
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
        {p.status === 'claimed' && task?.claimedBy && <Bubble from="lantern">Help is on the way: {task.claimedBy} is coming to floor {p.floor}.</Bubble>}
        {p.status === 'out' && <Bubble from="lantern">You are out and checked in. Shelter A has water, beds and medical staff.</Bubble>}
        {p.status === 'left_behind' && <Bubble from="lantern">We lost contact with you. Firefighters have your floor and room.</Bubble>}
      </div>
      {canAnswer && p.status === 'pinged' && (
        <div className="phone-actions">
          <div className="phone-btns">
            <button type="button" className="btn primary" onClick={() => onReply(p.id, 'safe')}>I'm safe</button>
            <button type="button" className="btn fire" onClick={() => onReply(p.id, 'cant_move')}>I can't get out</button>
          </div>
          <form className="phone-text" onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onReply(p.id, 'text', text.trim()); setText(''); } }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Or type a message" aria-label="Message to Lantern" />
            <button type="submit" className="btn small" disabled={!text.trim()}>Send</button>
          </form>
        </div>
      )}
    </div>
  );
}

function StaffView({ buildings, persons, tasks, onClaim, onDone, initialStaff }: PhoneProps) {
  const crew = useMemo(() => buildings.filter((b) => b.staff > 0 && b.kind !== 'shelter').map((b) => ({ b, names: staffOf(b) })), [buildings]);
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
          {t.claimedBy && t.claimedBy !== me && <small className="claimed">Claimed by {t.claimedBy}</small>}
        </span>
        {t.claimedBy === me ? (
          <button type="button" className="btn small" onClick={() => onDone(t.id)}>Done</button>
        ) : !t.claimedBy ? (
          <button type="button" className="btn small urgent" onClick={() => setError(onClaim(t.id, me))}>Claim</button>
        ) : null}
      </li>
    );
  };
  return (
    <div className="phone-body">
      <label className="phone-pick">
        <span>Staff member</span>
        <select value={me} onChange={(e) => { setMe(e.target.value); setError(null); }}>
          {crew.map(({ b, names }) => (
            <optgroup key={b.id} label={b.name}>{names.map((n) => <option key={`${b.id}${n}`} value={n}>{n}</option>)}</optgroup>
          ))}
        </select>
      </label>
      {error && <p className="phone-error" role="alert">{error}</p>}
      {mine.length > 0 && <><h4 className="phone-h">Your tasks</h4><ul className="tasks">{mine.map(row)}</ul></>}
      <h4 className="phone-h">Open tasks · most urgent first</h4>
      {rest.length ? <ul className="tasks">{rest.map(row)}</ul> : <p className="phone-empty">No one is waiting for help right now.</p>}
    </div>
  );
}

/** QR for opening this page as a phone; only where the address is one people can open (not inside a preview frame). */
function phoneUrl(): string | null {
  try {
    if (window.top !== window.self || /localhost|127\.0\.0\.1/.test(window.location.hostname)) return null;
  } catch { return null; }
  const u = new URL(window.location.href);
  u.search = '?view=phone';
  return u.toString();
}

function qrSvg(url: string): string {
  const q = qrcode(0, 'M');
  q.addData(url);
  q.make();
  return q.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
}

function Qr() {
  const [svg] = useState(() => { const url = phoneUrl(); return url ? qrSvg(url) : null; });
  if (!svg) return null;
  return (
    <div className="qr">
      <span className="qr-code" dangerouslySetInnerHTML={{ __html: svg }} />
      <span>Scan to check in from your own phone</span>
    </div>
  );
}

export function Phone(props: PhoneProps & { framed?: boolean; onClose?: () => void }) {
  const [role, setRole] = useState<'resident' | 'staff'>(props.initialRole ?? 'resident');
  const openTasks = props.tasks.filter((t) => !t.done && !t.claimedBy).length;
  const inner = (
    <>
      <div className="phone-status"><span>{props.sim.phase === 'prep' ? '9:41' : fmtClock(props.sim.simMinutes + 9 * 60 + 41)}</span>{props.onClose && <button type="button" className="phone-close" aria-label="Hide phone" onClick={props.onClose}>×</button>}</div>
      <div className="phone-app">
        <div className="phone-title">Lantern</div>
        <div className="tabs phone-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={role === 'resident'} className={role === 'resident' ? 'on' : ''} onClick={() => setRole('resident')}>Resident</button>
          <button type="button" role="tab" aria-selected={role === 'staff'} className={role === 'staff' ? 'on' : ''} onClick={() => setRole('staff')}>
            Staff{openTasks > 0 && <span className="tab-count">{openTasks}</span>}
          </button>
        </div>
        {role === 'resident' ? <ResidentView {...props} /> : <StaffView {...props} />}
        {props.framed && <Qr />}
      </div>
    </>
  );
  return props.framed ? <div className="phone-frame map-chrome" aria-label="Phone">{inner}</div> : <div className="phone-plain">{inner}</div>;
}
