// Particle fire. Each flame is a cluster of soft glowing blobs that keep rising from the base, swaying,
// shrinking and cooling from white-yellow through orange to dark red before they vanish. Dozens of
// blobs on staggered clocks mean the flame never settles into one shape. A heat-shimmer filter
// warps the flames (and a burning building behind them) the way hot air does.
//
// Symbols: #fireA (tall), #fireB (wide), #fireC (small). Base of the flame sits at (0, 0).

interface Spec { id: string; height: number; width: number; count: number; dur: number }

const SPECS: Spec[] = [
  { id: 'fireA', height: 30, width: 8, count: 7, dur: 1.0 },
  { id: 'fireB', height: 24, width: 11, count: 7, dur: 0.9 },
  { id: 'fireC', height: 17, width: 6, count: 5, dur: 0.75 },
];

/** deterministic 0..1 */
const r = (n: number) => (((n * 9301 + 49297) % 233280) / 233280);

/** One tongue of flame as a closed path; tip position and lean change between the morph frames. */
function tongue(w: number, h: number, tip: number, lean: number): string {
  const f = (n: number) => n.toFixed(1);
  return `M${f(-w * 0.5)} 0 C ${f(-w * 1.05)} ${f(-h * 0.25)} ${f(-w * 0.55 + lean)} ${f(-h * 0.62)} ${f(tip)} ${f(-h)} `
    + `C ${f(w * 0.55 + lean)} ${f(-h * 0.62)} ${f(w * 1.05)} ${f(-h * 0.25)} ${f(w * 0.5)} 0 Z`;
}

function Flame({ id, height, width, count, dur }: Spec) {
  // two tongues that keep morphing: the flame body waves, leans and splits
  const frames = (k: number) => [
    tongue(width, height * (0.92 + k * 0.05), -width * 0.35, -width * 0.2),
    tongue(width * 0.9, height * (1.08 - k * 0.04), width * 0.4, width * 0.25),
    tongue(width * 1.05, height * (0.82 + k * 0.08), -width * 0.1, width * 0.05),
    tongue(width * 0.95, height * (1.0 + k * 0.02), width * 0.25, -width * 0.15),
  ];
  const tongues = [0, 1].map((k) => {
    const fr = frames(k);
    const values = [...fr, fr[0]].join(';');
    return (
      <path key={`t${k}`} d={fr[0]} fill={k ? 'url(#tongueHot)' : 'url(#tongue)'} transform={k ? `translate(${(width * 0.15).toFixed(1)} 0) scale(0.62)` : undefined}>
        <animate attributeName="d" values={values} dur={`${(dur * (k ? 0.7 : 1.1)).toFixed(2)}s`} repeatCount="indefinite" calcMode="spline"
          keySplines="0.45 0 0.55 1;0.45 0 0.55 1;0.45 0 0.55 1;0.45 0 0.55 1" />
      </path>
    );
  });
  // licks that tear off the tip and rise, stretched upward
  const licks = [];
  for (let i = 0; i < count; i++) {
    const a = r(i * 7 + id.length);
    const b = r(i * 13 + 3);
    const x0 = (a - 0.5) * width * 0.6;
    const sway = (b - 0.5) * width * 0.8;
    const y0 = -height * (0.45 + 0.3 * a);
    const top = -height * (1.05 + 0.5 * b);
    const d = dur * (0.7 + 0.5 * a);
    const begin = `${((-i * dur) / count).toFixed(2)}s`;
    const rx = width * (0.22 + 0.12 * b);
    licks.push(
      <ellipse key={i} cx="0" cy="0" rx={rx.toFixed(1)} ry={(rx * 2.1).toFixed(1)} fill={i % 3 === 0 ? 'url(#pHot)' : 'url(#pFlame)'}>
        <animateMotion path={`M${x0.toFixed(1)} ${y0.toFixed(1)} C ${(x0 + sway).toFixed(1)} ${((y0 + top) * 0.55).toFixed(1)} ${(x0 - sway).toFixed(1)} ${(top * 0.85).toFixed(1)} ${(x0 + sway * 0.5).toFixed(1)} ${top.toFixed(1)}`}
          dur={`${d.toFixed(2)}s`} begin={begin} repeatCount="indefinite" />
        <animate attributeName="ry" values={`${(rx * 2.1).toFixed(1)};${(rx * 1.6).toFixed(1)};${(rx * 0.4).toFixed(1)}`} dur={`${d.toFixed(2)}s`} begin={begin} repeatCount="indefinite" />
        <animate attributeName="rx" values={`${rx.toFixed(1)};${(rx * 0.7).toFixed(1)};${(rx * 0.25).toFixed(1)}`} dur={`${d.toFixed(2)}s`} begin={begin} repeatCount="indefinite" />
        <animate attributeName="opacity" values="0;0.9;0.55;0" keyTimes="0;0.15;0.6;1" dur={`${d.toFixed(2)}s`} begin={begin} repeatCount="indefinite" />
      </ellipse>,
    );
  }
  return (
    <g id={id}>
      <ellipse cx="0" cy="-2" rx={width * 1.7} ry={width * 0.7} fill="url(#pBase)">
        <animate attributeName="opacity" values="0.7;1;0.8;0.95;0.7" dur="0.9s" repeatCount="indefinite" />
      </ellipse>
      {tongues}
      {licks}
    </g>
  );
}

export function FireDefs() {
  return (
    <>
      <radialGradient id="pHot">
        <stop offset="0" stopColor="#FFFBE6" stopOpacity="1" />
        <stop offset="0.35" stopColor="#FFD86B" stopOpacity="0.95" />
        <stop offset="0.75" stopColor="#FF8A1F" stopOpacity="0.45" />
        <stop offset="1" stopColor="#FF5A12" stopOpacity="0" />
      </radialGradient>
      <radialGradient id="pFlame">
        <stop offset="0" stopColor="#FFC24A" stopOpacity="0.95" />
        <stop offset="0.45" stopColor="#FF6A14" stopOpacity="0.7" />
        <stop offset="0.8" stopColor="#B8260A" stopOpacity="0.3" />
        <stop offset="1" stopColor="#7A1405" stopOpacity="0" />
      </radialGradient>
      {/* flame body: white-hot root, orange middle, red tip fading to nothing */}
      <linearGradient id="tongue" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stopColor="#FFE9A0" stopOpacity="0.95" />
        <stop offset="0.3" stopColor="#FF9A26" stopOpacity="0.92" />
        <stop offset="0.7" stopColor="#E8420E" stopOpacity="0.6" />
        <stop offset="1" stopColor="#8A1A06" stopOpacity="0" />
      </linearGradient>
      <linearGradient id="tongueHot" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stopColor="#FFFDF0" stopOpacity="1" />
        <stop offset="0.45" stopColor="#FFD35C" stopOpacity="0.85" />
        <stop offset="1" stopColor="#FF8A1F" stopOpacity="0" />
      </linearGradient>
      <radialGradient id="pBase">
        <stop offset="0" stopColor="#FFB347" stopOpacity="0.75" />
        <stop offset="1" stopColor="#FF5A12" stopOpacity="0" />
      </radialGradient>
      {/* hot air: a slowly morphing noise field displaces whatever it is applied to */}
      <filter id="heatHaze" x="-10%" y="-20%" width="120%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency="0.018 0.07" numOctaves="2" seed="7" result="n">
          <animate attributeName="baseFrequency" values="0.018 0.07;0.022 0.085;0.018 0.07" dur="2.4s" repeatCount="indefinite" />
        </feTurbulence>
        <feDisplacementMap in="SourceGraphic" in2="n" scale="5" xChannelSelector="R" yChannelSelector="G" />
      </filter>
      <filter id="flameWarp" x="-60%" y="-60%" width="220%" height="220%">
        <feTurbulence type="fractalNoise" baseFrequency="0.05 0.13" numOctaves="2" seed="3" result="n">
          <animate attributeName="baseFrequency" values="0.05 0.13;0.06 0.17;0.05 0.13" dur="1.3s" repeatCount="indefinite" />
        </feTurbulence>
        <feDisplacementMap in="SourceGraphic" in2="n" scale="9" xChannelSelector="R" yChannelSelector="G" />
      </filter>
      {SPECS.map((s) => <Flame key={s.id} {...s} />)}
    </>
  );
}
