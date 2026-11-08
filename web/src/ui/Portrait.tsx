// Illustrated profile pictures for the simulated residents and staff: deterministic from an id, so a person
// always looks the same on every screen. Fictional people, so drawn portraits rather than photos.
import { memo } from 'react';

const SKIN = ['#F6D3B8', '#EBC09C', '#D7A27A', '#B57B54', '#8D5A3B', '#5F3C28'];
const HAIR = ['#1F1A17', '#3B2A20', '#6A4528', '#A8743F', '#D9B26A', '#7A2E1E'];
const GREY = ['#C9C6C2', '#E4E1DC', '#A9A49E'];
const SHIRT = ['#3E6FB0', '#3E8E7E', '#9A4F7A', '#B0743E', '#5D5FA8', '#4C7A3A', '#8E3E3E', '#2E6B8A'];
const BG = ['#26324A', '#2C2A44', '#203A3A', '#3A2E2A', '#2A3550', '#33293F'];

function rng(seed: number) {
  let a = (seed * 2654435761) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** a stable number from a name (staff have names, not ids) */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export type PortraitTone = 'ok' | 'warn' | 'bad' | 'idle';
const RING: Record<PortraitTone, string> = { ok: '#3DD68C', warn: '#F2A93B', bad: '#FF5A4E', idle: 'rgba(255,255,255,0.10)' };

export const Portrait = memo(function Portrait({ seed, size = 34, older = false, tone = 'idle', title }: { seed: number; size?: number; older?: boolean; tone?: PortraitTone; title?: string }) {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const skin = pick(SKIN);
  const grey = older ? r() < 0.75 : r() < 0.05;
  const hair = grey ? pick(GREY) : pick(HAIR);
  const shirt = pick(SHIRT);
  const bg = pick(BG);
  const style = Math.floor(r() * 5); // 0 short, 1 long, 2 bun, 3 curly, 4 bald/very short
  const glasses = r() < (older ? 0.45 : 0.18);
  const beard = style !== 1 && style !== 2 && r() < 0.18;
  const id = `pc${seed}`;
  return (
    <svg className={`portrait ${tone}`} width={size} height={size} viewBox="0 0 40 40" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <defs><clipPath id={id}><circle cx="20" cy="20" r="18" /></clipPath></defs>
      <circle cx="20" cy="20" r="19.2" fill="none" stroke={RING[tone]} strokeWidth="1.6" />
      <g clipPath={`url(#${id})`}>
        <rect width="40" height="40" fill={bg} />
        {style === 1 && <path d="M9 22 Q8 34 13 40 L27 40 Q32 34 31 22 Z" fill={hair} />}
        <path d="M6 40 Q7 29 20 29 Q33 29 34 40 Z" fill={shirt} />
        <rect x="17" y="24" width="6" height="6" rx="2" fill={skin} />
        <ellipse cx="20" cy="18" rx="7.4" ry="8.4" fill={skin} />
        {style === 0 && <path d="M12.4 17 Q12 9 20 9 Q28 9 27.6 17 Q25 12.5 20 12.6 Q15 12.5 12.4 17 Z" fill={hair} />}
        {style === 1 && <path d="M12 19 Q11 8.5 20 8.5 Q29 8.5 28 19 Q27 13 20 12.6 Q13 13 12 19 Z" fill={hair} />}
        {style === 2 && <><circle cx="20" cy="7.6" r="3.6" fill={hair} /><path d="M12.6 16 Q12.6 9.6 20 9.6 Q27.4 9.6 27.4 16 Q24.6 12.4 20 12.4 Q15.4 12.4 12.6 16 Z" fill={hair} /></>}
        {style === 3 && <path d="M11.6 18 Q10 12 13.6 10 Q15 7 19 8 Q22 6.6 25 8.4 Q29 9.4 28.6 14 Q29.4 16 28.4 18 Q27 13.6 20 13.4 Q13 13.6 11.6 18 Z" fill={hair} />}
        {style === 4 && <path d="M13 14 Q14 9.6 20 9.6 Q26 9.6 27 14 Q24 11.8 20 11.8 Q16 11.8 13 14 Z" fill={hair} opacity="0.8" />}
        {beard && <path d="M13.6 20 Q14 26.8 20 27 Q26 26.8 26.4 20 Q24 23.4 20 23.4 Q16 23.4 13.6 20 Z" fill={hair} opacity="0.92" />}
        <circle cx="17.2" cy="18.4" r="0.95" fill="#1B1714" />
        <circle cx="22.8" cy="18.4" r="0.95" fill="#1B1714" />
        <path d="M18 22.2 Q20 23.4 22 22.2" stroke="#7A4A3A" strokeWidth="0.9" fill="none" strokeLinecap="round" />
        {glasses && <g stroke="#1B1714" strokeWidth="0.8" fill="none" opacity="0.85"><circle cx="17.2" cy="18.4" r="2.2" /><circle cx="22.8" cy="18.4" r="2.2" /><path d="M19.4 18.4 h1.2" /></g>}
      </g>
    </svg>
  );
});
