import type { BuildingKind } from '../town/types';

export function fmtMin(m: number): string {
  if (m < 0 || !Number.isFinite(m)) return 'No path';
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return h ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
}

export function fmtClock(min: number): string {
  const h = Math.floor(min / 60);
  return `${h}:${String(min % 60).padStart(2, '0')}`;
}

export function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `$${Math.round(n / 1000)}K`;
  return `$${n}`;
}

export const KIND_LABEL: Record<BuildingKind, string> = {
  senior: 'Senior living',
  apartments: 'Apartments',
  office: 'Office',
  homes: 'Homes',
  shelter: 'Evacuation shelter',
};
