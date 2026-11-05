(function(){
  "use strict";
  const STORAGE_KEY = "ascent_data_v1";
  const SVGNS = "http://www.w3.org/2000/svg";

  const ROW_H = 148;
  const LANE_W = 62;
  const WIDTH = 400;
  const CENTER_X = 200;
  const BASE_TOP_PAD = 90;
  const BASE_BOTTOM_PAD = 90;

  function uid(){ return 'id' + Math.random().toString(36).slice(2,10); }

  function seedData(){
    return {
      currentGoalId: null,
      goals: []
    };
  }

  function defaultGoal(name){
    const rootId = uid();
    return {
      id: uid(),
      name: name || "My first ascent",
      createdAt: Date.now(),
      steps: [
        { id: rootId, label: "Trailhead", notes: "", status: "active", leadsTo: [] }
      ]
    };
  }

  function load(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) throw new Error('empty');
      const data = JSON.parse(raw);
      if(!data.goals || !data.goals.length) throw new Error('no goals');
      return data;
    }catch(e){
      const data = seedData();
      const g = defaultGoal("My first ascent");
      data.goals.push(g);
      data.currentGoalId = g.id;
      save(data);
      return data;
    }
  }

  function save(data){
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  let state = load();

  // Load shared design tokens (also consumed by other Mission Control apps).
  // Wrapped defensively: if this fails for any reason (opened via file://,
  // offline, blocked request), the app must still render using the CSS
  // defaults already baked into style.css.
  try {
    if (typeof fetch === 'function') {
      fetch('js/palette.json')
        .then(r => (r && r.ok) ? r.json() : null)
        .then(tokens => {
          if (!tokens) return;
          const root = document.documentElement.style;
          Object.keys(tokens).forEach(key => root.setProperty(`--${key}`, tokens[key]));
        })
        .catch(() => { /* fall back to CSS defaults */ });
    }
  } catch (e) {
    /* fall back to CSS defaults */
  }

  function currentGoal(){
    return state.goals.find(g => g.id === state.currentGoalId) || state.goals[0];
  }

  function incomingMap(steps){
    const inc = {};
    steps.forEach(s => inc[s.id] = []);
    steps.forEach(s => {
      s.leadsTo.forEach(childId => {
        if(inc[childId]) inc[childId].push(s.id);
      });
    });
    return inc;
  }

  function recomputeStatuses(goal){
    const byId = {};
    goal.steps.forEach(s => byId[s.id] = s);
    const inc = incomingMap(goal.steps);
    let changed = true;
    let guard = 0;
    while(changed && guard < 50){
      changed = false; guard++;
      goal.steps.forEach(s => {
        if(s.status === 'done') return;
        const preds = inc[s.id];
        if(preds.length === 0){
          if(s.status !== 'active' && s.status !== 'done'){ s.status = 'active'; changed = true; }
          return;
        }
        const allDone = preds.every(pid => byId[pid] && byId[pid].status === 'done');
        if(allDone && s.status === 'locked'){ s.status = 'active'; changed = true; }
        if(!allDone && s.status === 'active'){ s.status = 'locked'; changed = true; }
      });
    }
  }

  // ---------- layout ----------
  function computeLayout(goal){
    const steps = goal.steps;
    const byId = {}; steps.forEach(s => byId[s.id] = s);
    const inc = incomingMap(steps);

    // row = longest path from any root
    const rowCache = {};
    function rowOf(id, guard){
      if(rowCache[id] !== undefined) return rowCache[id];
      guard = (guard || 0) + 1;
      if(guard > 200){ rowCache[id] = 0; return 0; }
      const preds = inc[id];
      if(!preds.length){ rowCache[id] = 0; return 0; }
      const r = 1 + Math.max(...preds.map(p => rowOf(p, guard)));
      rowCache[id] = r;
      return r;
    }
    steps.forEach(s => rowOf(s.id));

    const order = [...steps].sort((a,b) => rowCache[a.id] - rowCache[b.id]);
    const lane = {};
    order.forEach(s => {
      const preds = inc[s.id];
      if(!preds.length){
        lane[s.id] = 0;
      } else if(preds.length > 1){
        const avg = preds.reduce((sum,p) => sum + lane[p], 0) / preds.length;
        lane[s.id] = avg;
      } else {
        const p = preds[0];
        const siblings = byId[p].leadsTo;
        if(siblings.length <= 1){
          lane[s.id] = lane[p];
        } else {
          const idx = siblings.indexOf(s.id);
          const mid = (siblings.length - 1) / 2;
          lane[s.id] = lane[p] + (idx - mid) * 1.15;
        }
      }
    });

    const maxRow = Math.max(0, ...steps.map(s => rowCache[s.id]));
    const height = BASE_TOP_PAD + BASE_BOTTOM_PAD + (maxRow + 1) * ROW_H;

    const pos = {};
    steps.forEach(s => {
      const row = rowCache[s.id];
      const wind = Math.sin(row * 0.85 + lane[s.id]) * 16;
      const x = CENTER_X + lane[s.id] * LANE_W + wind;
      const y = height - BASE_BOTTOM_PAD - row * ROW_H;
      pos[s.id] = { x, y, row, lane: lane[s.id] };
    });

    // Sequential step numbers: top-to-bottom by row, left-to-right by lane
    // within a row. Stable and deterministic, purely for display — not
    // persisted, recomputed fresh every render.
    const numberOf = {};
    [...steps]
      .sort((a,b) => rowCache[a.id] - rowCache[b.id] || lane[a.id] - lane[b.id])
      .forEach((s, i) => { numberOf[s.id] = i + 1; });

    return { pos, height, maxRow, order, inc, numberOf };
  }

  // ---------- manual reordering ----------
  // Steps form a graph, not a flat list, so "earlier/later" and "left/right"
  // only have one unambiguous meaning on a clean, unforked stretch of trail.
  // Each function below returns false (and changes nothing) if the move
  // would be ambiguous — e.g. it would need to cross a fork or a merge —
  // rather than guessing and risking a corrupted trail.

  function reorderCapabilities(goal, id){
    const byId = {}; goal.steps.forEach(s => byId[s.id] = s);
    const inc = incomingMap(goal.steps);
    const step = byId[id];
    if(!step) return { canEarlier:false, canLater:false, canLeft:false, canRight:false };

    const preds = inc[id];
    const canEarlier = preds.length === 1 && byId[preds[0]].leadsTo.length === 1;

    const children = step.leadsTo;
    const canLater = children.length === 1 && inc[children[0]].length === 1;

    let canLeft = false, canRight = false;
    if(preds.length === 1){
      const siblings = byId[preds[0]].leadsTo;
      if(siblings.length > 1){
        const idx = siblings.indexOf(id);
        canLeft = idx > 0;
        canRight = idx < siblings.length - 1;
      }
    }
    return { canEarlier, canLater, canLeft, canRight };
  }

  function moveStepEarlier(goal, id){
    const byId = {}; goal.steps.forEach(s => byId[s.id] = s);
    const inc = incomingMap(goal.steps);
    const preds = inc[id];
    if(preds.length !== 1) return false;
    const p = byId[preds[0]];
    if(p.leadsTo.length !== 1) return false;

    const pPreds = inc[p.id];
    pPreds.forEach(ppid => {
      const idx = byId[ppid].leadsTo.indexOf(p.id);
      if(idx > -1) byId[ppid].leadsTo[idx] = id;
    });
    const stepOldChildren = byId[id].leadsTo.slice();
    byId[id].leadsTo = [p.id];
    byId[p.id].leadsTo = stepOldChildren;
    return true;
  }

  function moveStepLater(goal, id){
    const byId = {}; goal.steps.forEach(s => byId[s.id] = s);
    const inc = incomingMap(goal.steps);
    const step = byId[id];
    if(step.leadsTo.length !== 1) return false;
    const c = byId[step.leadsTo[0]];
    if(inc[c.id].length !== 1) return false;

    const idPreds = inc[id];
    idPreds.forEach(pid => {
      const idx = byId[pid].leadsTo.indexOf(id);
      if(idx > -1) byId[pid].leadsTo[idx] = c.id;
    });
    const cOldChildren = c.leadsTo.slice();
    c.leadsTo = [id];
    step.leadsTo = cOldChildren;
    return true;
  }

  function moveSibling(goal, id, direction){
    const byId = {}; goal.steps.forEach(s => byId[s.id] = s);
    const inc = incomingMap(goal.steps);
    const preds = inc[id];
    if(preds.length !== 1) return false;
    const siblings = byId[preds[0]].leadsTo;
    const idx = siblings.indexOf(id);
    const swapIdx = idx + direction;
    if(swapIdx < 0 || swapIdx >= siblings.length) return false;
    [siblings[idx], siblings[swapIdx]] = [siblings[swapIdx], siblings[idx]];
    return true;
  }

  // ---------- SVG helpers ----------
  function el(tag, attrs, parent){
    const e = document.createElementNS(SVGNS, tag);
    if(attrs) Object.keys(attrs).forEach(k => e.setAttribute(k, attrs[k]));
    if(parent) parent.appendChild(e);
    return e;
  }

  // ---------- hero illustration ----------
  // One empty scene, plus a cut-out hiker (girl or boy) who walks the trail.
  // w/h are the sprite's size and ax/ay is the point between his feet.
  const AVATARS = {
    girl: { sprite: 'images/sprite-girl.webp', w: 216, h: 452, ax: 48, ay: 426 },
    boy:  { sprite: 'images/sprite-boy.webp',  w: 214, h: 464, ax: 43, ay: 438 }
  };

  function currentAvatar(){
    return AVATARS[state.avatar] ? state.avatar : 'girl';
  }

  function renderHero(){
    const key = currentAvatar();
    const img = document.getElementById('heroImg');
    if(img) img.setAttribute('alt', 'A winding mountain trail climbing to a sunlit summit flag');
    document.querySelectorAll('#avatarToggle button').forEach(btn => {
      const on = btn.dataset.avatar === key;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    });
  }

  document.querySelectorAll('#avatarToggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      state.avatar = btn.dataset.avatar;
      save(state);
      render();
    });
  });

  // ---------- trail geometry ----------
  // The painted trail, traced from the artwork (one shared empty scene). Points are in the artwork's own 1024 x 1536 space and
  // run from the foot of the picture up to the summit flag.
  const IMG_W = 1024;
  const TRAIL = [[657,1417],[649,1409],[641,1401],[633,1394],[625,1386],[616,1378],[608,1371],[599,1363],[591,1356],[582,1349],[573,1342],[564,1336],[555,1329],[546,1323],[536,1316],[527,1310],[518,1304],[508,1298],[499,1292],[489,1286],[479,1280],[470,1274],[460,1268],[451,1262],[441,1257],[431,1251],[422,1245],[413,1238],[404,1231],[396,1223],[389,1215],[384,1204],[383,1193],[385,1182],[390,1172],[396,1163],[404,1155],[412,1147],[421,1140],[430,1133],[439,1127],[448,1120],[457,1114],[467,1107],[476,1101],[485,1094],[494,1088],[503,1081],[512,1074],[521,1067],[529,1060],[537,1052],[545,1043],[552,1035],[558,1025],[564,1016],[570,1006],[575,996],[579,986],[581,975],[581,963],[578,952],[574,942],[570,931],[567,921],[563,910],[560,899],[558,888],[556,877],[556,866],[558,855],[563,845],[570,836],[580,830],[590,825],[600,821],[611,817],[622,814],[633,811],[643,807],[654,803],[664,798],[673,791],[680,782],[684,772],[685,761],[683,750],[678,740],[672,730],[665,721],[657,713],[649,706],[639,700],[629,695],[620,689],[610,683],[602,675],[596,666],[591,656],[590,645],[591,634],[596,623],[602,614],[609,605],[616,596],[622,587],[627,577],[629,566],[628,555],[625,544],[619,534],[612,525],[605,517],[597,509],[590,500],[584,490],[581,480],[581,468],[583,457],[587,447],[591,436],[595,426],[597,415],[595,404],[589,395],[582,385],[577,375],[573,365],[569,354],[566,344],[563,333]];
  const TRAIL_CUM = [0];
  for(let i = 1; i < TRAIL.length; i++){
    TRAIL_CUM.push(TRAIL_CUM[i-1] + Math.hypot(TRAIL[i][0] - TRAIL[i-1][0], TRAIL[i][1] - TRAIL[i-1][1]));
  }
  const TRAIL_TOTAL = TRAIL_CUM[TRAIL_CUM.length - 1];
  let laneOffset = 34;   // widened per render so forked markers never overlap

  // Point on the trail at fraction s (0 = trailhead, 1 = summit), nudged
  // sideways by `lane` lanes so steps on a fork sit side by side.
  function trailAt(s, lane){
    s = Math.max(0, Math.min(1, s));
    const d = s * TRAIL_TOTAL;
    let i = 1;
    while(i < TRAIL_CUM.length - 1 && TRAIL_CUM[i] < d) i++;
    const segLen = (TRAIL_CUM[i] - TRAIL_CUM[i-1]) || 1;
    const u = (d - TRAIL_CUM[i-1]) / segLen;
    const a = TRAIL[i-1], b = TRAIL[i];
    const tx = (b[0] - a[0]) / segLen, ty = (b[1] - a[1]) / segLen;
    const off = Math.max(-2, Math.min(2, lane || 0)) * laneOffset;
    return {
      x: a[0] + (b[0] - a[0]) * u - ty * off,
      y: a[1] + (b[1] - a[1]) * u + tx * off
    };
  }

  // A rounded label. `place(width)` returns the left edge and vertical centre.
  function pill(parent, text, o){
    const g = el('g', {}, parent);
    const rect = el('rect', {}, g);
    const t = el('text', {
      'font-size': o.fs, fill: o.fg,
      style: `font-family:${o.family};font-weight:${o.weight};`
    }, g);
    t.textContent = text;
    let w = 0;
    try{ w = t.getComputedTextLength(); }catch(e){ w = 0; }
    if(!w) w = text.length * o.fs * 0.56;
    const padX = o.fs * 0.55, h = o.fs * 1.55, W = w + padX * 2;
    const p = o.place(W, h);
    rect.setAttribute('x', p.x); rect.setAttribute('y', p.y - h / 2);
    rect.setAttribute('width', W); rect.setAttribute('height', h);
    rect.setAttribute('rx', h / 2);
    rect.setAttribute('fill', o.bg); rect.setAttribute('fill-opacity', '0.94');
    rect.setAttribute('stroke', 'rgba(58,54,46,0.18)'); rect.setAttribute('stroke-width', '1.5');
    t.setAttribute('x', p.x + padX); t.setAttribute('y', p.y + o.fs * 0.35);
    return g;
  }

  function shorten(text, n){
    return text.length > n ? text.slice(0, n - 1) + '\u2026' : text;
  }

  // ---------- render ----------
  function render(){
    renderGoalRow();
    const goal = currentGoal();
    if(!goal){ return; }
    document.getElementById('goalTitle').textContent = goal.name;
    const done = goal.steps.filter(s => s.status === 'done').length;
    document.getElementById('goalSub').textContent =
      `${done} of ${goal.steps.length} step${goal.steps.length===1?'':'s'} walked`;

    recomputeStatuses(goal);
    save(state);

    const { pos, inc, numberOf } = computeLayout(goal);
    renderHero();
    renderTrail(goal, pos, numberOf);
    renderTaskList(goal, pos, inc, numberOf);
  }

  // ---------- the walking hiker ----------
  let hikerS = null, hikerGoalId = null, hikerRaf = 0;
  const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // He is drawn at full size near the foot of the hill and shrinks with
  // distance as he climbs (the sprite was cut out at scale 1 near y = 1150).
  function hikerScale(y){
    const t = Math.max(0, (y - 300) / 850);
    return Math.max(0.14, Math.min(0.95, Math.pow(t, 1.15)));
  }
  function placeHiker(g, s){
    const p = trailAt(s, 0), k = hikerScale(p.y);
    g.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)}) scale(${k.toFixed(3)})`);
  }

  function drawHiker(parent, goalId, target){
    if(hikerRaf){ cancelAnimationFrame(hikerRaf); hikerRaf = 0; }
    const av = AVATARS[currentAvatar()];
    const g = el('g', { class: 'hiker' }, parent);
    el('ellipse', { cx: 0, cy: 4, rx: 72, ry: 15, fill: '#2a2418', opacity: 0.28 }, g);
    const img = el('image', { x: -av.ax, y: -av.ay, width: av.w, height: av.h }, g);
    img.setAttribute('href', av.sprite);

    const fresh = (hikerGoalId !== goalId || hikerS === null);
    hikerGoalId = goalId;
    if(fresh || REDUCED_MOTION || Math.abs(target - hikerS) < 1e-4){
      hikerS = target; placeHiker(g, hikerS); return;
    }
    // walk along the trail from where he was to the current step
    const from = hikerS;
    const dist = Math.abs(target - from) * TRAIL_TOTAL;
    const dur = Math.max(800, Math.min(3600, 700 + dist * 2.4));
    const t0 = performance.now();
    placeHiker(g, from);
    function frame(now){
      const u = Math.min(1, (now - t0) / dur);
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;   // ease in-out
      hikerS = from + (target - from) * e;
      placeHiker(g, hikerS);
      img.setAttribute('y', -av.ay - (u < 1 ? Math.abs(Math.sin((now - t0) / 115)) * 9 : 0));   // little walking bob
      if(u < 1){ hikerRaf = requestAnimationFrame(frame); }
      else { hikerRaf = 0; hikerS = target; }
    }
    hikerRaf = requestAnimationFrame(frame);
  }

  // Draws the steps on top of the painted trail.
  function renderTrail(goal, pos, numberOf){
    const svg = document.getElementById('trailSvg');
    svg.innerHTML = '';
    const steps = goal.steps;
    const allDone = steps.length > 0 && steps.every(s => s.status === 'done');
    const summit = trailAt(1, 0);

    // Name of the mountain (or the win) across the sky.
    pill(svg, shorten(allDone ? 'Summit reached' : goal.name, 26), {
      fs: 40, family: "'Fraunces',serif", weight: 700,
      bg: allDone ? 'var(--gold)' : 'var(--cream)', fg: 'var(--pine)',
      place: (W) => ({ x: (IMG_W - W) / 2, y: 76 })
    });

    if(!steps.length){
      drawHiker(svg, goal.id, 0);
      pill(svg, 'No steps yet. Tap + Add step to break trail.', {
        fs: 28, family: "'Inter',sans-serif", weight: 600,
        bg: 'var(--cream)', fg: 'var(--ink)',
        place: (W) => ({ x: (IMG_W - W) / 2, y: 1160 })
      });
      return;
    }

    if(allDone){
      el('circle', { cx: summit.x, cy: summit.y, r: 66, fill: 'var(--gold)', opacity: 0.3, class: 'pulse' }, svg);
    }

    // Steps are spread evenly along the whole trail in their numbered order
    // (the same order as the checklist), however the steps are connected.
    const n = steps.length;
    const ordered = [...steps].sort((a, b) => numberOf[a.id] - numberOf[b.id]);
    const spacing = TRAIL_TOTAL / n;
    const baseR = Math.max(13, Math.min(28, spacing * 0.36));

    // The whole trail, trailhead to summit flag, is always drawn: a clear
    // dashed route, with a solid line over the stretch already walked.
    const linkLayer = el('g', {}, svg);
    function routePath(sa, sb){
      const n = Math.max(2, Math.ceil((sb - sa) * TRAIL_TOTAL / 12));
      let d = '';
      for(let k = 0; k <= n; k++){
        const p = trailAt(sa + (sb - sa) * (k / n), 0);
        d += (k ? ' L ' : 'M ') + p.x.toFixed(1) + ' ' + p.y.toFixed(1);
      }
      return d;
    }
    const round = { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    const full = routePath(0, 1);
    el('path', Object.assign({ d: full, stroke: 'var(--ink)', 'stroke-width': 17, 'stroke-opacity': 0.35 }, round), linkLayer);
    el('path', Object.assign({ d: full, stroke: '#fff', 'stroke-width': 10, 'stroke-dasharray': '26 16' }, round), linkLayer);

    // walked as far as the first step that isn't done yet (or the summit)
    const firstOpen = ordered.findIndex(st => st.status !== 'done');
    const walkedTo = firstOpen === -1 ? 1 : firstOpen / n;
    if(walkedTo > 0){
      const walked = routePath(0, walkedTo);
      el('path', Object.assign({ d: walked, stroke: '#fff', 'stroke-width': 19, 'stroke-opacity': 0.7 }, round), linkLayer);
      el('path', Object.assign({ d: walked, stroke: 'var(--pine)', 'stroke-width': 11 }, round), linkLayer);
    }

    // the hiker stands on the current step (or the summit once everything is done)
    drawHiker(svg, goal.id, walkedTo);

    // step markers (the current step is drawn last so it sits on top)
    const markerLayer = el('g', {}, svg);
    const labelLayer = el('g', {}, svg);
    const statusWord = { done: 'done', active: 'current step', locked: 'not yet available' };
    [...steps].sort((a, b) => (a.status === 'active') - (b.status === 'active')).forEach(s => {
      const pt = trailAt((numberOf[s.id] - 1) / n, 0);
      const active = s.status === 'active';
      const r = active ? Math.min(baseR * 1.25, 34) : baseR;
      const g = el('g', {
        class: 'marker ' + s.status,
        transform: `translate(${pt.x.toFixed(1)},${pt.y.toFixed(1)})`,
        tabindex: '0', role: 'button',
        'aria-label': `Step ${numberOf[s.id]}: ${s.label} (${statusWord[s.status] || s.status})`
      }, markerLayer);
      el('title', {}, g).textContent = s.label;
      el('circle', { r: r + 10, fill: 'transparent' }, g);
      if(active){
        el('circle', { r: r + 11, fill: 'var(--clay)', opacity: 0.3, class: 'pulse' }, g);
      }

      let body;
      if(s.status === 'done'){
        body = el('circle', { r, fill: 'var(--pine)', stroke: '#fff', 'stroke-width': 3.5 }, g);
        el('path', {
          d: `M ${-r*0.4} ${r*0.02} L ${-r*0.1} ${r*0.32} L ${r*0.44} ${-r*0.32}`,
          stroke: '#fff', 'stroke-width': Math.max(2.5, r * 0.17), fill: 'none',
          'stroke-linecap': 'round', 'stroke-linejoin': 'round'
        }, g);
      } else if(active){
        body = el('circle', { r, fill: 'var(--clay)', stroke: '#fff', 'stroke-width': 4 }, g);
      } else {
        body = el('circle', { r, fill: '#fff', stroke: '#9c917a', 'stroke-width': 2.5, 'stroke-dasharray': '5 4' }, g);
      }
      body.setAttribute('class', 'markerBody');

      if(s.status !== 'done'){
        const fs = r * 0.95;
        const num = el('text', {
          x: 0, y: fs * 0.35, 'text-anchor': 'middle', 'font-size': fs,
          fill: active ? '#fff' : 'var(--ink)', opacity: active ? 1 : 0.65,
          style: "font-family:'Inter',sans-serif;font-weight:700;"
        }, g);
        num.textContent = numberOf[s.id];
      }

      g.addEventListener('click', () => onStepClick(s.id));
      g.addEventListener('keydown', (e) => {
        if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); onStepClick(s.id); }
      });

      if(active){
        pill(labelLayer, shorten(s.label, 18), {
          fs: 30, family: "'Inter',sans-serif", weight: 700,
          bg: 'var(--cream)', fg: 'var(--ink)',
          place: (W) => {
            const right = pt.x + r + 16 + W <= IMG_W - 10;
            let x = right ? pt.x + r + 16 : pt.x - r - 16 - W;
            x = Math.max(10, Math.min(IMG_W - 10 - W, x));
            return { x, y: pt.y };
          }
        });
      }
    });
  }

  // Every not-done step, ordered by position on the trail (root -> summit).
  // Locked steps show exactly what's blocking them by name — no guessing.
  function renderTaskList(goal, pos, inc, numberOf){
    const wrap = document.getElementById('taskList');
    if(!wrap) return;
    wrap.innerHTML = '';

    const byId = {}; goal.steps.forEach(s => byId[s.id] = s);
    const remaining = goal.steps
      .filter(s => s.status !== 'done')
      .sort((a,b) => pos[a.id].row - pos[b.id].row);

    if(!remaining.length){
      if(goal.steps.length){
        wrap.innerHTML = '<div class="taskListDone">Summit reached. Every step is walked.</div>';
      }
      wrap.classList.add('empty-list');
      return;
    }
    wrap.classList.remove('empty-list');

    const title = document.createElement('div');
    title.className = 'taskListTitle';
    const titleText = document.createElement('span');
    titleText.textContent = 'What\'s left to reach the summit';
    title.appendChild(titleText);
    if(goal.steps.length > 1){
      const reorderBtn = document.createElement('button');
      reorderBtn.type = 'button';
      reorderBtn.className = 'reorderTrailBtn';
      reorderBtn.textContent = 'Reorder';
      reorderBtn.addEventListener('click', openReorderSheet);
      title.appendChild(reorderBtn);
    }
    wrap.appendChild(title);

    remaining.forEach(s => {
      const cap = reorderCapabilities(goal, s.id);
      const row = document.createElement('div');
      row.className = 'taskItem ' + s.status;
      row.dataset.stepId = s.id;

      const dot = document.createElement('span');
      dot.className = 'taskDot';
      row.appendChild(dot);

      const num = document.createElement('span');
      num.className = 'taskNum';
      num.textContent = numberOf[s.id] + '.';
      row.appendChild(num);

      const textWrap = document.createElement('div');
      textWrap.className = 'taskText';
      textWrap.addEventListener('click', () => onStepClick(s.id));

      const label = document.createElement('div');
      label.className = 'taskLabel';
      label.textContent = s.label;
      textWrap.appendChild(label);

      if(s.status === 'locked'){
        const preds = inc[s.id].map(pid => byId[pid] && byId[pid].label).filter(Boolean);
        if(preds.length){
          const blocked = document.createElement('div');
          blocked.className = 'taskBlocked';
          blocked.textContent = 'After: ' + preds.join(' + ');
          textWrap.appendChild(blocked);
        }
      } else if(s.status === 'active'){
        const now = document.createElement('div');
        now.className = 'taskNow';
        now.textContent = 'Current step';
        textWrap.appendChild(now);
      }

      row.appendChild(textWrap);

      // reorder controls — only rendered where the move is unambiguous
      const reorderWrap = document.createElement('div');
      reorderWrap.className = 'taskReorder';

      if(cap.canLeft || cap.canRight){
        const leftBtn = document.createElement('button');
        leftBtn.type = 'button';
        leftBtn.className = 'reorderBtn' + (cap.canLeft ? '' : ' disabled');
        leftBtn.innerHTML = '&#8592;';
        leftBtn.setAttribute('aria-label', 'Move earlier in this fork');
        leftBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if(!cap.canLeft) return;
          moveSibling(goal, s.id, -1);
          save(state); render();
        });
        reorderWrap.appendChild(leftBtn);

        const rightBtn = document.createElement('button');
        rightBtn.type = 'button';
        rightBtn.className = 'reorderBtn' + (cap.canRight ? '' : ' disabled');
        rightBtn.innerHTML = '&#8594;';
        rightBtn.setAttribute('aria-label', 'Move later in this fork');
        rightBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if(!cap.canRight) return;
          moveSibling(goal, s.id, 1);
          save(state); render();
        });
        reorderWrap.appendChild(rightBtn);
      }

      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'reorderBtn' + (cap.canEarlier ? '' : ' disabled');
      upBtn.innerHTML = '&#8593;';
      upBtn.setAttribute('aria-label', 'Move step earlier');
      upBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if(!cap.canEarlier) return;
        moveStepEarlier(goal, s.id);
        save(state); render();
      });
      reorderWrap.appendChild(upBtn);

      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'reorderBtn' + (cap.canLater ? '' : ' disabled');
      downBtn.innerHTML = '&#8595;';
      downBtn.setAttribute('aria-label', 'Move step later');
      downBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if(!cap.canLater) return;
        moveStepLater(goal, s.id);
        save(state); render();
      });
      reorderWrap.appendChild(downBtn);

      const dragHandle = document.createElement('span');
      dragHandle.className = 'dragHandle';
      dragHandle.innerHTML = '&#8942;&#8942;';
      dragHandle.setAttribute('aria-label', 'Drag to reorder');
      reorderWrap.appendChild(dragHandle);

      row.appendChild(reorderWrap);
      wrap.appendChild(row);

      attachDragHandlers(row, dragHandle, goal, s.id);
    });
  }

  // Drag-and-drop reordering in the checklist, via pointer events (covers
  // mouse and touch alike). Dragging translates to a number of adjacent
  // "move earlier/later" steps — the same operation the arrow buttons use —
  // so it stops automatically at any fork or merge rather than corrupting
  // the trail. If the drag can't go any further, the row simply won't move
  // past that point.
  const ROW_HEIGHT_ESTIMATE = 54;

  function attachDragHandlers(row, handle, goal, stepId){
    let dragging = false;
    let startY = 0;
    let appliedSteps = 0;

    function onPointerDown(e){
      dragging = true;
      appliedSteps = 0;
      startY = e.clientY;
      row.classList.add('dragging');
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    }

    function onPointerMove(e){
      if(!dragging) return;
      const deltaY = e.clientY - startY;
      const targetSteps = Math.round(deltaY / ROW_HEIGHT_ESTIMATE);
      const diff = targetSteps - appliedSteps;
      if(diff > 0){
        for(let i = 0; i < diff; i++){
          if(moveStepLater(goal, stepId)) appliedSteps++;
          else break;
        }
      } else if(diff < 0){
        for(let i = 0; i < -diff; i++){
          if(moveStepEarlier(goal, stepId)) appliedSteps--;
          else break;
        }
      }
      row.style.transform = `translateY(${appliedSteps * ROW_HEIGHT_ESTIMATE}px)`;
    }

    function onPointerUp(e){
      if(!dragging) return;
      dragging = false;
      row.classList.remove('dragging');
      row.style.transform = '';
      try{ handle.releasePointerCapture(e.pointerId); }catch(err){}
      if(appliedSteps !== 0){
        save(state);
        render();
      }
    }

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerUp);
  }

  function renderGoalRow(){
    const label = document.getElementById('goalDropdownLabel');
    const menu = document.getElementById('goalDropdownMenu');
    const goal = currentGoal();
    label.textContent = goal ? goal.name : 'Select a goal';
    menu.innerHTML = '';

    state.goals.forEach(g => {
      const opt = document.createElement('div');
      opt.className = 'goalOption' + (g.id === state.currentGoalId ? ' active' : '');
      opt.setAttribute('role', 'option');

      const left = document.createElement('span');
      left.className = 'goalOptionName';
      left.textContent = g.name;
      opt.appendChild(left);

      const right = document.createElement('span');
      right.className = 'goalOptionRight';

      const check = document.createElement('span');
      check.className = 'check';
      check.textContent = '✓';
      right.appendChild(check);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'goalDeleteBtn';
      del.setAttribute('aria-label', 'Delete goal: ' + g.name);
      del.innerHTML = '&#128465;';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        closeGoalDropdown();
        openDeleteGoalSheet(g.id);
      });
      right.appendChild(del);

      opt.appendChild(right);
      opt.addEventListener('click', () => {
        state.currentGoalId = g.id;
        save(state);
        closeGoalDropdown();
        render();
      });
      menu.appendChild(opt);
    });

    const divider = document.createElement('div');
    divider.className = 'goalOptionDivider';
    menu.appendChild(divider);

    const addOpt = document.createElement('div');
    addOpt.className = 'goalOption newGoal';
    addOpt.textContent = '+ New goal';
    addOpt.addEventListener('click', () => {
      closeGoalDropdown();
      openGoalSheet();
    });
    menu.appendChild(addOpt);
  }

  function closeGoalDropdown(){
    document.getElementById('goalDropdownMenu').classList.remove('open');
    document.getElementById('goalDropdownBtn').classList.remove('open');
    document.getElementById('goalDropdownBtn').setAttribute('aria-expanded', 'false');
  }

  document.getElementById('goalDropdownBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = document.getElementById('goalDropdownBtn');
    const menu = document.getElementById('goalDropdownMenu');
    const willOpen = !menu.classList.contains('open');
    menu.classList.toggle('open', willOpen);
    btn.classList.toggle('open', willOpen);
    btn.setAttribute('aria-expanded', String(willOpen));
  });

  document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.goalDropdownWrap');
    if(wrap && !wrap.contains(e.target)) closeGoalDropdown();
  });

  // ---------- step click / detail ----------
  let activeDetailId = null;
  function onStepClick(id){
    const goal = currentGoal();
    const step = goal.steps.find(s => s.id === id);
    if(!step) return;
    if(step.status === 'locked'){
      flashLocked(id);
      return;
    }
    activeDetailId = id;
    document.getElementById('detailTitle').textContent = step.label;
    document.getElementById('detailNotes').textContent = step.notes || 'No notes on this step.';
    document.getElementById('toggleDoneBtn').textContent = step.status === 'done' ? 'Mark as not done' : 'Mark done';
    const hasChildren = step.leadsTo.length > 0;
    document.getElementById('deleteRow').style.display = hasChildren ? 'none' : 'flex';
    document.getElementById('detailSheetBg').classList.add('open');
  }

  function flashLocked(id){
    const goal = currentGoal();
    const step = goal.steps.find(s => s.id === id);
    document.getElementById('detailTitle').textContent = step.label;
    document.getElementById('detailNotes').textContent = 'Still ahead — finish the step(s) leading here first.';
    document.getElementById('toggleDoneBtn').style.display = 'none';
    document.getElementById('deleteRow').style.display = 'none';
    document.getElementById('detailSheetBg').classList.add('open');
    activeDetailId = null;
  }

  document.getElementById('closeDetailBtn').addEventListener('click', () => {
    document.getElementById('detailSheetBg').classList.remove('open');
    document.getElementById('toggleDoneBtn').style.display = 'block';
  });

  document.getElementById('toggleDoneBtn').addEventListener('click', () => {
    if(!activeDetailId) return;
    const goal = currentGoal();
    const step = goal.steps.find(s => s.id === activeDetailId);
    step.status = step.status === 'done' ? 'active' : 'done';
    save(state);
    document.getElementById('detailSheetBg').classList.remove('open');
    render();
  });

  document.getElementById('deleteStepBtn').addEventListener('click', () => {
    if(!activeDetailId) return;
    const goal = currentGoal();
    goal.steps = goal.steps.filter(s => s.id !== activeDetailId);
    goal.steps.forEach(s => { s.leadsTo = s.leadsTo.filter(id => id !== activeDetailId); });
    save(state);
    document.getElementById('detailSheetBg').classList.remove('open');
    render();
  });

  // ---------- add step sheet ----------
  const stepSheetBg = document.getElementById('stepSheetBg');
  document.getElementById('fab').addEventListener('click', openStepSheet);
  document.getElementById('cancelStepBtn').addEventListener('click', () => stepSheetBg.classList.remove('open'));

  function openStepSheet(){
    const goal = currentGoal();
    document.getElementById('stepLabelInput').value = '';
    document.getElementById('stepNotesInput').value = '';
    const list = document.getElementById('predList');
    list.innerHTML = '';
    const lastActive = [...goal.steps].reverse().find(s => s.status === 'active' || s.status === 'done');
    goal.steps.forEach(s => {
      const wrap = document.createElement('label');
      wrap.className = 'predItem';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = s.id;
      if(lastActive && s.id === lastActive.id) cb.checked = true;
      const span = document.createElement('span');
      span.textContent = s.label + (s.status === 'done' ? ' ✓' : '');
      wrap.appendChild(cb); wrap.appendChild(span);
      list.appendChild(wrap);
    });
    stepSheetBg.classList.add('open');
  }

  document.getElementById('saveStepBtn').addEventListener('click', () => {
    const label = document.getElementById('stepLabelInput').value.trim();
    if(!label) return;
    const notes = document.getElementById('stepNotesInput').value.trim();
    const preds = [...document.querySelectorAll('#predList input:checked')].map(i => i.value);
    const goal = currentGoal();
    const newId = uid();
    const byId = {}; goal.steps.forEach(s => byId[s.id] = s);
    const allDone = preds.length > 0 && preds.every(pid => byId[pid] && byId[pid].status === 'done');
    const status = preds.length === 0 ? 'active' : (allDone ? 'active' : 'locked');
    goal.steps.push({ id:newId, label, notes, status, leadsTo:[] });
    preds.forEach(pid => { byId[pid].leadsTo.push(newId); });
    save(state);
    stepSheetBg.classList.remove('open');
    render();
  });

  // ---------- new goal sheet ----------
  const goalSheetBg = document.getElementById('goalSheetBg');
  function openGoalSheet(){
    document.getElementById('newGoalInput').value = '';
    goalSheetBg.classList.add('open');
  }
  document.getElementById('cancelGoalBtn').addEventListener('click', () => goalSheetBg.classList.remove('open'));
  document.getElementById('saveGoalBtn').addEventListener('click', () => {
    const name = document.getElementById('newGoalInput').value.trim();
    if(!name) return;
    const g = defaultGoal(name);
    state.goals.push(g);
    state.currentGoalId = g.id;
    save(state);
    goalSheetBg.classList.remove('open');
    render();
  });

  // ---------- delete goal sheet ----------
  const deleteGoalSheetBg = document.getElementById('deleteGoalSheetBg');
  let activeDeleteGoalId = null;

  function openDeleteGoalSheet(goalId){
    const goal = state.goals.find(g => g.id === goalId);
    if(!goal) return;
    activeDeleteGoalId = goalId;
    document.getElementById('deleteGoalName').textContent = goal.name;
    const reasonInput = document.getElementById('deleteGoalReason');
    reasonInput.value = 'Made in error';
    document.getElementById('deleteGoalError').style.display = 'none';
    deleteGoalSheetBg.classList.add('open');
  }

  document.getElementById('cancelDeleteGoalBtn').addEventListener('click', () => {
    deleteGoalSheetBg.classList.remove('open');
    activeDeleteGoalId = null;
  });

  document.querySelectorAll('.reasonChip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.getElementById('deleteGoalReason').value = chip.dataset.reason;
    });
  });

  document.getElementById('confirmDeleteGoalBtn').addEventListener('click', () => {
    if(!activeDeleteGoalId) return;
    const reason = document.getElementById('deleteGoalReason').value.trim();
    if(!reason){
      document.getElementById('deleteGoalError').style.display = 'block';
      return;
    }
    const idx = state.goals.findIndex(g => g.id === activeDeleteGoalId);
    if(idx === -1) return;
    const goal = state.goals[idx];

    if(!state.discardedGoals) state.discardedGoals = [];
    state.discardedGoals.push({
      name: goal.name,
      reason,
      deletedAt: Date.now(),
      stepCount: goal.steps.length,
      doneCount: goal.steps.filter(s => s.status === 'done').length
    });

    state.goals.splice(idx, 1);

    if(state.currentGoalId === activeDeleteGoalId){
      if(state.goals.length){
        state.currentGoalId = state.goals[0].id;
      } else {
        const fresh = defaultGoal('My first ascent');
        state.goals.push(fresh);
        state.currentGoalId = fresh.id;
      }
    }

    save(state);
    deleteGoalSheetBg.classList.remove('open');
    activeDeleteGoalId = null;
    render();
  });

  // ---------- reorder trail sheet ----------
  const reorderSheetBg = document.getElementById('reorderSheetBg');

  function openReorderSheet(){
    const goal = currentGoal();
    const { numberOf } = computeLayout(goal);
    const list = document.getElementById('reorderList');
    list.innerHTML = '';

    const sorted = [...goal.steps].sort((a,b) => numberOf[a.id] - numberOf[b.id]);
    sorted.forEach(s => {
      const row = document.createElement('div');
      row.className = 'reorderRow';
      row.dataset.stepId = s.id;

      const input = document.createElement('input');
      input.type = 'number';
      input.min = '1';
      input.max = String(goal.steps.length);
      input.value = numberOf[s.id];
      input.addEventListener('focus', () => input.select());

      const span = document.createElement('span');
      span.textContent = s.label + (s.status === 'done' ? ' ✓' : '');

      row.appendChild(input);
      row.appendChild(span);
      list.appendChild(row);
    });

    reorderSheetBg.classList.add('open');
  }

  document.getElementById('cancelReorderBtn').addEventListener('click', () => {
    reorderSheetBg.classList.remove('open');
  });

  document.getElementById('applyReorderBtn').addEventListener('click', () => {
    const goal = currentGoal();
    const rows = [...document.querySelectorAll('#reorderList .reorderRow')];
    if(!rows.length) return;

    const byId = {}; goal.steps.forEach(s => byId[s.id] = s);
    const entries = rows.map((row, idx) => {
      const raw = parseFloat(row.querySelector('input').value);
      return { id: row.dataset.stepId, num: Number.isFinite(raw) ? raw : idx + 1, tiebreak: idx };
    });
    entries.sort((a, b) => (a.num - b.num) || (a.tiebreak - b.tiebreak));

    for(let i = 0; i < entries.length; i++){
      const step = byId[entries[i].id];
      step.leadsTo = (i < entries.length - 1) ? [entries[i + 1].id] : [];
    }

    save(state);
    reorderSheetBg.classList.remove('open');
    render();
  });

  render();
  if(document.fonts && document.fonts.ready){ document.fonts.ready.then(() => render()); }
})();
