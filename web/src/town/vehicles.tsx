// Vehicles and people on the streets.
// Vehicles are Blender renders (blender/build_vehicles.py), one per heading, so a car always faces the
// way it drives; on a route with turns, each leg shows the sprite for that direction.
// People are small vector figures with real proportions, varied skin, hair and clothes.
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { project } from './iso';
import { VEH_BOX, headingOf, vehUrl, type Heading, type VehModel } from './vehicleData';

export function VehicleSprite({ model, hd, look, x = 0, y = 0 }: { model: VehModel; hd: Heading; look: string; x?: number; y?: number }) {
  return <image href={vehUrl(model, hd, look)} x={x - VEH_BOX.ax} y={y - VEH_BOX.ay} width={VEH_BOX.w} height={VEH_BOX.h} />;
}

interface RouteVehicleProps {
  route: [number, number][];
  model: VehModel;
  look: string;
  dur: number;
  /** loop forever starting at this offset, or play once from mount */
  begin?: number;
  once?: boolean;
  /** fade out at the end of a one-shot drive (cars leaving the map) */
  fade?: boolean;
  /** extra drawing per leg (light bars, beacons), given that leg's heading */
  overlay?: (hd: Heading) => ReactNode;
}

/** A vehicle driving a polyline in map space, facing the right way on every leg. */
export function RouteVehicle({ route, model, look, dur, begin = 0, once = false, fade = false, overlay }: RouteVehicleProps) {
  const ref = useRef<SVGGElement>(null);
  useEffect(() => {
    if (!once) return;
    ref.current?.querySelectorAll('animate, animateMotion').forEach((a) => {
      try { (a as SVGAnimationElement).beginElement(); } catch { /* SMIL unavailable */ }
    });
  }, [once]);

  const pts = route.map(([x, y]) => project(x, y));
  const legs: { hd: Heading; len: number }[] = [];
  for (let i = 1; i < route.length; i++) {
    const len = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (len > 0.5) legs.push({ hd: headingOf(route[i - 1], route[i]), len });
  }
  if (!legs.length) return null;
  const total = legs.reduce((s, l) => s + l.len, 0);
  const d = 'M' + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L');
  const b = once ? 'indefinite' : `${-begin}s`;
  const timing = { dur: `${dur}s`, begin: b, ...(once ? { fill: 'freeze' as const } : { repeatCount: 'indefinite' }) };
  let acc = 0;
  return (
    <g ref={ref} opacity={once ? 0 : undefined}>
      <animateMotion path={d} {...timing} />
      {once && <animate attributeName="opacity" values={fade ? '1;1;0' : '1;1'} keyTimes={fade ? '0;0.88;1' : '0;1'} {...timing} />}
      {legs.map((leg, i) => {
        const t0 = acc / total;
        acc += leg.len;
        const t1 = acc / total;
        const body = (
          <>
            <VehicleSprite model={model} hd={leg.hd} look={look} />
            {overlay?.(leg.hd)}
          </>
        );
        if (legs.length === 1) return <g key={i}>{body}</g>;
        // only this leg's sprite is visible while the vehicle is on this leg
        const values = t0 <= 0 ? '1;0' : t1 >= 1 ? '0;1' : '0;1;0';
        const keyTimes = t0 <= 0 ? `0;${t1.toFixed(4)}` : t1 >= 1 ? `0;${t0.toFixed(4)}` : `0;${t0.toFixed(4)};${t1.toFixed(4)}`;
        return (
          <g key={i} opacity={i === 0 ? 1 : 0}>
            <animate attributeName="opacity" calcMode="discrete" values={values} keyTimes={keyTimes} {...timing} />
            {body}
          </g>
        );
      })}
    </g>
  );
}

// ------------------------------------------------------------------ people
function Limb({ x, y0, y1, w, stroke, swing, dur, phase, foot }: { x: number; y0: number; y1: number; w: number; stroke: string; swing: number; dur: number; phase: 0 | 1; foot?: string }) {
  const a = phase ? swing : -swing;
  return (
    <g>
      <animateTransform attributeName="transform" type="rotate" values={`${a} ${x} ${y0};${-a} ${x} ${y0};${a} ${x} ${y0}`} dur={`${dur}s`} repeatCount="indefinite" />
      <line x1={x} y1={y0} x2={x} y2={y1} stroke={stroke} strokeWidth={w} strokeLinecap="round" />
      {foot && <ellipse cx={x + 0.25} cy={y1 + 0.1} rx="0.75" ry="0.4" fill={foot} />}
    </g>
  );
}

function Figure({ stride, dur, lean }: { stride: number; dur: number; lean: number }) {
  return (
    <>
      <ellipse cx="0.8" cy="0.1" rx="2.3" ry="0.75" fill="#000" opacity="0.32" />
      <g transform={`rotate(${lean} 0 0)`}>
        {/* far arm and leg, then body, then near arm and leg */}
        <Limb x={-0.15} y0={-7.4} y1={-4.5} w={0.85} stroke="currentColor" swing={stride * 0.8} dur={dur} phase={0} />
        <Limb x={-0.35} y0={-4.5} y1={-0.4} w={1.15} stroke="var(--pants)" swing={stride} dur={dur} phase={1} foot="#1B1B1D" />
        <Limb x={0.35} y0={-4.5} y1={-0.4} w={1.15} stroke="var(--pants)" swing={stride} dur={dur} phase={0} foot="#1B1B1D" />
        <path d="M-1.35 -7.9 Q0 -8.5 1.35 -7.9 L1.05 -4.3 Q0 -3.9 -1.05 -4.3 Z" fill="currentColor" />
        <path d="M0.2 -8.2 Q1 -8.1 1.35 -7.9 L1.05 -4.3 Q0.6 -4.1 0.2 -4.05 Z" fill="#000" opacity="0.16" />
        <rect x="-0.4" y="-8.9" width="0.8" height="0.9" fill="var(--skin)" />
        <Limb x={0.25} y0={-7.4} y1={-4.5} w={0.85} stroke="currentColor" swing={stride * 0.8} dur={dur} phase={1} />
        <circle cx="0" cy="-9.9" r="1.2" fill="var(--skin)" />
        <path d="M-1.25 -9.8 Q-1.3 -11.4 0 -11.3 Q1.3 -11.3 1.22 -10 Q0.5 -10.6 -0.2 -10.3 Q-0.8 -10.2 -1.25 -9.8 Z" fill="var(--hair)" />
      </g>
    </>
  );
}

/** <defs> for the people: #ped (walking), #pedRun (running), #pedChair (wheelchair pushed by a carer). */
export function PeopleDefs() {
  return (
    <defs>
      <g id="ped"><Figure stride={20} dur={0.62} lean={0} /></g>
      <g id="pedRun"><Figure stride={38} dur={0.32} lean={-10} /></g>
      <g id="pedChair">
        <ellipse cx="0.5" cy="0.1" rx="4" ry="0.9" fill="#000" opacity="0.3" />
        {/* the carer behind, then the chair and its rider */}
        <g transform="translate(-3.2 0)" style={{ color: '#3DD68C', '--pants': '#24324A', '--skin': '#C68B5E', '--hair': '#1A1716' } as CSSProperties}>
          <Figure stride={16} dur={0.7} lean={-6} />
        </g>
        <circle cx="0.6" cy="-1.9" r="1.9" fill="none" stroke="#2A2C31" strokeWidth="0.55" />
        <circle cx="2.9" cy="-0.6" r="0.6" fill="#2A2C31" />
        <path d="M-0.9 -6.5 L-0.4 -3.3 L2.4 -3.3 L2.9 -1" stroke="#9AA0A8" strokeWidth="0.5" fill="none" />
        <path d="M0.2 -3.4 L2.4 -3.4 L2.6 -1.6" stroke="var(--pants)" strokeWidth="1.1" strokeLinecap="round" fill="none" />
        <path d="M-0.9 -7.3 Q0.2 -7.8 1.1 -7.3 L0.9 -3.6 L-0.6 -3.6 Z" fill="currentColor" />
        <circle cx="0.15" cy="-8.6" r="1.1" fill="var(--skin)" />
        <path d="M-1 -8.6 Q-1 -9.9 0.15 -9.8 Q1.25 -9.8 1.15 -8.7 Q0.4 -9.2 -1 -8.6 Z" fill="var(--hair)" />
      </g>
    </defs>
  );
}
