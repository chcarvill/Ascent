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

  // Load shared design tokens (also consumed by other Mission Control apps)
  fetch('js/palette.json')
    .then(r => r.ok ? r.json() : null)
    .then(tokens => {
      if (!tokens) return;
      const root = document.documentElement.style;
      Object.keys(tokens).forEach(key => root.setProperty(`--${key}`, tokens[key]));
    })
    .catch(() => { /* fall back to the CSS defaults already in style.css */ });

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

    return { pos, height, maxRow, order, inc };
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
    const { pos, height, order, inc } = computeLayout(goal);
    svg.setAttribute('viewBox', `0 0 ${WIDTH} ${height}`);
    document.getElementById('trailWrap').style.minHeight = '0';

    // sky
    const grad = el('linearGradient', { id:'sky', x1:'0', y1:'1', x2:'0', y2:'0' }, svg.appendChild(el('defs')));
    el('stop', { offset:'0%', 'stop-color':'#F4F1EA' }, grad);
    el('stop', { offset:'100%', 'stop-color':'#FBEBD3' }, grad);
    el('rect', { x:0, y:0, width:WIDTH, height:height, fill:'url(#sky)' }, svg);

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
      if(s.status === 'done'){ fill = 'var(--pine)'; }
      else if(s.status === 'active'){ fill = 'var(--clay)'; extraClass = 'pulse'; }
      else { fill = '#fff'; stroke = '#B9AE94'; dash = '4 4'; }

      const circle = el('circle', { r:14, fill, class: extraClass }, g);
      if(stroke !== 'none'){ circle.setAttribute('stroke', stroke); circle.setAttribute('stroke-width','2'); if(dash) circle.setAttribute('stroke-dasharray', dash); }

      if(s.status === 'done'){
        el('path', { d:'M -5 0 L -1.5 4 L 6 -5', stroke:'#fff', 'stroke-width':2.2, fill:'none', 'stroke-linecap':'round', 'stroke-linejoin':'round' }, g);
      } else if(s.status === 'locked'){
        el('rect', { x:-4.5, y:-1, width:9, height:7, rx:1.5, fill:'none', stroke:'#B9AE94', 'stroke-width':1.6 }, g);
        el('path', { d:'M -3 -1 L -3 -4 A 3 3 0 0 1 3 -4 L 3 -1', fill:'none', stroke:'#B9AE94', 'stroke-width':1.6 }, g);
      }

      const side = p.lane >= 0 ? 1 : -1;
      const labelX = side * 22;
      const anchor = side === 1 ? 'start' : 'end';
      const t = el('text', { class:'stepLabel', x:labelX, y:4, 'text-anchor':anchor }, g);
      t.textContent = s.label;

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
  }

  function renderGoalRow(){
    const row = document.getElementById('goalRow');
    row.innerHTML = '';
    state.goals.forEach(g => {
      const chip = document.createElement('div');
      chip.className = 'chip' + (g.id === state.currentGoalId ? ' active' : '');
      chip.textContent = g.name;
      chip.addEventListener('click', () => { state.currentGoalId = g.id; save(state); render(); });
      row.appendChild(chip);
    });
    const addChip = document.createElement('div');
    addChip.className = 'chip new';
    addChip.textContent = '+ New goal';
    addChip.addEventListener('click', openGoalSheet);
    row.appendChild(addChip);
  }

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

  render();
})();
