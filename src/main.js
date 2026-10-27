/* Отрисовка, ввод, игровой цикл. Рассчитано на слабые машины:
   - физика всегда фиксированным шагом 60 Гц, поэтому игра идёт одинаково при любом FPS;
     частота отрисовки (ползунок 30-360) влияет только на плавность: вид интерполируется между тактами;
   - уровень один раз рисуется в offscreen-канвас, в кадре перерисовывается только область вокруг куба,
     а если куб не сдвинулся - не рисуется ничего;
   - нет аллокаций в цикле, DOM пишется только при смене текста (раз в секунду);
   - быстрые нажатия клавиш не теряются на низком FPS (защёлка между тактами);
   - FPS по умолчанию авто: равен частоте монитора, а если компьютер не справляется, ступенчато снижается;
   - пауза (кнопка, P, Esc, потеря фокуса, сворачивание вкладки) останавливает цикл целиком и звук. */
(function () {
  'use strict';

  var LP = window.LP, sim = LP.sim;
  var T = sim.T, W = sim.COLS * T, H = sim.ROWS * T, SIZE = sim.SIZE;

  var COLORS = { bg: '#14161c', wall: '#3a4054', spike: '#e5484d', exit: '#3dd68c', pole: '#cfd3dc', cube: '#ffc53d', cubeDark: '#b88a12' };
  var HALF_PI = Math.PI / 2;

  var canvas = document.getElementById('c');
  canvas.width = W; canvas.height = H;
  var ctx = canvas.getContext('2d', { alpha: false });
  var hud = document.getElementById('hud');
  var fpsInput = document.getElementById('fps');
  var fpsLabel = document.getElementById('fpslabel');
  var fpsNum = document.getElementById('fpsnum');
  var fpsAutoBox = document.getElementById('fpsauto');
  var fpsBox = document.getElementById('fpsbox');
  var btnPause = document.getElementById('btnPause');
  var btnRestart = document.getElementById('btnRestart');
  var btnMute = document.getElementById('btnMute');
  var icPause = document.getElementById('icPause'), icPlay = document.getElementById('icPlay');
  var icSoundOn = document.getElementById('icSoundOn'), icSoundOff = document.getElementById('icSoundOff');
  var pauseEl = document.getElementById('pause');
  var padEl = document.getElementById('pad'), padL = document.getElementById('padL'), padR = document.getElementById('padR');
  var jumpEl = document.getElementById('jump');
  var audio = LP.audio;

  var levels = [];
  var i;
  for (i = 0; i < LP.levelDefs.length; i++) levels.push(sim.parseLevel(LP.levelDefs[i]));

  // ---------- кэш уровня ----------
  var cache = document.createElement('canvas');
  cache.width = W; cache.height = H;
  var cctx = cache.getContext('2d', { alpha: false });

  function solidAt(lv, x, y) {
    return x >= 0 && y >= 0 && x < sim.COLS && y < sim.ROWS && lv.grid[y * sim.COLS + x] === sim.SOLID;
  }

  function drawSpike(lv, x, y) {
    var px = x * T, py = y * T, h = 6; // h - зазор: шип в стене или на полу
    // остриё смотрит от соседней стены
    var dx = 0, dy = -1;
    if (solidAt(lv, x, y + 1)) { dx = 0; dy = -1; }
    else if (solidAt(lv, x, y - 1)) { dx = 0; dy = 1; }
    else if (solidAt(lv, x - 1, y)) { dx = 1; dy = 0; }
    else if (solidAt(lv, x + 1, y)) { dx = -1; dy = 0; }
    cctx.beginPath();
    var tipsPerTile = 2, k, bx, by;
    for (k = 0; k < tipsPerTile; k++) {
      var a0 = k * (T / 2), a1 = a0 + T / 2;
      if (dy !== 0) {
        by = dy < 0 ? py + T : py;
        cctx.moveTo(px + a0, by);
        cctx.lineTo(px + (a0 + a1) / 2, by + dy * (T - h));
        cctx.lineTo(px + a1, by);
      } else {
        bx = dx > 0 ? px : px + T;
        cctx.moveTo(bx, py + a0);
        cctx.lineTo(bx + dx * (T - h), py + (a0 + a1) / 2);
        cctx.lineTo(bx, py + a1);
      }
    }
    cctx.fill();
  }

  function buildCache(lv) {
    cctx.fillStyle = COLORS.bg;
    cctx.fillRect(0, 0, W, H);
    cctx.fillStyle = COLORS.wall;
    var x, y, run;
    for (y = 0; y < sim.ROWS; y++) {           // склеиваем горизонтальные участки
      for (x = 0; x < sim.COLS; x++) {
        if (lv.grid[y * sim.COLS + x] !== sim.SOLID) continue;
        run = 1;
        while (x + run < sim.COLS && lv.grid[y * sim.COLS + x + run] === sim.SOLID) run++;
        cctx.fillRect(x * T, y * T, run * T, T);
        x += run - 1;
      }
    }
    cctx.fillStyle = COLORS.spike;
    for (y = 0; y < sim.ROWS; y++) {
      for (x = 0; x < sim.COLS; x++) {
        if (lv.grid[y * sim.COLS + x] === sim.SPIKE) drawSpike(lv, x, y);
      }
    }
    // финиш: флажок на древке, основание на низу клетки
    var fx = lv.ex * T, fy = lv.ey * T;
    cctx.fillStyle = COLORS.pole;
    cctx.fillRect(fx + 6, fy + 1, 2, T - 1);
    cctx.fillRect(fx + 4, fy + T - 2, 6, 2);
    cctx.fillStyle = COLORS.exit;
    cctx.beginPath();
    cctx.moveTo(fx + 8, fy + 2);
    cctx.lineTo(fx + 17, fy + 6);
    cctx.lineTo(fx + 8, fy + 10);
    cctx.fill();
  }

  // ---------- состояние игры ----------
  var levelIdx = 0;
  var lv = levels[0];
  var P = sim.newState();
  var mode = 0;           // 0 игра, 1 смерть, 2 победа
  var modeT = 0;
  var deaths = 0;
  var ticks = 0;          // такты физики на текущем уровне
  var needFull = true;    // перерисовать всё
  var lastRect = { x: 0, y: 0, w: 0, h: 0 };
  var lastHud = '';

  // вид: поворот куба и положение на прошлом такте (для интерполяции), на физику не влияют
  var ang = 0, face = 1, prevAng = 0, prevX = 0, prevY = 0;
  var drawX = -1, drawY = -1, drawAng = 0;   // что нарисовано сейчас, чтобы не рисовать то же самое
  var SPIN = 0.1;         // рад/такт в воздухе

  var NP = 14;
  var ppx = new Float32Array(NP), ppy = new Float32Array(NP), pvx = new Float32Array(NP), pvy = new Float32Array(NP);
  var pLife = 0;

  function loadLevel(n) {
    levelIdx = (n + levels.length) % levels.length;
    lv = levels[levelIdx];
    buildCache(lv);
    restart();
    ticks = 0;
    updateHud();
    try { localStorage.setItem('lowplat.level', String(levelIdx)); } catch (e) {}
  }

  function restart() {
    sim.reset(P, lv);
    mode = 0; pLife = 0; needFull = true;
    ang = 0; face = 1; prevAng = 0; prevX = P.x; prevY = P.y;
  }

  function burst() {
    var k, a;
    pLife = 30;
    for (k = 0; k < NP; k++) {
      a = k * 6.2832 / NP;
      ppx[k] = P.x + SIZE / 2; ppy[k] = P.y + SIZE / 2;
      pvx[k] = Math.cos(a) * (1.5 + (k % 3)) + P.vx * 0.3;
      pvy[k] = Math.sin(a) * (1.5 + (k % 3)) - 1;
    }
  }

  // ---------- ввод (по коду клавиши: работает при любой раскладке; касания - те же клавиши) ----------
  var keys = {};
  var latch = 0;          // клавиши, нажатые и отпущенные между двумя тактами: такт их всё равно увидит
  var KEY_L = { ArrowLeft: 1, KeyA: 1, TouchLeft: 1 };
  var KEY_R = { ArrowRight: 1, KeyD: 1, TouchRight: 1 };
  var KEY_J = { ArrowUp: 1, KeyW: 1, Space: 1, KeyZ: 1, KeyK: 1, TouchJump: 1 };

  function inputBits() {
    var b = latch, k;
    latch = 0;
    for (k in keys) {
      if (!keys[k]) continue;
      if (KEY_L[k]) b |= 1;
      if (KEY_R[k]) b |= 2;
      if (KEY_J[k]) b |= 4;
    }
    return b;
  }

  function setKey(code, down) {
    keys[code] = down;
    if (down) {
      if (KEY_L[code]) latch |= 1;
      if (KEY_R[code]) latch |= 2;
      if (KEY_J[code]) latch |= 4;
    }
  }

  function releaseAll() {
    keys = {}; latch = 0;
    releaseTouch();
  }

  window.addEventListener('keydown', function (e) {
    var c = e.code;
    audio.unlock();
    if (e.target === fpsNum) {              // печатаем число: игровые клавиши не трогаем
      if (c === 'Enter' || c === 'NumpadEnter' || c === 'Escape') fpsNum.blur();
      return;
    }
    if (KEY_L[c] || KEY_R[c] || KEY_J[c] || c === 'KeyR' || c === 'KeyP' || c === 'KeyM' || c === 'BracketLeft' || c === 'BracketRight') e.preventDefault();
    if (e.repeat) return;
    if (c === 'KeyP' || c === 'Escape') { setPaused(!paused); return; }
    if (c === 'KeyM') { toggleMute(); return; }
    if (paused) return;
    setKey(c, true);
    if (c === 'KeyR' && mode === 0) restart();
    else if (c === 'BracketLeft') loadLevel(levelIdx - 1);
    else if (c === 'BracketRight') loadLevel(levelIdx + 1);
  });
  window.addEventListener('keyup', function (e) { keys[e.code] = false; });

  // ---------- касания: слева крестовина (влево/вправо по положению пальца), справа прыжок ----------
  var padPtr = -1, jumpPtr = -1, padNow = '';

  function padSide(e) {
    var r = padEl.getBoundingClientRect();
    return e.clientX < r.left + r.width / 2 ? 'TouchLeft' : 'TouchRight';
  }

  function setPad(side) {
    if (side === padNow) return;
    if (padNow) setKey(padNow, false);
    padNow = side;
    if (side) setKey(side, true);
    padL.className = side === 'TouchLeft' ? 'half on' : 'half';
    padR.className = side === 'TouchRight' ? 'half on' : 'half';
  }

  function setJump(on) {
    setKey('TouchJump', on);
    if (on) jumpEl.classList.add('on'); else jumpEl.classList.remove('on');
  }

  function releaseTouch() {
    padPtr = -1; jumpPtr = -1;
    setPad(''); setJump(false);
  }

  function bindZone(el, isPad) {
    function mine(e) { return e.pointerId === (isPad ? padPtr : jumpPtr); }
    el.addEventListener('pointerdown', function (e) {
      audio.unlock();
      if (paused || (isPad ? padPtr : jumpPtr) !== -1) return;
      if (isPad) { padPtr = e.pointerId; setPad(padSide(e)); } else { jumpPtr = e.pointerId; setJump(true); }
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });
    el.addEventListener('pointermove', function (e) { if (isPad && mine(e)) setPad(padSide(e)); });
    function up(e) {
      if (!mine(e)) return;
      if (isPad) { padPtr = -1; setPad(''); } else { jumpPtr = -1; setJump(false); }
    }
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }
  bindZone(padEl, true);
  bindZone(jumpEl, false);
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  function enableTouch() { document.documentElement.classList.add('touch'); }
  function onFirstTouch() { enableTouch(); window.removeEventListener('touchstart', onFirstTouch); }
  try { if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) enableTouch(); } catch (e) {}
  window.addEventListener('touchstart', onFirstTouch);
  // iOS и часть браузеров разрешают звук только после касания/клика
  window.addEventListener('pointerdown', audio.unlock);
  window.addEventListener('touchend', audio.unlock);

  // ---------- пауза ----------
  var paused = false;

  function setPaused(p) {
    if (p === paused) return;
    paused = p;
    pauseEl.hidden = !p;
    icPause.hidden = p; icPlay.hidden = !p;
    btnPause.title = p ? 'Продолжить (Esc или P)' : 'Пауза (Esc или P)';
    releaseAll();
    if (p) { stop(); audio.suspend(); } else { audio.resume(); start(); }
  }

  btnPause.addEventListener('click', function () { setPaused(!paused); btnPause.blur(); });
  btnRestart.addEventListener('click', function () { if (!paused) restart(); btnRestart.blur(); });
  pauseEl.addEventListener('click', function () { setPaused(false); });
  // потеряли фокус или вкладку: ставим на паузу, чтобы не проиграть уровень в фоне
  window.addEventListener('blur', function () { setPaused(true); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) setPaused(true); });

  // ---------- звук ----------
  var muted = false;
  try { muted = localStorage.getItem('lowplat.mute') === '1'; } catch (e) {}
  audio.setMuted(muted);

  function applyMuteUi() {
    icSoundOn.hidden = muted; icSoundOff.hidden = !muted;
    btnMute.title = muted ? 'Включить звук (M)' : 'Выключить звук (M)';
    btnMute.setAttribute('aria-label', muted ? 'Включить звук' : 'Выключить звук');
  }

  function toggleMute() {
    muted = !muted;
    audio.setMuted(muted);
    try { localStorage.setItem('lowplat.mute', muted ? '1' : '0'); } catch (e) {}
    applyMuteUi();
  }

  btnMute.addEventListener('click', function () { audio.unlock(); toggleMute(); btnMute.blur(); });

  // ---------- такт физики (всегда 60 в секунду) ----------
  function tick() {
    var k;
    if (mode === 0) {
      prevX = P.x; prevY = P.y; prevAng = ang;
      sim.step(P, lv, inputBits());
      ticks++;
      if (P.ev) {
        if (P.ev & sim.EV_JUMP) audio.play('jump');
        if (P.ev & sim.EV_WALL) audio.play('wall');
        if (P.ev & sim.EV_LAND) audio.play('land');
      }
      if (P.vx > 0.3) face = 1; else if (P.vx < -0.3) face = -1;
      if (!P.g && !P.grip) ang += face * SPIN;                  // в воздухе крутится
      else ang += (Math.round(ang / HALF_PI) * HALF_PI - ang) * 0.35; // на земле и на стене встаёт ровно
      if (P.dead) { deaths++; burst(); mode = 1; modeT = 36; updateHud(); audio.play('die'); }
      else if (P.won) { mode = 2; modeT = 40; audio.play('win'); }
    } else if (mode === 1) {
      for (k = 0; k < NP; k++) { ppx[k] += pvx[k]; ppy[k] += pvy[k]; pvy[k] += 0.25; }
      if (pLife > 0) pLife--;
      if (--modeT <= 0) restart();
    } else if (--modeT <= 0) {
      loadLevel(levelIdx + 1);
    }
  }

  // ---------- отрисовка; alpha (0..1) - сколько прошло от прошлого такта к следующему ----------
  function render(alpha) {
    var k, x, y, a, rx, ry, rw, rh;
    if (mode === 1) {
      ctx.drawImage(cache, 0, 0);
      needFull = false; lastRect.w = 0; drawX = -1;
      ctx.fillStyle = COLORS.cube;
      var ps = pLife > 12 ? 4 : 2;
      for (k = 0; k < NP; k++) ctx.fillRect(ppx[k] + pvx[k] * alpha - ps / 2, ppy[k] + pvy[k] * alpha - ps / 2, ps, ps);
      return;
    }
    x = Math.round(prevX + (P.x - prevX) * alpha);
    y = Math.round(prevY + (P.y - prevY) * alpha);
    a = prevAng + (ang - prevAng) * alpha;
    if (!needFull && x === drawX && y === drawY && a === drawAng) return;   // ничего не изменилось
    if (needFull) {
      ctx.drawImage(cache, 0, 0);
      needFull = false;
    } else if (lastRect.w) {
      ctx.drawImage(cache, lastRect.x, lastRect.y, lastRect.w, lastRect.h, lastRect.x, lastRect.y, lastRect.w, lastRect.h);
    }
    drawX = x; drawY = y; drawAng = a;
    if (Math.abs(a - Math.round(a / HALF_PI) * HALF_PI) < 0.02) {   // ровный куб: быстрый путь без сглаживания
      ctx.fillStyle = COLORS.cubeDark;
      ctx.fillRect(x, y, SIZE, SIZE);
      ctx.fillStyle = COLORS.cube;
      ctx.fillRect(x + 2, y + 2, SIZE - 4, SIZE - 4);
    } else {
      var c = Math.cos(a), s = Math.sin(a), h = SIZE / 2;
      ctx.setTransform(c, s, -s, c, x + h, y + h);
      ctx.fillStyle = COLORS.cubeDark;
      ctx.fillRect(-h, -h, SIZE, SIZE);
      ctx.fillStyle = COLORS.cube;
      ctx.fillRect(-h + 2, -h + 2, SIZE - 4, SIZE - 4);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    // повёрнутый куб выступает за свой бокс на ~3 px: запас с каждой стороны 5 px
    rx = Math.max(0, x - 5); ry = Math.max(0, y - 5);
    rw = Math.min(W - rx, SIZE + 10); rh = Math.min(H - ry, SIZE + 10);
    lastRect.x = rx; lastRect.y = ry; lastRect.w = rw; lastRect.h = rh;
  }

  function updateHud() {
    var s = Math.floor(ticks / 60);
    var txt = 'Уровень ' + (levelIdx + 1) + '/' + levels.length + ' · ' + lv.name + ' · смертей: ' + deaths + ' · ' + s + ' с';
    if (txt !== lastHud) { hud.textContent = txt; lastHud = txt; }
  }

  // ---------- частота кадров: авто (по монитору) или вручную ----------
  var FPS_MIN = 30, FPS_MAX = 360;
  var HZ_SNAP = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 200, 240, 280, 300, 360];
  var fpsAuto = true, manualCap = 60;
  var monitorHz = 60, hzSeen = 0;      // частота монитора и последнее измерение (нужны два одинаковых подряд)
  var autoDiv = 1;                     // авто: лимит = герцовка / autoDiv (целые доли дают ровный темп кадров)
  var slowSecs = 0, goodSecs = 0, warm = 0;
  var fpsCap = 60, fpsNow = 0, fpsCount = 0, fpsStamp = 0, nextRender = 0, workSum = 0, workN = 0;
  var dts = new Float32Array(30), dtsSorted = new Float32Array(30), dtN = 0;
  var clock = (window.performance && performance.now) ? function () { return performance.now(); } : function () { return Date.now(); };

  try {
    var savedFps = localStorage.getItem('lowplat.fps');
    if (savedFps !== null && savedFps !== 'auto') {
      var sv = parseInt(savedFps, 10);
      if (sv >= FPS_MIN && sv <= FPS_MAX) { fpsAuto = false; manualCap = sv; fpsCap = sv; }
    }
  } catch (e) {}

  function clampFps(v) { return Math.max(FPS_MIN, Math.min(FPS_MAX, v)); }

  function saveFps() {
    try { localStorage.setItem('lowplat.fps', fpsAuto ? 'auto' : String(manualCap)); } catch (e) {}
  }

  function updateFpsLabel() {
    var txt = 'FPS: ' + (fpsNow || '…') + ' · лимит';
    if (fpsLabel.textContent !== txt) fpsLabel.textContent = txt;
  }

  function syncFpsUi() {
    if (document.activeElement !== fpsNum) fpsNum.value = fpsCap;    // пока печатаешь, поле не трогаем
    fpsInput.value = fpsCap;
    fpsAutoBox.checked = fpsAuto;
    fpsBox.className = fpsAuto ? 'auto' : '';
    updateFpsLabel();
  }

  function resetFpsStats() {
    fpsCount = 0; fpsStamp = 0; fpsNow = 0; workSum = 0; workN = 0;
    slowSecs = 0; goodSecs = 0; warm = 1; nextRender = 0;
  }

  function applyAuto() {
    fpsCap = clampFps(Math.round(monitorHz / autoDiv));
    resetFpsStats();
    syncFpsUi();
  }

  function setManual(v) {
    fpsAuto = false; manualCap = v; fpsCap = v;
    saveFps(); resetFpsStats(); syncFpsUi();
  }

  function setAutoMode(on) {
    fpsAuto = on;
    if (on) { autoDiv = 1; applyAuto(); } else { fpsCap = manualCap; resetFpsStats(); syncFpsUi(); }
    saveFps();
  }

  fpsInput.min = FPS_MIN; fpsInput.max = FPS_MAX; fpsInput.step = 1;
  fpsNum.min = FPS_MIN; fpsNum.max = FPS_MAX; fpsNum.step = 1;

  fpsAutoBox.addEventListener('change', function () { setAutoMode(fpsAutoBox.checked); fpsAutoBox.blur(); });
  fpsInput.addEventListener('input', function () { setManual(clampFps(parseInt(fpsInput.value, 10) || 60)); });
  // число вручную: пока печатаешь, подходящее значение применяется сразу, остальное поправится, когда закончишь
  fpsNum.addEventListener('input', function () {
    var v = parseInt(fpsNum.value, 10);
    if (v >= FPS_MIN && v <= FPS_MAX) setManual(v);
  });
  fpsNum.addEventListener('change', function () {
    var v = clampFps(parseInt(fpsNum.value, 10) || fpsCap);   // пусто или мусор -> прежнее значение, вне границ -> ближайшая граница
    fpsNum.value = v;
    setManual(v);
  });
  // после выбора снимаем фокус с ползунка, чтобы стрелки и пробел управляли игрой, а не им
  fpsInput.addEventListener('change', function () { fpsInput.blur(); });
  fpsInput.addEventListener('pointerup', function () { fpsInput.blur(); });

  // частота монитора: медиана 30 интервалов между кадрами браузера, подгоняется к ближайшей стандартной
  function snapHz(hz) {
    var best = 0, bd = 1e9, k, d;
    for (k = 0; k < HZ_SNAP.length; k++) {
      d = Math.abs(hz - HZ_SNAP[k]) / HZ_SNAP[k];
      if (d < bd) { bd = d; best = HZ_SNAP[k]; }
    }
    return bd < 0.04 ? best : clampFps(Math.round(hz));
  }

  function detectHz() {
    var i2, j, v;
    for (i2 = 0; i2 < 30; i2++) {                 // сортировка вставками: без выделения памяти
      v = dts[i2]; j = i2 - 1;
      while (j >= 0 && dtsSorted[j] > v) { dtsSorted[j + 1] = dtsSorted[j]; j--; }
      dtsSorted[j + 1] = v;
    }
    var hz = snapHz(1000 / dtsSorted[15]);
    if (hz === hzSeen && hz !== monitorHz) { monitorHz = hz; if (fpsAuto) applyAuto(); }
    hzSeen = hz;
  }

  // раз в секунду: если кадры не успевают или кадр занимает больше 60% своего времени, лимит делим на целое число;
  // если 10 секунд всё с запасом, возвращаем обратно
  function autoStep(work) {
    var interval = 1000 / fpsCap;
    if (warm > 0) { warm--; return; }
    if (fpsNow < fpsCap * 0.85 || work > interval * 0.6) { slowSecs++; goodSecs = 0; } else { slowSecs = 0; goodSecs++; }
    if (slowSecs >= 2 && monitorHz / (autoDiv + 1) >= FPS_MIN) { autoDiv++; applyAuto(); }
    else if (goodSecs >= 10 && autoDiv > 1 && work < 300 / Math.round(monitorHz / (autoDiv - 1))) { autoDiv--; applyAuto(); }
  }

  // ---------- цикл ----------
  var STEP = 1000 / 60, acc = 0, last = 0, raf = 0;
  var MAX_TICKS = 15;     // больше тактов за кадр не догоняем (кадр реже ~4 раз в секунду - игра замедлится, а не зависнет)

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!last) last = now;
    var dt = now - last;
    last = now;
    if (dt > 0 && dt < 100) {                 // сырые интервалы между кадрами браузера - для определения герцовки
      dts[dtN++] = dt;
      if (dtN === 30) { detectHz(); dtN = 0; }
    }
    if (dt > 250) dt = 250;
    acc += dt;
    var t0 = clock();
    var n = 0;
    while (acc >= STEP && n < MAX_TICKS) { tick(); acc -= STEP; n++; }
    if (n === MAX_TICKS) acc = 0;
    if (now + 1 >= nextRender) {            // 1 мс запас на дрожание кадров
      var interval = 1000 / fpsCap;
      nextRender += interval;
      if (nextRender < now) nextRender = now + interval;
      render(acc / STEP);
      fpsCount++;
      workSum += clock() - t0; workN++;
    }
    if (!fpsStamp) fpsStamp = now;
    else if (now - fpsStamp >= 1000) {
      fpsNow = Math.round(fpsCount * 1000 / (now - fpsStamp));
      var work = workN ? workSum / workN : 0;
      fpsCount = 0; fpsStamp = now; workSum = 0; workN = 0;
      if (fpsAuto) autoStep(work);
      updateFpsLabel(); updateHud();
    }
  }

  function start() { if (!raf) { last = 0; dtN = 0; resetFpsStats(); raf = requestAnimationFrame(frame); } }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } keys = {}; latch = 0; }

  var saved = 0;
  try { saved = parseInt(localStorage.getItem('lowplat.level'), 10) || 0; } catch (e) {}
  loadLevel(saved);
  applyMuteUi();
  syncFpsUi();
  start();
})();
