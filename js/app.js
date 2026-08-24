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

  function pineTree(parent, x, y, scale){
    scale = scale || 1;
    const g = el('g', { transform: `translate(${x},${y}) scale(${scale})`, opacity: 0.85 }, parent);
    el('rect', { x:-2, y:0, width:4, height:10, fill:'#8B6F47' }, g);
    [0,-9,-17].forEach((dy,i) => {
      el('polygon', {
        points: `0,${dy-16} -13,${dy} 13,${dy}`,
        fill: i % 2 === 0 ? 'var(--pine)' : 'var(--sage)'
      }, g);
    });
  }

  function rockCluster(parent, x, y, scale){
    scale = scale || 1;
    const g = el('g', { transform:`translate(${x},${y}) scale(${scale})`, opacity:0.6 }, parent);
    el('ellipse', { cx:0, cy:0, rx:14, ry:8, fill:'#B9AE94' }, g);
    el('ellipse', { cx:12, cy:3, rx:8, ry:5, fill:'#A79C82' }, g);
  }

  function hikerFigure(parent, x, y){
    const g = el('g', { class:'hiker', transform:`translate(${x},${y})` }, parent);
    el('circle', { cx:0, cy:-30, r:6, fill:'var(--ink)' }, g);
    el('line', { x1:0, y1:-24, x2:0, y2:-8, stroke:'var(--clay)', 'stroke-width':5, 'stroke-linecap':'round' }, g);
    el('line', { x1:0, y1:-8, x2:-6, y2:6, stroke:'var(--ink)', 'stroke-width':4, 'stroke-linecap':'round' }, g);
    el('line', { x1:0, y1:-8, x2:7, y2:5, stroke:'var(--ink)', 'stroke-width':4, 'stroke-linecap':'round' }, g);
    el('line', { x1:0, y1:-20, x2:-9, y2:-13, stroke:'var(--clay)', 'stroke-width':4, 'stroke-linecap':'round' }, g);
    el('line', { x1:0, y1:-20, x2:8, y2:-12, stroke:'var(--clay)', 'stroke-width':4, 'stroke-linecap':'round' }, g);
    el('line', { x1:9, y1:-30, x2:14, y2:2, stroke:'#8B6F47', 'stroke-width':2.5, 'stroke-linecap':'round' }, g);
  }

  function curvePath(x1,y1,x2,y2){
    const midY = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
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

    const svg = document.getElementById('trailSvg');
    svg.innerHTML = '';
    const { pos, height, order, inc, numberOf } = computeLayout(goal);
    svg.setAttribute('viewBox', `0 0 ${WIDTH} ${height}`);
    document.getElementById('trailWrap').style.minHeight = '0';

    // sky
    const grad = el('linearGradient', { id:'sky', x1:'0', y1:'1', x2:'0', y2:'0' }, svg.appendChild(el('defs')));
    el('stop', { offset:'0%', 'stop-color':'#F4F1EA' }, grad);
    el('stop', { offset:'100%', 'stop-color':'#FBEBD3' }, grad);
    el('rect', { x:0, y:0, width:WIDTH, height:height, fill:'url(#sky)' }, svg);

    // background tagline — repeats quietly down the trail so it's visible
    // no matter how far the user has scrolled
    const TAGLINE = 'Make everyday extraordinary.';
    const taglineGap = 460;
    for(let ty = 200; ty < height - 80; ty += taglineGap){
      el('text', {
        x: WIDTH / 2, y: ty, 'text-anchor': 'middle',
        transform: `rotate(-6 ${WIDTH / 2} ${ty})`,
        style: "font-family:'Fraunces',serif; font-style:italic; font-weight:600; font-size:26px;",
        fill: 'var(--pine)', opacity: '0.07'
      }, svg).textContent = TAGLINE;
    }

    const byId = {}; goal.steps.forEach(s => byId[s.id] = s);

    // ground path (drawn first, under everything)
    const pathLayer = el('g', {}, svg);
    goal.steps.forEach(s => {
      s.leadsTo.forEach(childId => {
        if(!pos[childId]) return;
        const p1 = pos[s.id], p2 = pos[childId];
        const d = curvePath(p1.x, p1.y, p2.x, p2.y);
        el('path', { d, stroke:'var(--dirt)', 'stroke-width':16, fill:'none', 'stroke-linecap':'round' }, pathLayer);
        el('path', { d, stroke:'#C6B688', 'stroke-width':2, 'stroke-dasharray':'1 10', fill:'none', 'stroke-linecap':'round', opacity:0.7 }, pathLayer);
      });
    });

    // decorations
    const decoLayer = el('g', {}, svg);
    order.forEach((s, i) => {
      const p = pos[s.id];
      const seedL = (i * 7919) % 100 / 100;
      const seedR = (i * 104729) % 100 / 100;
      if(seedL > 0.4) pineTree(decoLayer, p.x - 44 - seedL*10, p.y + 6, 0.8 + seedL*0.4);
      if(seedR > 0.55) rockCluster(decoLayer, p.x + 40 + seedR*8, p.y + 12, 0.7 + seedR*0.3);
      if(seedL < 0.25) pineTree(decoLayer, p.x + 50, p.y - 20, 0.6);
    });

    // summit
    const rootRow = Math.max(...goal.steps.map(s => pos[s.id].row));
    const tips = goal.steps.filter(s => pos[s.id].row === rootRow);
    const avgX = tips.reduce((sum,s) => sum + pos[s.id].x, 0) / tips.length;
    const summitY = Math.min(...tips.map(s => pos[s.id].y)) - ROW_H * 0.85;
    tips.forEach(s => {
      const p = pos[s.id];
      const d = curvePath(p.x, p.y, avgX, summitY);
      el('path', { d, stroke:'var(--dirt)', 'stroke-width':14, fill:'none', 'stroke-linecap':'round' }, pathLayer);
    });
    const summitG = el('g', { transform:`translate(${avgX},${summitY})` }, svg);
    el('polygon', { points:'0,-34 -28,10 28,10', fill:'var(--sage)', opacity:0.9 }, summitG);
    el('polygon', { points:'0,-34 -12,-6 12,-6', fill:'#fff', opacity:0.85 }, summitG);
    el('line', { x1:16, y1:-34, x2:16, y2:-10, stroke:'var(--ink)', 'stroke-width':2 }, summitG);
    el('polygon', { points:'16,-34 34,-27 16,-20', fill:'var(--gold)' }, summitG);
    const summitText = el('text', { class:'summitLabel', x:0, y:32, 'text-anchor':'middle' }, summitG);
    summitText.textContent = goal.name;

    // steps
    goal.steps.forEach(s => {
      const p = pos[s.id];
      const g = el('g', { class:'marker ' + s.status, transform:`translate(${p.x},${p.y})` }, svg);
      let fill = 'var(--sage)', stroke = 'none', dash = null, extraClass = '';
      let r = 14;
      if(s.status === 'done'){ fill = 'var(--pine)'; }
      else if(s.status === 'active'){ fill = 'var(--clay)'; r = 19; }
      else { fill = '#fff'; stroke = '#B9AE94'; dash = '4 4'; r = 12; }

      if(s.status === 'active'){
        el('circle', { r: r + 6, fill:'var(--clay)', opacity:0.18 }, g);
      }

      const circle = el('circle', { r, fill, class: extraClass }, g);
      if(stroke !== 'none'){ circle.setAttribute('stroke', stroke); circle.setAttribute('stroke-width','2'); if(dash) circle.setAttribute('stroke-dasharray', dash); }

      if(s.status === 'done'){
        el('path', { d:'M -5 0 L -1.5 4 L 6 -5', stroke:'#fff', 'stroke-width':2.2, fill:'none', 'stroke-linecap':'round', 'stroke-linejoin':'round' }, g);
      } else if(s.status === 'locked'){
        el('rect', { x:-4.5, y:-1, width:9, height:7, rx:1.5, fill:'none', stroke:'#B9AE94', 'stroke-width':1.6 }, g);
        el('path', { d:'M -3 -1 L -3 -4 A 3 3 0 0 1 3 -4 L 3 -1', fill:'none', stroke:'#B9AE94', 'stroke-width':1.6 }, g);
      } else if(s.status === 'active'){
        el('circle', { r:3.5, fill:'#fff' }, g);
      }

      const side = p.lane >= 0 ? 1 : -1;
      const labelX = side * (r + 8);
      const anchor = side === 1 ? 'start' : 'end';
      const t = el('text', {
        class: 'stepLabel' + (s.status === 'active' ? ' stepLabelCurrent' : ''),
        x: labelX, y:4, 'text-anchor':anchor
      }, g);
      t.textContent = s.label;

      // step number badge
      const badgeY = -(r + 13);
      el('circle', { cx:0, cy:badgeY, r:9, fill:'#fff', stroke:'var(--line)', 'stroke-width':1 }, g);
      const numText = el('text', {
        x:0, y:badgeY + 3.5, 'text-anchor':'middle',
        style:'font-family:Inter,sans-serif; font-size:9.5px; font-weight:700;',
        fill:'var(--ink)'
      }, g);
      numText.textContent = numberOf[s.id];

      g.addEventListener('click', () => onStepClick(s.id));
    });

    // hiker: furthest 'done' step, else root
    let hikerStep = null, hikerRow = -1;
    goal.steps.forEach(s => {
      if(s.status === 'done' && pos[s.id].row > hikerRow){ hikerRow = pos[s.id].row; hikerStep = s; }
    });
    if(!hikerStep){
      hikerStep = goal.steps.find(s => !inc[s.id].length) || goal.steps[0];
    }
    if(hikerStep){
      const hp = pos[hikerStep.id];
      hikerFigure(svg, hp.x - 28, hp.y - 6);
    }

    if(!goal.steps.length){
      document.getElementById('trailWrap').innerHTML = '<div class="empty">No steps yet. Tap "Add step" to break trail.</div>';
    }

    renderTaskList(goal, pos, inc, numberOf);
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
})();
