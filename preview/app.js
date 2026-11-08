// Aegis sim preview — runs the real engine (spacetimedb/src/sim.ts) in the browser, no Spacetime needed.
// Two parts: Controller (no DOM, tested in Node by preview/test_preview.ts) and the view (SVG + panels).
// `node --experimental-strip-types preview/build.ts` inlines this file + the engine into preview/index.html.
import * as S from '../spacetimedb/src/sim.ts';
import { SEED } from '../spacetimedb/src/seed_data.ts';
import NB from '../data/neighborhood.json' with { type: 'json' };

export const MAP = NB.map;
const IGNITION_LOCAL_MIN = 18 * 60 + 18; // Tue Jan 7 2025, 18:18 PST

// ───────────────────────────── Controller ─────────────────────────────

export class Controller {
  constructor(opts = {}) {
    this.seed = SEED;
    this.P = SEED.params;
    this.fireSeed = Number.isFinite(opts.fireSeed) ? opts.fireSeed : this.P.fireSeed;
    this.reset();
  }

  reset(approvedFixIds = []) {
    const w = S.buildWorldFromSeed(this.seed);
    this.world = w;
    this.fixes = w.fixes;
    this.events = [];
    this.nextTaskId = 1n;
    this.results = null;
    for (const id of approvedFixIds) this.approveFix(id, true);
    this.log(0, ['World seeded — prep phase (simulated neighbourhood, Eaton-calibrated fire)']);
  }

  log(tick, lines) {
    for (const text of lines) if (text) this.events.push({ tick, text });
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
  }

  get sim() {
    return this.world.sim;
  }

  building(id) {
    return this.world.buildings.find((b) => b.id === id);
  }

  assignIds() {
    for (const t of this.world.tasks) if (t.id === 0n) t.id = this.nextTaskId++;
  }

  approveFix(id, quiet = false) {
    const f = this.fixes.find((x) => x.id === id);
    if (!f) return 'unknown fix';
    const b = this.building(f.buildingId);
    const r = S.applyFix(this.sim, b, f, this.world.people.filter((x) => x.buildingId === b.id), this.P);
    if (r.error) return r.error;
    if (!quiet) this.log(this.sim.tick, [r.event]);
    return null;
  }

  approveRecommended() {
    const ids = S.recommendFixes(this.world, this.fixes, this.P);
    for (const id of ids) this.approveFix(id);
    return ids;
  }

  startFire() {
    if (this.sim.phase !== 'prep') return 'reset to prep first';
    const r = S.startFire(this.world, this.P, this.fireSeed);
    this.log(0, r.events);
    return null;
  }

  backToPrep() {
    this.reset(this.fixes.filter((f) => f.approved).map((f) => f.id));
  }

  setSpeed(m) {
    this.sim.minutesPerTick = Math.max(1, Math.min(10, Math.round(m)));
  }

  step() {
    if (this.sim.phase !== 'fire') return null;
    this.sim.running = true;
    const r = S.stepSimulation(this.world, this.P, this.fireSeed);
    this.assignIds();
    this.log(this.sim.tick, r.events);
    if (r.ended) this.finish();
    return r;
  }

  finish() {
    this.results = {
      with: S.computeResults(this.world, this.P, 'with_lantern'),
      without: S.runBaseline(this.seed, { fireSeed: this.fireSeed }),
    };
  }

  endAndCompare() {
    if (this.sim.phase !== 'fire') return 'no fire running';
    S.fastForward(this.world, this.P, this.fireSeed);
    this.assignIds();
    this.log(this.sim.tick, ['Fast-forwarded to the end of the fire']);
    this.finish();
    return null;
  }

  startEvacuation(id) {
    const r = S.startEvacuation(this.world, id, this.P);
    if (r.error) return r.error;
    this.log(this.sim.tick, r.events);
    return null;
  }

  reply(personId, choice) {
    const r = S.applyReply(this.world, personId, choice, this.P);
    if (r.error) return r.error;
    this.assignIds();
    this.log(this.sim.tick, r.events);
    return null;
  }

  claim(taskId, staffName) {
    const t = this.world.tasks.find((x) => x.id === taskId);
    if (!t) return 'unknown task';
    if (t.done) return 'task already done';
    if (t.claimedBy !== '') return `already claimed by ${t.claimedBy}`;
    t.claimedBy = staffName;
    const p = this.world.people.find((x) => x.id === t.personId);
    if (p && p.status !== 'out' && p.status !== 'left_behind') p.status = 'claimed';
    this.log(this.sim.tick, [`${staffName} claimed ${p ? p.name : 'a task'}`]);
    return null;
  }

  complete(taskId) {
    const t = this.world.tasks.find((x) => x.id === taskId);
    if (!t) return 'unknown task';
    if (t.done) return 'task already done';
    if (t.claimedBy === '') return 'claim it first';
    t.done = true;
    const p = this.world.people.find((x) => x.id === t.personId);
    if (p && p.status !== 'left_behind') p.status = 'out';
    this.log(this.sim.tick, [`${p ? p.name : 'Someone'} reached safety with ${t.claimedBy}`]);
    return null;
  }

  openTasks() {
    return this.world.tasks
      .filter((t) => !t.done)
      .slice()
      .sort((a, c) => c.priority - a.priority || a.createdTick - c.createdTick || a.personId - c.personId);
  }

  counters() {
    return S.counters(this.world);
  }

  clock() {
    const m = this.sim.simMinutes;
    const local = IGNITION_LOCAL_MIN + m;
    const day = ['Tue', 'Wed', 'Thu'][Math.floor(local / 1440)] ?? 'Thu';
    const hh = Math.floor((local % 1440) / 60);
    const mm = local % 60;
    return { sinceIgnition: this.sim.phase === 'prep' ? 'T−0' : `T+${S.fmtMin(m)}`, local: `${day} ${hh}:${mm < 10 ? '0' : ''}${mm}` };
  }

  /** The scripted demo from LANTERN_SPEC §8 (used by ?demo=1 and by the tests). */
  demoActions() {
    return {
      prep: () => {
        this.approveFix(121);
        this.approveFix(122);
        this.approveFix(91);
      },
      onTick: (tick) => {
        if (tick === 2) for (const id of [12, 9, 20, 7]) this.startEvacuation(id);
        if (tick === 4) this.reply(1201, 'cant_move');
        const maria = this.world.tasks.find((t) => t.personId === 1201);
        if (tick === 8 && maria && maria.claimedBy === '') this.claim(maria.id, 'Alex');
        if (tick === 14 && maria && maria.claimedBy === 'Alex' && !maria.done) this.complete(maria.id);
      },
    };
  }
}

// ───────────────────────────── View ─────────────────────────────

const NS = 'http://www.w3.org/2000/svg';
const STATUS_COLOR = { ok: '#8b95a7', behind: '#F2A93B', evacuating: '#5aa9ff', clear: '#3DD68C', burning: '#FF5A4E', lost: '#5c2a2a' };
const STATUS_LABEL = { ok: 'OK', behind: 'Behind', evacuating: 'Evacuating', clear: 'Clear', burning: 'Burning', lost: 'Lost' };

function svg(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}
function html(tag, attrs = {}, parent, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, String(v));
  }
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
const $ = (id) => document.getElementById(id);
const money = (usd) => (usd >= 1e6 ? `$${(usd / 1e6).toFixed(1)}M` : `$${Math.round(usd / 1000)}K`);
const riskBand = (raw) => {
  const r = Math.round(raw); // same rounding as the number shown and as S.isPrepared
  return r >= 70 ? ['High', '#FF5A4E'] : r >= 40 ? ['Elevated', '#F2A93B'] : ['Low', '#3DD68C'];
};

export function mountView(ctl, params) {
  const P = ctl.P;
  const state = { selected: Number(params.get('select')) || 12, playing: false, rate: Number(params.get('rate')) || 1, timer: 0, staff: S.PHONE_STAFF[0], resident: 1201, until: Number(params.get('until')) || 0, demo: params.get('demo') === '1', showResults: true };
  const demo = ctl.demoActions();
  window.__lantern = { ctl, state };

  // ── map base layer ──
  const map = $('map');
  const base = svg('g', {}, map);
  svg('rect', { x: 0, y: 0, width: 1000, height: 620, fill: '#18211c' }, base);
  svg('path', { d: MAP.hillsPath, fill: '#3b3322', stroke: '#4a4029', 'stroke-width': 2 }, base);
  for (let i = 0; i < 70; i++) {
    // dry brush tufts on the hills (deterministic positions)
    const x = 600 + ((i * 97) % 400);
    const y = 8 + ((i * 53) % 230);
    svg('circle', { cx: x, cy: y, r: 3 + (i % 3), fill: '#52472c', opacity: 0.7, class: 'tuft' }, base);
  }
  const shelter = ctl.world.buildings.find((b) => b.kind === 'shelter');
  if (shelter) svg('rect', { x: shelter.x - MAP.shelterLotPad, y: shelter.y - MAP.shelterLotPad, width: shelter.w + 2 * MAP.shelterLotPad, height: shelter.h + 2 * MAP.shelterLotPad, fill: '#20262b', rx: 6 }, base);
  for (const r of MAP.roads) {
    svg('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: '#2a303b' }, base);
    const horizontal = r.w > r.h;
    svg('line', horizontal ? { x1: r.x, y1: r.y + r.h / 2, x2: r.x + r.w, y2: r.y + r.h / 2 } : { x1: r.x + r.w / 2, y1: r.y, x2: r.x + r.w / 2, y2: r.y + r.h }, base).setAttribute('class', 'roadline');
  }
  // hide tufts that fall outside the hills polygon by clipping
  const clip = svg('clipPath', { id: 'hillsclip' }, svg('defs', {}, map));
  svg('path', { d: MAP.hillsPath }, clip);
  base.querySelectorAll('.tuft').forEach((t) => t.setAttribute('clip-path', 'url(#hillsclip)'));

  // ── fire layer ──
  const fireG = svg('g', { id: 'fire' }, map);
  const cellEls = new Array(P.cols * P.rows);
  const owner = new Set();
  for (const b of ctl.world.buildings) for (const c of S.footprintCellIds(b, P)) owner.add(c);
  for (const c of ctl.world.cells) {
    const r = svg('rect', { x: c.x * P.cellSize, y: c.y * P.cellSize, width: P.cellSize, height: P.cellSize, fill: 'none', 'data-s': '' }, fireG);
    r.style.animationDelay = `${-((c.id * 137) % 900)}ms`;
    cellEls[c.id] = r;
  }
  const smokeG = svg('g', { id: 'smoke' }, map);

  // ── routes + buildings ──
  const routeG = svg('g', { id: 'routes' }, map);
  const bG = svg('g', { id: 'buildings' }, map);
  const bEls = new Map();
  for (const b of ctl.world.buildings) {
    const g = svg('g', { class: 'bldg', 'data-id': b.id }, bG);
    const body = svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 4, class: 'body' }, g);
    if (b.kind === 'homes') {
      const n = 5;
      for (let i = 0; i < n; i++) svg('rect', { x: b.x + 4 + (i * (b.w - 8)) / n, y: b.y + 6, width: (b.w - 8) / n - 8, height: b.h - 12, rx: 3, class: 'house' }, g);
    } else if (b.kind !== 'shelter') {
      for (let wy = b.y + 10; wy < b.y + b.h - 8; wy += 14) for (let wx = b.x + 10; wx < b.x + b.w - 8; wx += 16) svg('rect', { x: wx, y: wy, width: 7, height: 6, class: 'win' }, g);
    }
    const name = svg('text', { x: b.x + b.w / 2, y: b.y - 22, class: 'bname' }, g);
    name.textContent = b.name;
    const tagBg = svg('rect', { x: b.x + b.w / 2 - 58, y: b.y - 17, width: 116, height: 15, rx: 7.5, class: 'tagbg' }, g);
    const tag = svg('text', { x: b.x + b.w / 2, y: b.y - 6, class: 'tag' }, g);
    if (b.kind === 'shelter') {
      const s = svg('text', { x: b.x + b.w / 2, y: b.y + b.h / 2 + 5, class: 'shelterlabel' }, g);
      s.textContent = 'SHELTER';
    }
    g.addEventListener('click', () => {
      state.selected = b.id;
      const ppl = ctl.world.people.filter((x) => x.buildingId === b.id);
      if (ppl.length) state.resident = (ppl.find((x) => x.needsHelp) ?? ppl[0]).id;
      render();
    });
    bEls.set(b.id, { g, body, tag, tagBg });
  }

  // ── wind chip ──
  const windG = svg('g', { id: 'wind', transform: 'translate(20,20)' }, map);
  svg('rect', { x: 0, y: 0, width: 150, height: 40, rx: 10, class: 'chip' }, windG);
  const arrow = svg('g', { transform: 'translate(22,20)' }, windG);
  svg('path', { d: 'M0,-12 L6,6 L0,2 L-6,6 Z', fill: '#F2A93B' }, arrow);
  const windText = svg('text', { x: 42, y: 25, class: 'chiptext' }, windG);

  // ── controls ──
  $('btnPhase').addEventListener('click', () => {
    if (ctl.sim.phase === 'prep') ctl.startFire();
    else {
      stop();
      ctl.backToPrep();
      state.showResults = true;
    }
    render();
  });
  $('btnPlay').addEventListener('click', () => (state.playing ? stop() : play()));
  $('btnStep').addEventListener('click', () => {
    doTick();
    render();
  });
  $('btnEnd').addEventListener('click', () => {
    stop();
    toast(ctl.endAndCompare());
    render();
  });
  const speedSel = $('speed');
  speedSel.value = String(Number(params.get('speed')) || P.defaultMinutesPerTick);
  ctl.setSpeed(Number(speedSel.value));
  speedSel.addEventListener('change', () => ctl.setSpeed(Number(speedSel.value)));
  const rateSel = $('rate');
  rateSel.value = String(state.rate);
  rateSel.addEventListener('change', () => {
    state.rate = Number(rateSel.value);
    if (state.playing) {
      stop();
      play();
    }
  });
  $('seed').value = String(ctl.fireSeed);
  $('btnSeed').addEventListener('click', () => {
    const v = Number($('seed').value);
    if (!Number.isFinite(v)) return toast('seed must be a number');
    stop();
    ctl.fireSeed = v;
    ctl.backToPrep();
    render();
  });
  $('closeResults').addEventListener('click', () => {
    state.showResults = false;
    render();
  });

  function toast(msg) {
    if (!msg) return;
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function doTick() {
    if (ctl.sim.phase !== 'fire') return;
    if (state.demo) demo.onTick(ctl.sim.tick);
    ctl.step();
    if (state.until && ctl.sim.tick >= state.until) stop();
    if (ctl.sim.phase === 'ended') stop();
  }
  function play() {
    if (ctl.sim.phase === 'prep') ctl.startFire();
    if (ctl.sim.phase !== 'fire') return;
    state.playing = true;
    state.timer = setInterval(() => {
      doTick();
      render();
    }, 1000 / state.rate);
    render();
  }
  function stop() {
    state.playing = false;
    clearInterval(state.timer);
  }

  // ── render ──
  const lastCell = new Array(P.cols * P.rows).fill('');
  function cellStyle(c) {
    if (c.state === 1) {
      const lim = owner.has(c.id) ? P.buildingBurnSteps : P.burnSteps;
      const f = c.burnTicks / lim;
      return ['flame', f < 0.2 ? '#ffd166' : f < 0.55 ? '#ff9f43' : f < 0.8 ? '#ff5a4e' : '#c0392b'];
    }
    if (c.state === 2) return ['ash', owner.has(c.id) ? '#140f0e' : '#1d1714'];
    return ['', 'none'];
  }

  function render() {
    const sim = ctl.sim;
    const phase = sim.phase;
    document.body.dataset.phase = phase;
    // fire cells
    let burning = 0;
    const smokeSrc = [];
    for (const c of ctl.world.cells) {
      const [cls, fill] = cellStyle(c);
      if (c.state === 1) {
        burning++;
        if (c.id % 7 === 0) smokeSrc.push(c);
      }
      const key = cls + fill;
      if (lastCell[c.id] !== key) {
        const e = cellEls[c.id];
        e.setAttribute('fill', fill);
        e.setAttribute('class', cls);
        lastCell[c.id] = key;
      }
    }
    // smoke plumes drift downwind
    smokeG.replaceChildren();
    const wx = Math.sin((sim.windDirDeg * Math.PI) / 180);
    const wy = -Math.cos((sim.windDirDeg * Math.PI) / 180);
    for (const c of smokeSrc.slice(0, 60)) {
      const cx = (c.x + 0.5) * P.cellSize;
      const cy = (c.y + 0.5) * P.cellSize;
      for (let k = 1; k <= 3; k++) svg('circle', { cx: cx + wx * 26 * k, cy: cy + wy * 26 * k, r: 8 + 7 * k, class: 'smoke', opacity: 0.16 / k }, smokeG);
    }
    // buildings
    routeG.replaceChildren();
    const sh = ctl.world.buildings.find((b) => b.kind === 'shelter');
    for (const b of ctl.world.buildings) {
      const el = bEls.get(b.id);
      const color = b.kind === 'shelter' && b.status === 'ok' ? '#3DD68C' : STATUS_COLOR[b.status] ?? '#8b95a7';
      el.body.setAttribute('stroke', color);
      el.g.setAttribute('class', `bldg ${b.kind} st-${b.status}${b.id === state.selected ? ' selected' : ''}`);
      let text = '';
      let tagColor = color;
      if (b.kind === 'shelter') text = phase === 'prep' ? 'Evacuation point' : `${ctl.world.people.filter((x) => x.status === 'out').length} arrived`;
      else if (phase === 'prep') {
        if (b.prepared) {
          text = 'Prepared ✓';
          tagColor = '#3DD68C';
        } else {
          const [band, bc] = riskBand(b.risk);
          text = `Risk ${Math.round(b.risk)} · ${band}`;
          tagColor = bc;
        }
      } else {
        const eta = b.fireEtaMin >= 0 && b.status !== 'burning' && b.status !== 'lost' && b.status !== 'clear' ? ` · 🔥 ${S.fmtMin(b.fireEtaMin)}` : '';
        text = `${STATUS_LABEL[b.status] ?? b.status}${eta}`;
      }
      el.tag.textContent = text;
      el.tag.setAttribute('fill', tagColor);
      el.tagBg.setAttribute('stroke', tagColor);
      if (sh && b.evacStarted && b.status !== 'lost' && b.status !== 'clear' && b.kind !== 'shelter') {
        const x1 = b.x + b.w / 2;
        const y1 = b.y + b.h;
        const x2 = sh.x + sh.w / 2;
        const y2 = sh.y;
        svg('path', { d: `M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`, class: 'route' }, routeG);
      }
    }
    // wind
    arrow.setAttribute('transform', `translate(22,20) rotate(${sim.windDirDeg})`);
    windText.textContent = `${Math.round(sim.windMph)} mph → ${S.compass(sim.windDirDeg)}`;

    // header
    const cnt = ctl.counters();
    const clock = ctl.clock();
    $('phasePill').textContent = phase === 'prep' ? 'Prep' : phase === 'fire' ? 'Fire' : 'Ended';
    $('phasePill').className = `pill ${phase}`;
    $('clock').textContent = `${clock.sinceIgnition} · ${clock.local}`;
    $('cOut').textContent = `${cnt.peopleOut}/${cnt.peopleTotal}`;
    $('cUnacc').textContent = String(cnt.unaccounted);
    $('cRisk').textContent = String(cnt.buildingsAtRisk);
    $('cBurning').textContent = String(burning);
    $('btnPhase').textContent = phase === 'prep' ? 'Start fire' : 'Back to prep';
    $('btnPlay').textContent = state.playing ? 'Pause' : 'Play';
    $('btnPlay').disabled = phase === 'ended';
    $('btnStep').disabled = phase !== 'fire';
    $('btnEnd').disabled = phase !== 'fire';
    $('budget').textContent = money(sim.budgetLeft);

    renderCard();
    renderPhone();
    renderFeed();
    renderResults();
  }

  function renderCard() {
    const b = ctl.building(state.selected) ?? ctl.world.buildings[0];
    const card = $('card');
    card.replaceChildren();
    const head = html('div', { class: 'cardhead' }, card);
    html('div', { class: 'cardtitle' }, head, b.name);
    html('div', { class: 'cardkind' }, head, `${b.kind} · ${b.residents} residents · ${b.needsHelp} need help · ${b.staff} staff · ${b.vans} van${b.vans === 1 ? '' : 's'}`);
    const phase = ctl.sim.phase;
    const [band, bc] = riskBand(b.risk);
    const row = html('div', { class: 'stats' }, card);
    const s1 = html('div', { class: 'stat' }, row);
    html('div', { class: 'statlabel' }, s1, 'Fire risk');
    const v1 = html('div', { class: 'statval' }, s1, `${Math.round(b.risk)}`);
    v1.style.color = bc;
    html('div', { class: 'statsub' }, s1, b.risk !== b.baseRisk ? `${band} · was ${Math.round(b.baseRisk)}` : band);
    const s2 = html('div', { class: 'stat' }, row);
    html('div', { class: 'statlabel' }, s2, phase === 'prep' ? 'A fire like Eaton arrives in' : 'Fire arrives in');
    const v2 = html('div', { class: 'statval' }, s2, b.status === 'burning' || b.status === 'lost' ? 'now' : S.fmtMin(b.fireEtaMin));
    v2.style.color = '#FF5A4E';
    const s3 = html('div', { class: 'stat' }, row);
    html('div', { class: 'statlabel' }, s3, 'Evacuation needs');
    const late = b.fireEtaMin >= 0 && b.evacNeededMin > b.fireEtaMin;
    const v3 = html('div', { class: 'statval' }, s3, S.fmtMin(b.evacNeededMin));
    v3.style.color = late ? '#F2A93B' : '#3DD68C';
    if (b.prepared && phase === 'prep') html('div', { class: 'badge good' }, card, 'Prepared · better insurance rating');
    else if (late && b.kind !== 'shelter') html('div', { class: 'badge warn' }, card, 'Evacuation would not finish before the fire');
    if (b.explanation) html('p', { class: 'explain' }, card, b.explanation);

    if (phase === 'prep') {
      const fixes = ctl.fixes.filter((f) => f.buildingId === b.id);
      if (fixes.length) html('div', { class: 'section' }, card, 'Fixes');
      for (const f of fixes) {
        const r = html('div', { class: 'fix' }, card);
        const info = html('div', { class: 'fixinfo' }, r);
        html('div', { class: 'fixname' }, info, f.name);
        const effect = f.addVans ? `+${f.addVans} van → evac ${S.fmtMin(S.evacNeededMin({ ...b, vans: b.vans + (f.approved ? 0 : f.addVans) }, ctl.world.people.filter((x) => x.buildingId === b.id), P))}` : `risk −${f.riskDrop}${f.name.startsWith('Clear brush') ? ' (simulated)' : ''}`;
        html('div', { class: 'fixsub' }, info, `${money(f.costUsd)} · ${effect}`);
        if (f.approved) html('span', { class: 'done' }, r, 'Approved ✓');
        else
          html('button', { class: 'btn small', onclick: () => {
            toast(ctl.approveFix(f.id));
            render();
          } }, r, 'Approve');
      }
      html('button', { class: 'btn ghost wide', onclick: () => {
        const ids = ctl.approveRecommended();
        toast(ids.length ? `Approved ${ids.length} recommended fixes` : 'Nothing left that fits the budget');
        render();
      } }, card, 'Approve recommended (all buildings)');
    } else if (b.kind !== 'shelter') {
      const ppl = ctl.world.people.filter((x) => x.buildingId === b.id);
      const out = ppl.filter((x) => x.status === 'out').length;
      const bar = html('div', { class: 'bar' }, card);
      const fill = html('div', { class: 'barfill' }, bar);
      fill.style.width = `${ppl.length ? (100 * out) / ppl.length : 0}%`;
      html('div', { class: 'barlabel' }, card, `${out} of ${ppl.length} out`);
      if (!b.evacStarted && b.status !== 'lost' && phase === 'fire')
        html('button', { class: 'btn danger wide', onclick: () => {
          toast(ctl.startEvacuation(b.id));
          render();
        } }, card, 'Start evacuation');
      const missing = ppl.filter((x) => x.status === 'pinged' || x.status === 'cant_move' || x.status === 'claimed' || x.status === 'left_behind');
      if (missing.length) {
        html('div', { class: 'section' }, card, b.evacStarted ? 'Not out yet' : 'Residents');
        const list = html('div', { class: 'names' }, card);
        for (const x of missing.slice(0, 14)) html('span', { class: `name st-${x.status}` }, list, `${x.name}${x.note ? ' · ' + x.note : ''}`);
        if (missing.length > 14) html('span', { class: 'name' }, list, `+${missing.length - 14} more`);
      }
    }
  }

  function renderPhone() {
    const phone = $('phone');
    phone.replaceChildren();
    const tabs = html('div', { class: 'tabs' }, phone);
    const tab = phone.dataset.tab || 'resident';
    for (const [k, label] of [['resident', 'Resident'], ['staff', 'Staff']]) html('button', { class: `tab${tab === k ? ' on' : ''}`, onclick: () => {
      phone.dataset.tab = k;
      renderPhone();
    } }, tabs, label);
    if (tab === 'resident') {
      const ppl = ctl.world.people.filter((x) => x.buildingId === state.selected);
      if (!ppl.length) {
        html('p', { class: 'muted' }, phone, 'Pick a residential building on the map.');
        return;
      }
      const sel = html('select', { class: 'select', onchange: (e) => {
        state.resident = Number(e.target.value);
        renderPhone();
      } }, phone);
      for (const x of [...ppl].sort((a, c) => Number(c.needsHelp) - Number(a.needsHelp) || a.id - c.id).slice(0, 80)) {
        const o = html('option', { value: x.id }, sel, `${x.name}${x.note ? ' · ' + x.note : ''}`);
        if (x.id === state.resident) o.selected = true;
      }
      const p = ppl.find((x) => x.id === state.resident) ?? ppl[0];
      const b = ctl.building(p.buildingId);
      const msgs = html('div', { class: 'msgs' }, phone);
      if (p.status === 'inside') html('div', { class: 'bubble lantern' }, msgs, ctl.sim.phase === 'prep' ? `Aegis: ${b.name} has an evacuation plan on file.` : 'Aegis: no evacuation order for your building yet.');
      else {
        const eta = b.fireEtaMin > 0 ? ` Fire is ${S.fmtMin(b.fireEtaMin)} away.` : '';
        html('div', { class: 'bubble lantern' }, msgs, `Aegis: Evacuation order for ${b.name}.${eta} Are you safe?`);
        const reply = { safe: 'I’m safe', cant_move: 'I can’t get out', claimed: 'I can’t get out', out: 'I’m out', left_behind: '…' }[p.status];
        if (reply && p.status !== 'pinged') html('div', { class: 'bubble me' }, msgs, reply);
        const task = ctl.world.tasks.find((t) => t.personId === p.id && t.kind === 'help_person');
        if (p.status === 'claimed' && task) html('div', { class: 'bubble lantern' }, msgs, `Aegis: Help is on the way — ${task.claimedBy.replace(S.AUTO_SUFFIX, '')} is coming to floor ${p.floor}.`);
        if (p.status === 'out') html('div', { class: 'bubble lantern' }, msgs, 'Aegis: You are checked in at the shelter. ✓');
        if (p.status === 'left_behind') html('div', { class: 'bubble alert' }, msgs, 'Building lost before this resident got out.');
        if (p.status === 'pinged' && task) html('div', { class: 'bubble alert' }, msgs, 'No reply — escalated to staff.');
      }
      const can = ctl.sim.phase === 'fire' && (p.status === 'pinged' || p.status === 'safe' || p.status === 'cant_move');
      const btns = html('div', { class: 'row' }, phone);
      html('button', { class: 'btn good', onclick: () => {
        toast(ctl.reply(p.id, 'safe'));
        render();
      } }, btns, 'I’m safe');
      html('button', { class: 'btn danger', onclick: () => {
        toast(ctl.reply(p.id, 'cant_move'));
        render();
      } }, btns, 'I can’t get out');
      if (!can) btns.querySelectorAll('button').forEach((x) => (x.disabled = true));
    } else {
      const sel = html('select', { class: 'select', onchange: (e) => {
        state.staff = e.target.value;
        renderPhone();
      } }, phone);
      for (const n of S.PHONE_STAFF) {
        const o = html('option', { value: n }, sel, `${n} (staff phone)`);
        if (n === state.staff) o.selected = true;
      }
      const tasks = ctl.openTasks();
      if (!tasks.length) html('p', { class: 'muted' }, phone, ctl.sim.phase === 'fire' ? 'No open tasks.' : 'Tasks appear when residents need help.');
      for (const t of tasks.slice(0, 7)) {
        const p = ctl.world.people.find((x) => x.id === t.personId);
        const b = ctl.building(t.buildingId);
        const r = html('div', { class: `task p${t.priority}` }, phone);
        const info = html('div', { class: 'fixinfo' }, r);
        html('div', { class: 'fixname' }, info, `${t.priority === 3 ? 'URGENT · ' : ''}${p ? p.name : '?'} — ${b ? b.name : ''}`);
        html('div', { class: 'fixsub' }, info, `${p && p.note ? p.note + ' · ' : ''}floor ${p ? p.floor : '?'}${t.claimedBy ? ' · claimed by ' + t.claimedBy.replace(S.AUTO_SUFFIX, ' (on-site)') : ''}`);
        if (t.claimedBy === '')
          html('button', { class: 'btn small', onclick: () => {
            toast(ctl.claim(t.id, state.staff));
            render();
          } }, r, 'Claim');
        else if (t.claimedBy === state.staff)
          html('button', { class: 'btn small good', onclick: () => {
            toast(ctl.complete(t.id));
            render();
          } }, r, 'Done');
      }
      if (tasks.length > 7) html('p', { class: 'muted' }, phone, `+${tasks.length - 7} more open tasks`);
    }
  }

  function renderFeed() {
    const feed = $('feed');
    feed.replaceChildren();
    for (const e of ctl.events.slice(-9).reverse()) {
      const r = html('div', { class: 'ev' }, feed);
      html('span', { class: 'evt' }, r, ctl.sim.phase === 'prep' && e.tick === 0 ? 'prep' : `t${e.tick}`);
      html('span', {}, r, e.text);
    }
  }

  function renderResults() {
    const ov = $('results');
    const res = ctl.results;
    if (!res || !state.showResults) {
      ov.classList.remove('show');
      return;
    }
    ov.classList.add('show');
    // [label, with, without, which side is better: +1 higher is better, -1 lower is better]
    const rows = [
      ['People safe', `${res.with.peopleSafe}/${res.with.peopleTotal}`, `${res.without.peopleSafe}/${res.without.peopleTotal}`, Math.sign(res.with.peopleSafe - res.without.peopleSafe)],
      ['Buildings lost', res.with.buildingsLost, res.without.buildingsLost, Math.sign(res.without.buildingsLost - res.with.buildingsLost)],
      ['Damage', money(res.with.damageUsd), money(res.without.damageUsd), Math.sign(res.without.damageUsd - res.with.damageUsd)],
      ['Insurance claims', res.with.claims, res.without.claims, Math.sign(res.without.claims - res.with.claims)],
    ];
    const tb = $('resTable');
    tb.replaceChildren();
    const h = html('div', { class: 'rrow head' }, tb);
    html('div', {}, h, '');
    html('div', {}, h, 'With Aegis');
    html('div', {}, h, 'Without');
    for (const [k, a, b2, better] of rows) {
      const r = html('div', { class: 'rrow' }, tb);
      html('div', { class: 'rk' }, r, k);
      html('div', { class: `rv ${better > 0 ? 'win' : better < 0 ? 'lose' : ''}` }, r, String(a));
      html('div', { class: `rv ${better < 0 ? 'win' : better > 0 ? 'lose' : ''}` }, r, String(b2));
    }
  }

  // ── boot ──
  if (params.get('tab') === 'staff') $('phone').dataset.tab = 'staff';
  if (state.demo) demo.prep();
  if (params.get('recommend') === '1') ctl.approveRecommended();
  if (params.get('fire') === '1' || params.get('play') === '1') ctl.startFire();
  render();
  if (params.get('play') === '1') play();
  if (params.get('selftest') === '1') setTimeout(() => selfTest(ctl), 300);
  if (params.get('layoutcheck') === '1')
    setTimeout(() => {
      // Debug aid: list elements that stick out past the viewport (horizontal scroll).
      const vw = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll('body *')]
        .filter((e) => e.getBoundingClientRect().right > vw + 1)
        .slice(0, 12)
        .map((e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${typeof e.className === 'string' && e.className ? '.' + e.className.split(' ').join('.') : ''}:${Math.round(e.getBoundingClientRect().right)}`);
      document.body.dataset.layout = `vw=${vw} scroll=${document.documentElement.scrollWidth} wide=${wide.join(' ')}`;
    }, 500);
  return { render, play, stop };
}

/** ?selftest=1 — clicks through the UI like a presenter would and records results in body[data-selftest]. */
function selfTest(ctl) {
  const results = [];
  const check = (ok, msg) => results.push(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const btn = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(text));
  try {
    click(document.querySelector('g.bldg[data-id="12"]'));
    check(document.querySelector('#card .cardtitle')?.textContent === 'Building 12', 'clicking Building 12 selects it');
    click(btn($('card'), 'Approve'));
    check(ctl.fixes.find((f) => f.id === 121)?.approved === true, 'Approve on the card approves the van');
    click(btn($('card'), 'Approve recommended'));
    check(ctl.fixes.filter((f) => f.approved).length > 1, 'Approve recommended approves more fixes');
    check(/Prepared/.test($('card').textContent), 'card shows the Prepared badge');
    click($('btnPhase'));
    check(ctl.sim.phase === 'fire' && $('phasePill').textContent === 'Fire', 'Start fire switches to the fire phase');
    click(btn($('card'), 'Start evacuation'));
    check(ctl.building(12).evacStarted, 'Start evacuation button starts Building 12');
    click(btn($('phone'), 'I can’t get out'));
    const maria = ctl.world.tasks.find((t) => t.personId === 1201);
    check(!!maria && maria.priority === 3, 'resident phone “I can’t get out” creates an urgent task');
    click(btn($('phone'), 'Staff'));
    const row = [...$('phone').querySelectorAll('.task')].find((r) => r.textContent.includes('Maria R.'));
    check(!!row && /URGENT/.test(row.textContent), 'staff phone lists Maria as URGENT');
    click(row && btn(row, 'Claim'));
    check(maria?.claimedBy === 'Alex', 'Claim on the staff phone claims as Alex');
    const row2 = [...$('phone').querySelectorAll('.task')].find((r) => r.textContent.includes('Maria R.'));
    click(row2 && btn(row2, 'Done'));
    check(ctl.world.people.find((x) => x.id === 1201)?.status === 'out', 'Done gets Maria out');
    for (let i = 0; i < 3; i++) click($('btnStep'));
    check(ctl.sim.tick === 3, 'Step advances one tick at a time');
    check($('feed').textContent.includes('Maria R. reached safety with Alex'), 'feed shows Maria reaching safety');
    click($('btnEnd'));
    check(ctl.sim.phase === 'ended' && $('results').classList.contains('show'), 'End & compare shows the results');
    check($('resTable').textContent.includes('/260'), 'results table is filled in');
    click($('closeResults'));
    check(!$('results').classList.contains('show'), 'Close hides the results');
    const approved = ctl.fixes.filter((f) => f.approved).length;
    click($('btnPhase'));
    check(ctl.sim.phase === 'prep' && ctl.fixes.filter((f) => f.approved).length === approved, 'Back to prep keeps approved fixes');
  } catch (e) {
    results.push(`FAIL crashed: ${e && e.message}`);
  }
  document.body.dataset.selftest = results.join(' | ');
}

// Browser entry.
if (typeof document !== 'undefined') {
  window.addEventListener('error', (e) => {
    document.body.dataset.error = String(e.message);
    const b = document.getElementById('errbar');
    if (b) {
      b.textContent = `Error: ${e.message}`;
      b.style.display = 'block';
    }
  });
  const params = new URLSearchParams(location.search);
  const ctl = new Controller({ fireSeed: params.has('seed') ? Number(params.get('seed')) : undefined });
  mountView(ctl, params);
}
