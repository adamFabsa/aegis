import type { Building, Sim } from './types';
import { STATUS_COLORS } from './palettes';

/** Text + color for a building's status tag (map tag and side card chip). */
export function statusTag(b: Building, phase: Sim['phase']): { text: string; color: string } {
  if (b.kind === 'shelter') return { text: 'Shelter', color: STATUS_COLORS.green };
  switch (b.status) {
    case 'burning': return { text: (b.damage ?? 0) >= 2 ? 'Gutted' : 'Burning', color: STATUS_COLORS.red };
    case 'lost': return { text: 'Collapsed', color: STATUS_COLORS.gray };
    case 'clear': return { text: 'Clear', color: STATUS_COLORS.green };
    case 'evacuating': return { text: `Evacuating ${b.peopleOut}/${b.residents}`, color: STATUS_COLORS.amber };
    case 'behind': return { text: 'Behind', color: STATUS_COLORS.red };
  }
  if (phase === 'prep') {
    if (b.prepared) return { text: 'Prepared', color: STATUS_COLORS.green };
    const r = Math.round(b.risk);
    return { text: `Risk ${r}`, color: r >= 70 ? STATUS_COLORS.red : r >= 40 ? STATUS_COLORS.amber : STATUS_COLORS.green };
  }
  return { text: 'OK', color: STATUS_COLORS.green };
}
