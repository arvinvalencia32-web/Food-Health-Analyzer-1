(function(){
  'use strict';

  // ============ ENDPOINT ============
  const ENDPOINT = 'https://oxford.uk.eu.org/ai/oxford';
  const TIMEOUT_MS = 75000;

  // ============ HELPERS ============
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = n => { const r = Math.abs(n) >= 10 ? Math.round(n) : Math.round(n * 10) / 10; return String(r); };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const OZ = 28.3495;

  const store = {
    get(k, d){ try { const v = localStorage.getItem('fha.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v){ try { localStorage.setItem('fha.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } }
  };

  // ============ CONSTANTS ============
  const DV = { protein:50, fat:78, carbs:275, fiber:28, sodium:2300, sugar:50 };
  const DIETS = [
    { id:'highprotein', label:'High protein', test: f => f.protein >= 15 },
    { id:'lowsodium',   label:'Low sodium',   test: f => f.sodium <= 140 },
    { id:'lowcarb',     label:'Low carb',     test: f => f.carbs <= 15 },
    { id:'vegetarian',  label:'Vegetarian',   test: f => f.vegetarian === true }
  ];
  const ALLERGENS = ['fish','shellfish','peanuts','tree nuts','dairy','eggs','gluten','soy','sesame'];
  const GRADE_SCORE = { 'A+':97, 'A':92, 'B+':84, 'B':76, 'C':60, 'D':40 };
  const CMP_ROWS = [
    ['Calories','calories','kcal','low'], ['Protein','protein','g','high'], ['Carbs','carbs','g','low'],
    ['Fat','fat','g','low'], ['Sugar','sugar','g','low'], ['Sodium','sodium','mg','low'], ['Fiber','fiber','g','high']
  ];

  // ============ STATE ============
  const prefs = Object.assign({ goal:2000, diets:[], allergens:[], unit:'g', theme:'dark' }, store.get('prefs', {}));
  let logs = store.get('log', {});
  let favs = store.get('favs', []);
  let hist = store.get('hist', []);
  let currentFood = null;
  let grams = 100;
  let currentImageFile = null;
  let plate = [];
  const cmp = { A:null, B:null };

  const todayKey = () => new Date().toLocaleDateString('en-CA');
  const todayLog = () => logs[todayKey()] || [];
  const savePrefs = () => store.set('prefs', prefs);

  // ============ CHANNELS (busy / error UI) ============
  const CH = {};
  ['text','image','cmpA','cmpB'].forEach(k => {
    CH[k] = {
      status:$(k + 'Status'), err:$(k + 'Err'), errText:$(k + 'ErrText'),
      btn:$(k === 'text' ? 'textBtn' : k === 'image' ? 'imageBtn' : k + 'Btn'), ctrl:null
    };
    $(k + 'Cancel').addEventListener('click', () => { if(CH[k].ctrl) CH[k].ctrl.abort(); });
  });
  function setBusy(k, busy){ CH[k].btn.disabled = busy; CH[k].status.classList.toggle('show', busy); }
  function showErr(k, msg){ CH[k].errText.textContent = msg; CH[k].err.classList.add('show'); }
  function hideErr(k){ CH[k].err.classList.remove('show'); }

  // ============ PROMPTS ============
  const FOOD_FIELDS =
    '"name":"string","category":"Fruit|Vegetable|Protein|Grain|Dairy|Nut|Dish|Snack|Beverage",' +
    '"calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,' +
    '"sodium":number,"vitaminC":number,"potassium":number,"score":number,' +
    '"grade":"A+|A|B+|B|C|D","gradeLabel":"Superfood|Excellent|Good|Moderate|Limit","vegetarian":boolean,' +
    '"allergens":["fish","shellfish","peanuts","tree nuts","dairy","eggs","gluten","soy","sesame"],' +
    '"swaps":[{"name":"string","grade":"A+|A|B+|B","note":"short reason"}],' +
    '"insight":"one short sentence about health impact"';
  const FOOD_RULES =
    'Rules: all nutrient values are per 100g (sodium, vitaminC and potassium in mg). ' +
    '"score" is a health score from 0 to 100. "allergens" lists only the allergens that apply, otherwise []. ' +
    '"swaps" lists up to 3 healthier alternatives, or [] if the grade is A+ or A. ';

  function buildPrompt(foodHint){
    const hint = foodHint ? ` The user typed: "${foodHint}".` : '';
    return 'You are a nutrition analyzer. Identify the food item' + hint + '\n\n' +
      'Reply with ONLY a valid JSON object, no markdown, no code fences, using exactly this shape:\n{' + FOOD_FIELDS + '}\n' +
      FOOD_RULES + 'If you cannot identify the food, reply with ONLY: {"error":"Could not identify food"}';
  }
  function buildImagePrompt(){
    return 'You are a nutrition analyzer. Identify every distinct food visible in the photo (at most 6).\n\n' +
      'Reply with ONLY a valid JSON object, no markdown, no code fences, using exactly this shape:\n' +
      '{"items":[{' + FOOD_FIELDS + ',"grams":number}]}\n' + FOOD_RULES +
      '"grams" is your estimate of the visible portion in grams. ' +
      'If you cannot identify any food, reply with ONLY: {"error":"Could not identify food"}';
  }

  function extractJson(text){
    const t = String(text).replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();
    const s = t.indexOf('{'), e = t.lastIndexOf('}');
    if(s < 0 || e <= s) return null;
    try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
  }

  function normalizeFood(o){
    const num = v => (typeof v === 'number' && isFinite(v)) ? v : 0;
    const grade = String(o.grade || 'C');
    const swaps = Array.isArray(o.swaps) ? o.swaps.slice(0, 3).map(s => ({
      name:String((s && s.name) || ''), grade:String((s && s.grade) || ''), note:String((s && s.note) || '')
    })).filter(s => s.name) : [];
    return {
      name:String(o.name || 'Unknown food'), category:String(o.category || 'Food'),
      calories:num(o.calories), protein:num(o.protein), carbs:num(o.carbs), fat:num(o.fat),
      fiber:num(o.fiber), sugar:num(o.sugar), sodium:num(o.sodium),
      vitaminC:num(o.vitaminC), potassium:num(o.potassium),
      score:clamp(Math.round(num(o.score)) || GRADE_SCORE[grade] || 60, 0, 100),
      grade, gradeLabel:String(o.gradeLabel || 'Moderate'),
      vegetarian:typeof o.vegetarian === 'boolean' ? o.vegetarian : null,
      allergens:Array.isArray(o.allergens) ? o.allergens.map(a => String(a).toLowerCase()) : [],
      swaps, insight:String(o.insight || 'No insight available.')
    };
  }

  const toneOf = g => /^(A|B\+)/.test(g) ? 'tone-good' : g === 'B' ? 'tone-mid' : 'tone-bad';
  const gradeFromScore = s => s >= 95 ? 'A+' : s >= 88 ? 'A' : s >= 80 ? 'B+' : s >= 70 ? 'B' : s >= 50 ? 'C' : 'D';
  function setGrade(el, grade){ el.textContent = grade; el.classList.remove('tone-good','tone-mid','tone-bad'); el.classList.add(toneOf(grade)); }

  // ============ CORE REQUEST ============
  async function callEndpoint({ ch, formData, jsonBody }){
    hideErr(ch);
    setBusy(ch, true);
    const controller = new AbortController();
    CH[ch].ctrl = controller;
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const opts = { method:'POST', signal:controller.signal };
      if(formData) opts.body = formData;
      else { opts.headers = { 'Content-Type':'application/json' }; opts.body = JSON.stringify(jsonBody); }

      const res = await fetch(ENDPOINT, opts);
      clearTimeout(timer);
      let data = null;
      try { data = await res.json(); } catch { data = null; }

      if(!res.ok){
        const rawMsg = (data && data.error) ? data.error : '';
        let msg;
        if(/philippin|location|access denied|verify/i.test(rawMsg)){
          msg = 'This service is available only to visitors inside the Philippines. '
              + 'If you are in the Philippines, please turn off any VPN, proxy, or private-relay '
              + 'and make sure your connection uses a Philippine IP.';
        } else if(res.status === 403){
          msg = 'Access denied. This service is available only in the Philippines. '
              + 'If you are in the Philippines, disable any VPN or proxy and try again.';
        } else if(res.status === 413){
          msg = 'Image or text is too large. Try a smaller photo or shorter text.';
        } else if(res.status === 415){
          msg = 'Unsupported file type. Please use JPG, PNG, GIF, or WebP.';
        } else if(res.status === 429){
          msg = 'Too many requests. Please wait a minute and try again.';
        } else if(res.status === 502 || res.status === 503){
          msg = 'The service is temporarily unavailable or your location could not be verified. Please try again shortly.';
        } else {
          msg = rawMsg || ('Request failed (' + res.status + ').');
        }
        throw new Error(msg);
      }
      if(!data || typeof data.reply !== 'string') throw new Error('Unexpected response from the analyzer.');
      return data.reply;
    } finally {
      clearTimeout(timer);
      setBusy(ch, false);
      CH[ch].ctrl = null;
    }
  }

  const errMsg = err => err.name === 'AbortError' ? 'Request timed out. Please try again.'
    : (err.message || 'Network error. Please check your connection.');

  // Returns parsed object or null (and shows an error) for a reply
  function parseReply(raw, ch){
    const p = extractJson(raw);
    if(p && p.error){ showErr(ch, 'Could not identify that food. Try another photo or search by name.'); return null; }
    if(!p){ showErr(ch, 'Could not read the analysis. Please try again or search by name.'); return null; }
    return p;
  }

  async function analyzeName(ch, name){
    try {
      const reply = await callEndpoint({ ch, jsonBody:{ messages:[{ role:'user', content:buildPrompt(name) }], max_tokens:900 } });
      const p = parseReply(reply, ch);
      if(!p) return null;
      if(typeof p.name === 'string' && p.name.trim()) return normalizeFood(p);
      showErr(ch, 'Could not identify that food. Try another search.');
      return null;
    } catch(err){ showErr(ch, errMsg(err)); return null; }
  }

  // ============ VIEWS ============
  const views = ['search','photo','compare','today'];
  function setView(name){
    document.querySelectorAll('.navbtn').forEach(b => {
      const on = b.dataset.view === name;
      b.classList.toggle('active', on); b.setAttribute('aria-selected', on);
    });
    views.forEach(v => $('view-' + v).classList.toggle('active', v === name));
    if(name === 'today') renderToday();
    if(name === 'compare') renderCompare();
    syncResult(name);
  }
  function currentView(){ return (document.querySelector('.navbtn.active') || {}).dataset.view || 'search'; }
  function syncResult(name){
    const v = name || currentView();
    const resultView = v === 'search' || v === 'photo';
    $('result').hidden = !(resultView && currentFood);
    $('emptyState').hidden = !(resultView && !currentFood && !(v === 'photo' && plate.length));
  }
  document.querySelectorAll('.navbtn').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));

  // ============ PREFS UI ============
  function chipHtml(label, pressed, attrs){
    return `<button type="button" class="chip" aria-pressed="${pressed}" ${attrs}>${esc(label)}</button>`;
  }
  function renderPrefs(){
    const dietHtml = DIETS.map(d => chipHtml(d.label, prefs.diets.includes(d.id), `data-diet="${d.id}"`)).join('');
    $('dietFilters').innerHTML = dietHtml;
    $('dietPrefs').innerHTML = dietHtml;
    $('allergenPrefs').innerHTML = ALLERGENS.map(a => chipHtml(a.charAt(0).toUpperCase() + a.slice(1), prefs.allergens.includes(a), `data-allergen="${a}"`)).join('');
    $('goalInput').value = prefs.goal;
  }
  function toggleIn(arr, v){ const i = arr.indexOf(v); if(i >= 0) arr.splice(i, 1); else arr.push(v); }
  document.addEventListener('click', e => {
    const d = e.target.closest('[data-diet]');
    if(d){ toggleIn(prefs.diets, d.dataset.diet); savePrefs(); renderPrefs(); if(currentFood) renderTags(); return; }
    const a = e.target.closest('[data-allergen]');
    if(a){ toggleIn(prefs.allergens, a.dataset.allergen); savePrefs(); renderPrefs(); if(currentFood) renderTags(); }
  });
  $('goalInput').addEventListener('change', () => {
    prefs.goal = clamp(parseInt($('goalInput').value, 10) || 2000, 800, 6000);
    $('goalInput').value = prefs.goal; savePrefs(); renderStrip(); renderToday();
  });

  // ============ THEME + UNITS ============
  function applyTheme(){
    document.documentElement.setAttribute('data-theme', prefs.theme);
    const next = prefs.theme === 'dark' ? 'Light' : 'Dark';
    $('themeBtn').textContent = next;
    $('themeBtn').setAttribute('aria-label', 'Switch to ' + next.toLowerCase() + ' theme');
  }
  $('themeBtn').addEventListener('click', () => { prefs.theme = prefs.theme === 'dark' ? 'light' : 'dark'; savePrefs(); applyTheme(); });

  function applyUnit(){
    document.querySelectorAll('[data-unit]').forEach(b => b.setAttribute('aria-pressed', b.dataset.unit === prefs.unit));
    $('unitLbl').textContent = prefs.unit;
    showServing();
  }
  document.querySelectorAll('[data-unit]').forEach(b => b.addEventListener('click', () => {
    prefs.unit = b.dataset.unit; savePrefs(); applyUnit(); renderPlate();
  }));

  // ============ RESULT ============
  function showServing(){
    const v = prefs.unit === 'oz' ? Math.round(grams / OZ * 10) / 10 : Math.round(grams);
    $('servingInput').value = v;
    $('servingInput').step = prefs.unit === 'oz' ? '0.1' : '1';
  }
  function setGrams(g){ grams = clamp(Math.round(g), 1, 2000); showServing(); updateNutrients(); }
  $('servingInput').addEventListener('input', () => {
    const v = parseFloat($('servingInput').value);
    if(!isFinite(v) || v <= 0) return;
    grams = clamp(Math.round(prefs.unit === 'oz' ? v * OZ : v), 1, 2000);
    updateNutrients();
  });
  $('servingInput').addEventListener('change', showServing);
  $('servMinus').addEventListener('click', () => setGrams(grams - (prefs.unit === 'oz' ? OZ / 2 : 10)));
  $('servPlus').addEventListener('click', () => setGrams(grams + (prefs.unit === 'oz' ? OZ / 2 : 10)));

  function breakdown(f){
    return [
      ['Protein', clamp(Math.round(f.protein / 20 * 100), 0, 100)],
      ['Low sugar', clamp(Math.round(100 - f.sugar * 6), 0, 100)],
      ['Low sodium', clamp(Math.round(100 - f.sodium / 10), 0, 100)],
      ['Fiber', clamp(Math.round(f.fiber / 6 * 100), 0, 100)]
    ];
  }

  function renderTags(){
    const f = currentFood; if(!f) return;
    const flagged = f.allergens.filter(a => prefs.allergens.includes(a));
    $('allergenRow').innerHTML = f.allergens.length
      ? '<span>Allergens</span>' + f.allergens.map(a => `<span class="tag ${flagged.includes(a) ? 'bad' : 'warn'}">${esc(a)}</span>`).join('')
      : '';
    const w = $('allergenWarn');
    w.hidden = !flagged.length;
    w.textContent = flagged.length ? 'Contains ' + flagged.join(', ') + ', which you flagged.' : '';
    $('fitRow').innerHTML = prefs.diets.length
      ? '<span>Your diet</span>' + prefs.diets.map(id => {
          const d = DIETS.find(x => x.id === id); const ok = d.test(f);
          return `<span class="tag ${ok ? '' : 'off'}">${ok ? 'Fits' : 'Not'} ${esc(d.label.toLowerCase())}</span>`;
        }).join('')
      : '';
  }

  function renderFood(food, opts){
    currentFood = food;
    grams = (opts && opts.grams) || 100;
    $('foodName').textContent = food.name;
    $('foodCat').textContent = food.category;
    setGrade($('gradeBadge'), food.grade);
    $('scoreNum').textContent = food.score;
    $('breakdown').innerHTML = breakdown(food).map(([l, v]) =>
      `<div class="dv"><div class="dv-top"><span>${l}</span><b>${v}</b></div><div class="track"><div style="width:${v}%;background:${v >= 60 ? 'var(--accent)' : 'var(--warn)'}"></div></div></div>`).join('');
    $('insightText').textContent = food.insight;
    const showSwaps = food.swaps.length && !/^A/.test(food.grade);
    $('swapsCard').hidden = !showSwaps;
    $('swapsList').innerHTML = showSwaps
      ? food.swaps.map(s => `<li><span>${esc(s.name)}<br><span class="muted">${esc(s.note)}</span></span><b>${esc(s.grade)}</b></li>`).join('') : '';
    syncFav();
    renderTags();
    showServing();
    updateNutrients();
    pushHistory(food);
    syncResult();
    $('result').scrollIntoView({ behavior:'smooth', block:'nearest' });
  }

  function updateNutrients(){
    const f = currentFood; if(!f) return;
    const k = grams / 100;
    $('calVal').textContent = Math.round(f.calories * k).toLocaleString();

    const pCal = f.protein * 4 * k, cCal = f.carbs * 4 * k, fCal = f.fat * 9 * k;
    const total = pCal + cCal + fCal || 1;
    const pP = Math.round(pCal / total * 100), cP = Math.round(cCal / total * 100), fP = Math.max(0, 100 - pP - cP);
    $('barP').style.width = pP + '%'; $('barC').style.width = cP + '%'; $('barF').style.width = fP + '%';
    $('pctP').textContent = pP + '%'; $('pctC').textContent = cP + '%'; $('pctF').textContent = fP + '%';
    $('gP').textContent = fmt(f.protein * k) + ' g'; $('gC').textContent = fmt(f.carbs * k) + ' g'; $('gF').textContent = fmt(f.fat * k) + ' g';

    const dv = [['Protein','protein','var(--accent)'], ['Fiber','fiber','var(--accent)'], ['Fat','fat','var(--bad)'],
                ['Sodium','sodium','var(--warn)'], ['Sugar','sugar','var(--bad)'], ['Carbs','carbs','var(--warn)']];
    $('dvGrid').innerHTML = dv.map(([l, key, col]) => {
      const pct = Math.round(f[key] * k / DV[key] * 100);
      return `<div class="dv"><div class="dv-top"><span>${l}</span><b>${pct}%</b></div><div class="track"><div style="width:${Math.min(100, pct)}%;background:${col}"></div></div></div>`;
    }).join('');

    const rows = [['Fiber','fiber','g'], ['Sugar','sugar','g'], ['Sodium','sodium','mg'], ['Vitamin C','vitaminC','mg'], ['Potassium','potassium','mg']];
    $('nutrientGrid').innerHTML = rows.map(([l, key, u]) =>
      `<div class="nut"><div class="lbl">${l}</div><div class="val">${fmt(f[key] * k)}<span class="unit">${u}</span></div></div>`).join('');
  }

  // ============ FAVORITES + HISTORY ============
  const sameFood = (a, b) => a.name.toLowerCase() === b.name.toLowerCase();
  function syncFav(){
    const on = !!currentFood && favs.some(x => sameFood(x, currentFood));
    $('favBtn').setAttribute('aria-pressed', on);
    $('favBtn').setAttribute('aria-label', on ? 'Remove from favorites' : 'Save to favorites');
  }
  $('favBtn').addEventListener('click', () => {
    if(!currentFood) return;
    if(favs.some(x => sameFood(x, currentFood))) favs = favs.filter(x => !sameFood(x, currentFood));
    else favs.unshift(currentFood);
    store.set('favs', favs); syncFav();
  });
  function pushHistory(food){
    hist = [food].concat(hist.filter(x => !sameFood(x, food))).slice(0, 8);
    store.set('hist', hist);
  }

  // ============ TODAY LOG ============
  function addEntry(food, g){
    const k = g / 100;
    const key = todayKey();
    logs[key] = (logs[key] || []).concat([{
      name:food.name, grams:Math.round(g), kcal:Math.round(food.calories * k),
      p:food.protein * k, c:food.carbs * k, f:food.fat * k
    }]);
    // keep the last 14 days only
    Object.keys(logs).sort().slice(0, -14).forEach(d => delete logs[d]);
    store.set('log', logs);
    renderStrip(); renderToday();
  }
  function flash(btn, text){
    const old = btn.textContent; btn.textContent = text; btn.disabled = true;
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1400);
  }
  $('addBtn').addEventListener('click', () => { if(currentFood){ addEntry(currentFood, grams); flash($('addBtn'), 'Added to today'); } });
  $('compareBtn').addEventListener('click', () => { if(!currentFood) return; cmp.A = currentFood; $('cmpAInput').value = currentFood.name; setView('compare'); });

  function totals(){
    return todayLog().reduce((t, e) => ({ kcal:t.kcal + e.kcal, p:t.p + e.p, c:t.c + e.c, f:t.f + e.f }), { kcal:0, p:0, c:0, f:0 });
  }
  function renderStrip(){
    const t = totals();
    $('stripBar').style.width = clamp(t.kcal / prefs.goal * 100, 0, 100) + '%';
    $('stripEaten').textContent = t.kcal.toLocaleString();
    $('stripGoal').textContent = prefs.goal.toLocaleString();
    const left = prefs.goal - t.kcal;
    $('stripLeft').textContent = left >= 0 ? left.toLocaleString() + ' left' : Math.abs(left).toLocaleString() + ' over';
  }
  function renderToday(){
    const t = totals();
    $('ringArc').setAttribute('stroke-dashoffset', 390 * (1 - clamp(t.kcal / prefs.goal, 0, 1)));
    $('ringNum').textContent = t.kcal.toLocaleString();
    $('ringSub').textContent = 'of ' + prefs.goal.toLocaleString() + ' kcal';
    $('ringSvg').setAttribute('aria-label', t.kcal + ' of ' + prefs.goal + ' calories today');
    const goals = { p:prefs.goal * 0.25 / 4, c:prefs.goal * 0.5 / 4, f:prefs.goal * 0.25 / 9 };
    $('macroGoals').innerHTML = [['Protein','p','var(--c-p)'], ['Carbs','c','var(--c-c)'], ['Fat','f','var(--c-f)']].map(([l, k, col]) =>
      `<div class="dv"><div class="dv-top"><span>${l} ${Math.round(t[k])} / ${Math.round(goals[k])} g</span><b>${Math.round(t[k] / goals[k] * 100)}%</b></div><div class="track"><div style="width:${clamp(t[k] / goals[k] * 100, 0, 100)}%;background:${col}"></div></div></div>`).join('');

    const log = todayLog();
    $('logList').innerHTML = log.length
      ? log.map((e, i) => `<li><span>${esc(e.name)} <span class="muted">${e.grams} g</span></span><span><b>${e.kcal}</b> kcal <button class="x" type="button" data-rm="${i}" aria-label="Remove ${esc(e.name)}">×</button></span></li>`).join('')
      : '<li class="list-empty">Nothing logged yet. Analyze a food and choose Add to today.</li>';

    $('favList').innerHTML = favs.length
      ? favs.map((f, i) => `<button class="chip fav-chip" type="button" data-fav="${i}">${esc(f.name)}</button>`).join('')
      : '<span class="list-empty">Tap the star on a food to save it here.</span>';
    $('histList').innerHTML = hist.length
      ? hist.map((f, i) => `<li><button class="rowbtn" type="button" data-hist="${i}">${esc(f.name)}</button><b>${esc(f.grade)}</b></li>`).join('')
      : '<li class="list-empty">Foods you analyze will show up here.</li>';
  }
  document.addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if(rm){ const key = todayKey(); logs[key].splice(+rm.dataset.rm, 1); store.set('log', logs); renderStrip(); renderToday(); return; }
    const fv = e.target.closest('[data-fav]');
    if(fv){ setView('search'); renderFood(favs[+fv.dataset.fav]); return; }
    const hs = e.target.closest('[data-hist]');
    if(hs){ setView('search'); renderFood(hist[+hs.dataset.hist]); }
  });
  $('clearLog').addEventListener('click', () => { delete logs[todayKey()]; store.set('log', logs); renderStrip(); renderToday(); });

  // ============ TEXT SEARCH ============
  async function analyzeText(){
    const q = $('foodInput').value.trim();
    if(!q){ showErr('text', 'Please enter a food name.'); return; }
    const food = await analyzeName('text', q);
    if(food) renderFood(food);
  }
  $('textBtn').addEventListener('click', analyzeText);
  $('foodInput').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); analyzeText(); } });

  // ============ COMPARE ============
  async function analyzeSlot(slot){
    const q = $('cmp' + slot + 'Input').value.trim();
    const ch = 'cmp' + slot;
    if(!q){ showErr(ch, 'Please enter a food name.'); return; }
    const food = await analyzeName(ch, q);
    if(food){ cmp[slot] = food; renderCompare(); }
  }
  ['A','B'].forEach(s => {
    $('cmp' + s + 'Btn').addEventListener('click', () => analyzeSlot(s));
    $('cmp' + s + 'Input').addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); analyzeSlot(s); } });
  });
  function renderCompare(){
    const out = $('cmpOut');
    if(!cmp.A || !cmp.B){
      out.innerHTML = '<div class="empty">Add two foods to compare them per 100 g.</div>';
      return;
    }
    const A = cmp.A, B = cmp.B;
    let wa = 0, wb = 0;
    const rows = CMP_ROWS.map(([label, key, unit, better]) => {
      const a = A[key], b = B[key];
      let ca = '', cb = '';
      if(a !== b){
        const aWins = better === 'low' ? a < b : a > b;
        if(aWins){ ca = 'win'; wa++; } else { cb = 'win'; wb++; }
      }
      const mark = c => c ? ' <span aria-label="better">▲</span>' : '';
      return `<tr><th scope="row">${label}</th><td class="${ca}">${fmt(a)} ${unit}${mark(ca)}</td><td class="${cb}">${fmt(b)} ${unit}${mark(cb)}</td></tr>`;
    }).join('');
    const head = f => `<span class="gcell">${esc(f.name)} <span class="grade ${toneOf(f.grade)}">${esc(f.grade)}</span></span>`;
    const verdict = wa === wb ? 'It is a tie: each food wins on the same number of nutrients.'
      : (wa > wb ? A.name : B.name) + ' is better on ' + Math.max(wa, wb) + ' of ' + CMP_ROWS.length + ' nutrients.';
    out.innerHTML = `<table class="cmp-table"><thead><tr><th scope="col"><span class="muted" style="font-size:.78rem">Per 100 g</span></th><th scope="col">${head(A)}</th><th scope="col">${head(B)}</th></tr></thead><tbody>${rows}</tbody></table><div class="insight verdict"><b>Verdict.</b> ${esc(verdict)}</div>`;
  }

  // ============ PHOTO ============
  function resizeImage(file, maxSide = 1280, quality = 0.85){
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        const scale = Math.min(1, maxSide / Math.max(width, height));
        width = Math.round(width * scale); height = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not process image.')), 'image/jpeg', quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image file.')); };
      img.src = url;
    });
  }

  const uploadZone = $('uploadZone'), fileInput = $('fileInput'), previewWrap = $('previewWrap'), previewImg = $('previewImg');
  uploadZone.addEventListener('click', () => fileInput.click());
  uploadZone.addEventListener('keydown', e => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); fileInput.click(); } });
  ['dragenter','dragover'].forEach(evt => uploadZone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); uploadZone.classList.add('drag'); }));
  ['dragleave','drop'].forEach(evt => uploadZone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); uploadZone.classList.remove('drag'); }));
  uploadZone.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if(f) handleFile(f); });
  fileInput.addEventListener('change', e => { const f = e.target.files[0]; if(f) handleFile(f); fileInput.value = ''; });

  const ALLOWED = ['image/jpeg','image/png','image/gif','image/webp'];
  const MAX_BYTES = 5 * 1024 * 1024;

  function resetPhotoResults(){
    currentFood = null; plate = [];
    $('plate').hidden = true;
    syncResult();
  }
  async function handleFile(file){
    hideErr('image');
    if(!ALLOWED.includes(file.type)){ showErr('image', 'Please choose a JPG, PNG, GIF, or WebP image.'); return; }
    if(file.size > MAX_BYTES){ showErr('image', 'Image is larger than 5MB. Please choose a smaller photo.'); return; }
    try {
      const resized = await resizeImage(file);
      currentImageFile = new File([resized], 'food.jpg', { type:'image/jpeg' });
      previewImg.src = URL.createObjectURL(currentImageFile);
      uploadZone.style.display = 'none';
      previewWrap.classList.add('show');
      resetPhotoResults();
    } catch(err){ showErr('image', err.message || 'Could not process this image.'); }
  }
  $('changeBtn').addEventListener('click', () => fileInput.click());
  $('removeBtn').addEventListener('click', () => {
    currentImageFile = null; previewImg.src = '';
    previewWrap.classList.remove('show');
    uploadZone.style.display = 'block';
    hideErr('image'); resetPhotoResults();
  });

  async function analyzeImage(){
    if(!currentImageFile){ showErr('image', 'Please choose a photo first.'); return; }
    try {
      const form = new FormData();
      form.append('message', buildImagePrompt());
      form.append('image', currentImageFile, 'food.jpg');
      const reply = await callEndpoint({ ch:'image', formData:form });
      const p = parseReply(reply, 'image');
      if(!p) return;
      let items = Array.isArray(p.items) ? p.items : (typeof p.name === 'string' ? [p] : []);
      items = items.filter(i => i && typeof i.name === 'string' && i.name.trim()).slice(0, 6);
      if(!items.length){ showErr('image', 'Could not identify that food. Try another photo or search by name.'); return; }
      const foods = items.map(i => ({ food:normalizeFood(i), grams:clamp(Math.round(i.grams) || 100, 1, 2000), on:true }));
      if(foods.length === 1){
        plate = []; $('plate').hidden = true;
        renderFood(foods[0].food, { grams:foods[0].grams });
      } else {
        currentFood = null; plate = foods;
        renderPlate();
        syncResult();
      }
    } catch(err){ showErr('image', errMsg(err)); }
  }
  $('imageBtn').addEventListener('click', analyzeImage);

  function renderPlate(){
    if(!plate.length){ $('plate').hidden = true; return; }
    $('plate').hidden = false;
    const unitG = g => prefs.unit === 'oz' ? Math.round(g / OZ * 10) / 10 : Math.round(g);
    $('plateList').innerHTML = plate.map((it, i) =>
      `<li><label><input type="checkbox" data-pc="${i}" ${it.on ? 'checked' : ''}> ${esc(it.food.name)}</label>` +
      `<span><input class="gin" type="number" min="0.1" step="${prefs.unit === 'oz' ? '0.1' : '1'}" data-pg="${i}" value="${unitG(it.grams)}" aria-label="Portion of ${esc(it.food.name)} in ${prefs.unit}"> ${prefs.unit}</span>` +
      `<b>${Math.round(it.food.calories * it.grams / 100)} kcal</b></li>`).join('');
    updatePlateTotals();
  }
  function updatePlateTotals(){
    const on = plate.filter(i => i.on);
    const t = on.reduce((a, i) => { const k = i.grams / 100, f = i.food;
      return { kcal:a.kcal + f.calories * k, p:a.p + f.protein * k, c:a.c + f.carbs * k, f:a.f + f.fat * k, sw:a.sw + f.score * f.calories * k, w:a.w + f.calories * k }; },
      { kcal:0, p:0, c:0, f:0, sw:0, w:0 });
    $('plateKcal').textContent = Math.round(t.kcal).toLocaleString();
    $('plateMacros').textContent = 'Protein ' + fmt(t.p) + ' g, carbs ' + fmt(t.c) + ' g, fat ' + fmt(t.f) + ' g';
    const score = t.w ? t.sw / t.w : (on.length ? on.reduce((a, i) => a + i.food.score, 0) / on.length : 0);
    setGrade($('plateGrade'), on.length ? gradeFromScore(score) : '–');
    $('plateAdd').disabled = !on.length;
  }
  $('plateList').addEventListener('change', e => {
    const c = e.target.dataset.pc, g = e.target.dataset.pg;
    if(c !== undefined){ plate[+c].on = e.target.checked; renderPlate(); }
    if(g !== undefined){
      const v = parseFloat(e.target.value);
      if(isFinite(v) && v > 0) plate[+g].grams = clamp(Math.round(prefs.unit === 'oz' ? v * OZ : v), 1, 2000);
      renderPlate();
    }
  });
  $('plateAdd').addEventListener('click', () => {
    plate.filter(i => i.on).forEach(i => addEntry(i.food, i.grams));
    flash($('plateAdd'), 'Added to today');
  });

  // ============ SAMPLES ============
  document.querySelectorAll('.chip[data-sample]').forEach(chip => {
    chip.addEventListener('click', async () => {
      const emojiMap = { apple:'🍎', friedchicken:'🍗', pizza:'🍕', salmon:'🐟', broccoli:'🥦' };
      const emoji = emojiMap[chip.dataset.sample] || '🍽️';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="#eef5f1"/><text x="240" y="200" font-size="150" text-anchor="middle">${emoji}</text></svg>`;
      try {
        const resized = await resizeImage(new Blob([svg], { type:'image/svg+xml' }));
        currentImageFile = new File([resized], 'sample.jpg', { type:'image/jpeg' });
        previewImg.src = URL.createObjectURL(currentImageFile);
        uploadZone.style.display = 'none';
        previewWrap.classList.add('show');
        hideErr('image');
        analyzeImage();
      } catch { showErr('image', 'Could not load sample. Try uploading a photo.'); }
    });
  });

  // ============ INIT ============
  applyTheme();
  renderPrefs();
  applyUnit();
  renderStrip();
  renderToday();
  setView('search');
})();
