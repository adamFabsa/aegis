// "Who am I on this phone?" — a contact card with a searchable switcher (replaces the plain <select>).
// Used by the phone's Resident and Staff tabs.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Portrait } from './Portrait';

export type PickTone = 'ok' | 'warn' | 'bad' | 'idle';
export interface PickItem {
  id: string;
  name: string;
  /** one line under the name: "Building 12 · floor 3 · wheelchair" */
  sub: string;
  /** list section (building) */
  group: string;
  tone?: PickTone;
  /** short status pill: "No reply", "Safe", "2 tasks" */
  tag?: string;
  /** portrait seed (person id); without one, initials */
  seed?: number;
  older?: boolean;
  /** shown without searching (needs attention); everyone else is one search away */
  attention?: boolean;
}

/** Without a search, at most this many people per building. */
const PER_GROUP = 3;

function initials(name = '') {
  const parts = name.replace(/\./g, '').trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

function Avatar({ item, name, tone = 'idle', small = false }: { item?: PickItem; name?: string; tone?: PickTone; small?: boolean }) {
  if (item?.seed !== undefined) return <Portrait seed={item.seed} older={item.older} tone={tone} size={small ? 30 : 38} />;
  return <span className={`pick-av ${tone} ${small ? 'sm' : ''}`} aria-hidden="true">{initials(name)}</span>;
}

export function PersonPicker({ items, value, onChange, label, placeholder }: {
  items: PickItem[];
  value: string;
  onChange: (id: string) => void;
  /** what is being picked, for screen readers: "resident" / "staff member" */
  label: string;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const cur = items.find((i) => i.id === value);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', esc); };
  }, [open]);

  // Without a search: only people who need attention (and whoever is selected), a few per building.
  const { groups, hidden } = useMemo(() => {
    const s = q.trim().toLowerCase();
    const hits = s
      ? items.filter((i) => `${i.name} ${i.sub} ${i.group} ${i.tag ?? ''}`.toLowerCase().includes(s))
      : items.filter((i) => i.attention || i.id === value);
    const out = new Map<string, PickItem[]>();
    // the current person's building first: that is where the presenter is working
    const mine = items.find((i) => i.id === value)?.group;
    if (mine && hits.some((i) => i.group === mine)) out.set(mine, []);
    for (const i of hits) out.set(i.group, [...(out.get(i.group) ?? []), i]);
    const more = new Map<string, number>();
    if (!s) {
      for (const [g, list] of out) {
        if (list.length > PER_GROUP) {
          const keep = list.filter((i) => i.id === value).concat(list.filter((i) => i.id !== value)).slice(0, PER_GROUP);
          more.set(g, list.length - keep.length);
          out.set(g, list.filter((i) => keep.includes(i)));
        }
      }
    }
    return { groups: [...out.entries()].map(([g, list]) => ({ g, list, more: more.get(g) ?? 0 })), hidden: s ? 0 : items.length - hits.length };
  }, [items, q, value]);
  const first = groups[0]?.list[0];
  const choose = (id: string) => { onChange(id); setOpen(false); setQ(''); };

  return (
    <div className={`pick ${open ? 'open' : ''}`} ref={root}>
      <button type="button" className="pick-card" aria-haspopup="listbox" aria-expanded={open} aria-label={`Switch ${label}: ${cur?.name ?? 'none'}`} onClick={() => setOpen((o) => !o)}>
        <Avatar item={cur} name={cur?.name} tone={cur?.tone} />
        <span className="pick-text">
          <span className="pick-line"><b>{cur?.name ?? `Choose a ${label}`}</b>{cur?.tag && <span className={`pick-tag ${cur.tone ?? 'idle'}`}>{cur.tag}</span>}</span>
          {cur && <small>{cur.sub.startsWith(cur.group) ? cur.sub : `${cur.group} · ${cur.sub}`}</small>}
        </span>
        <svg className="pick-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="pick-pop">
          <label className="pick-search">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input ref={input} value={q} placeholder={placeholder} aria-label={placeholder}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && first) { e.preventDefault(); choose(first.id); } }} />
            {q && <button type="button" className="pick-clear" aria-label="Clear search" onClick={() => { setQ(''); input.current?.focus(); }}>×</button>}
          </label>
          <div className="pick-list" role="listbox" aria-label={label}>
            {groups.length ? groups.map(({ g, list, more }) => (
              <div key={g} className="pick-group">
                <p className="pick-g">{g}</p>
                {list.map((i) => (
                  <button type="button" role="option" aria-selected={i.id === value} key={i.id} className={`pick-row ${i.id === value ? 'on' : ''}`} onClick={() => choose(i.id)}>
                    <Avatar item={i} name={i.name} tone={i.tone} small />
                    <span className="pick-text"><b>{i.name}</b><small>{i.sub}</small></span>
                    {i.tag && <span className={`pick-tag ${i.tone ?? 'idle'}`}>{i.tag}</span>}
                  </button>
                ))}
                {more > 0 && <button type="button" className="pick-more" onClick={() => { setQ(g); input.current?.focus(); }}>+{more} more in {g}</button>}
              </div>
            )) : <p className="pick-none">{q ? `No one matches “${q}”` : 'No one needs attention right now.'}</p>}
          </div>
          {hidden > 0 && <p className="pick-foot">Showing who needs attention. Search to find any of the other {hidden}.</p>}
        </div>
      )}
    </div>
  );
}
