// Portraits on incident lines: "Carmen E. reached Shelter A with Dana" shows Carmen's and Dana's faces.
import type { Building, Person } from '../town/types';
import { Portrait } from './Portrait';
import { seedOf } from './alerts';

/** Resident names look like "Carmen E."; staff appear as "with Dana", "Dana claimed …", "sent Dana (on-site staff)". */
const RESIDENT = /\b([A-Z][a-z]+ [A-Z]\.)/g;
const STAFF = [/ with ([A-Z][a-z]+)\s*$/, /^([A-Z][a-z]+) claimed /, /sent ([A-Z][a-z]+) \(on-site staff\)/];

export function EventLine({ text, people, buildings }: { text: string; people: Map<string, Person>; buildings: Building[] }) {
  let resident: Person | undefined;
  for (const m of text.matchAll(RESIDENT)) {
    resident = people.get(m[1]);
    if (resident) break;
  }
  let staff: string | undefined;
  for (const re of STAFF) {
    const m = text.match(re);
    if (m && !people.has(m[1])) { staff = m[1]; break; }
  }
  if (!resident && !staff) return <span className="ev-text">{text}</span>;
  const senior = resident && buildings.find((b) => b.id === resident!.buildingId)?.kind === 'senior';
  const tone = resident?.status === 'out' || resident?.status === 'safe' ? 'ok' : resident?.status === 'left_behind' || resident?.status === 'cant_move' ? 'bad' : 'idle';
  return (
    <span className="ev-line">
      <span className={`ev-faces ${resident && staff ? 'two' : ''}`} aria-hidden="true">
        {resident && <Portrait seed={resident.id} size={22} older={!!senior} tone={tone} />}
        {staff && <Portrait seed={seedOf(staff)} size={resident ? 18 : 22} tone="idle" />}
      </span>
      <span className="ev-text">{text}</span>
    </span>
  );
}
