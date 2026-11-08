/**
 * Insurer-ready mitigation checklist (pure; no SpacetimeDB imports).
 *
 * The structure measures follow California's "Safer from Wildfires" regulation (10 CCR § 2644.9, effective
 * Oct 2022): admitted insurers that price by wildfire risk must offer premium discounts for documented
 * mitigation (the Insurance Commissioner has cited 4% to 40%+). Status comes from each building's recorded
 * construction features (CAL FIRE DINS vocabulary, in seed/buildings.json) and from the fixes the manager
 * approves in prep. "Unverified" = not recorded in the data; an inspector would have to document it.
 */
import type { SeedBuilding } from './sim';

export type MeasureStatus = 'met' | 'missing' | 'unverified';

export interface MitigationRow {
  id: number; // buildingId * 10 + index
  buildingId: number;
  measure: string;
  status: MeasureStatus;
  /** fix that completes this measure (0 = none offered) */
  fixId: number;
  /** why: the recorded feature, or the approved fix */
  note: string;
}

export const MEASURES = [
  { key: 'roof', label: 'Class A fire-rated roof' },
  { key: 'vents', label: 'Ember- and flame-resistant vents' },
  { key: 'eaves', label: 'Enclosed eaves' },
  { key: 'windows', label: 'Multi-pane windows' },
  { key: 'wallBase', label: '6-inch non-combustible base of exterior walls' },
  { key: 'zone0', label: '5-ft ember-resistant zone and defensible space' },
] as const;
export type MeasureKey = (typeof MEASURES)[number]['key'];

/** Which measure each prep fix completes (fix names come from data/neighborhood.json). */
const FIX_MEASURE: Record<string, MeasureKey> = {
  'Class A roof': 'roof',
  'Ember-resistant vent screens': 'vents',
  'Clear brush to 30 ft': 'zone0',
};
export function measureForFix(fixName: string): MeasureKey | undefined {
  return FIX_MEASURE[fixName];
}

function featureStatus(key: MeasureKey, f: Record<string, unknown>): { status: MeasureStatus; note: string } {
  const s = (k: string) => String(f[k] ?? '');
  switch (key) {
    case 'roof': {
      const r = s('roof');
      if (/tile|concrete|metal|fire resistant/i.test(r)) return { status: 'met', note: `${r} roof` };
      if (/asphalt/i.test(r)) return { status: 'unverified', note: 'Asphalt roof: fire rating not recorded' };
      return { status: 'missing', note: r ? `${r} roof` : 'Roof not recorded' };
    }
    case 'vents': {
      const v = s('vents');
      if (/<=\s*1\/8|no vents/i.test(v)) return { status: 'met', note: v === 'No Vents' ? 'No vents' : 'Fine (≤1/8") mesh vents' };
      return { status: 'missing', note: v ? `Vents: ${v}` : 'Vents not recorded' };
    }
    case 'eaves': {
      const e = s('eaves');
      if (/^enclosed|no eaves/i.test(e)) return { status: 'met', note: `${e}` };
      return { status: 'missing', note: e ? `${e} eaves` : 'Eaves not recorded' };
    }
    case 'windows': {
      const w = s('windows');
      if (/multi|no windows/i.test(w)) return { status: 'met', note: w };
      return { status: 'missing', note: w ? w : 'Windows not recorded' };
    }
    case 'wallBase':
      return { status: 'unverified', note: 'Not recorded in inspection data' };
    case 'zone0': {
      const combustible = ['fence', 'deckGrade', 'deckElevated', 'patio'].filter((k) => /combustible|wood|composite/i.test(s(k)) && !/non/i.test(s(k)));
      if (combustible.length) return { status: 'missing', note: `Combustibles attached: ${combustible.map((k) => ({ fence: 'fence', deckGrade: 'deck', deckElevated: 'balcony', patio: 'patio cover' })[k]).join(', ')}` };
      return { status: 'unverified', note: 'Vegetation clearance not recorded' };
    }
  }
}

/** The checklist for one building at seed time (shelters excluded). */
export function mitigationRows(b: SeedBuilding): MitigationRow[] {
  if (b.kind === 'shelter') return [];
  const features = (b.features ?? {}) as Record<string, unknown>;
  return MEASURES.map((m, i) => {
    const fix = b.fixes.find((x) => FIX_MEASURE[x.name] === m.key);
    const { status, note } = featureStatus(m.key, features);
    return { id: b.id * 10 + i, buildingId: b.id, measure: m.label, status, fixId: fix && status !== 'met' ? fix.id : 0, note };
  });
}

/** After a fix is approved: the measure it completes becomes documented. Returns the changed row, if any. */
export function applyFixToChecklist(rows: MitigationRow[], fix: { id: number; name: string; buildingId: number }): MitigationRow | undefined {
  const key = measureForFix(fix.name);
  if (!key) return undefined;
  const label = MEASURES.find((m) => m.key === key)!.label;
  const row = rows.find((r) => r.buildingId === fix.buildingId && r.measure === label);
  if (!row || row.status === 'met') return undefined;
  row.status = 'met';
  row.note = `Documented: ${fix.name} approved`;
  return row;
}

/** Where each number on a building card comes from (shown to the property manager / judges). */
export const DATA_SOURCES =
  'Risk: model trained on 35,062 CAL FIRE damage inspections · Fire: calibrated to NASA FIRMS + Burbank wind (2025 Eaton Fire) · ' +
  'Construction: county/inspection record fields · Occupancy, staffing, values: simulated rent roll';
