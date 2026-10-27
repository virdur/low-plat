/* Отрисовка, ввод, игровой цикл. Рассчитано на слабые машины:
   - уровень один раз рисуется в offscreen-канвас, в кадре перерисовывается только область вокруг куба;
   - фиксированный шаг 60 Гц, при тормозах игра замедляется, а не копит очередь;
   - нет аллокаций в цикле, нет DOM-записей в кадре (HUD обновляется раз в секунду);
   - вкладка в фоне -> цикл стоит. */
(function () {
  'use strict';

  var LP = window.LP, sim = LP.sim;
  var T = sim.T, W = sim.COLS * T, H = sim.ROWS * T, SIZE = sim.SIZE;

  var COLORS = { bg: '#14161c', wall: '#3a4054', spike: '#e5484d', exit: '#3dd68c', cube: '#ffc53d', cubeDark: '#b88a12' };

  var canvas = document.getElementById('c');
  canvas.width = W; canvas.height = H;
  var ctx = canvas.getContext('2d', { alpha: false });
  var hud = document.getElementById('hud');

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
    cctx.fillStyle = COLORS.exit;               // выход: рамка + точка
    cctx.fillRect(lv.ex * T + 2, lv.ey * T + 2, T - 4, T - 4);
    cctx.fillStyle = COLORS.bg;
    cctx.fillRect(lv.ex * T + 5, lv.ey * T + 5, T - 10, T - 10);
  }

  // ---------- состояние игры ----------
  var levelIdx = 0;
  var lv = levels[0];
  var P = sim.newState();
  var mode = 0;           // 0 игра, 1 смерть, 2 победа
  var modeT = 0;
  var deaths = 0;
  var ticks = 0;          // кадры на текущем уровне
  var needFull = true;    // перерисовать всё
  var lastRect = { x: 0, y: 0, w: 0, h: 0 };
  var lastHud = '';

  var NP = 14;
  var ppx = new Float32Array(NP), ppy = new Float32Array(NP), pvx = new Float32Array(NP), pvy = new Float32Array(NP);
  var pLife = 0;

  function loadLevel(n) {
    levelIdx = (n + levels.length) % levels.length;
    lv = levels[levelIdx];
    buildCache(lv);
    restart();
    ticks = 0;
    try { localStorage.setItem('lowplat.level', String(levelIdx)); } catch (e) {}
  }

  function restart() {
    sim.reset(P, lv);
    mode = 0; pLife = 0; needFull = true;
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

  // ---------- ввод (по коду клавиши: работает при любой раскладке) ----------
  var keys = {};
  var KEY_L = { ArrowLeft: 1, KeyA: 1 };
  var KEY_R = { ArrowRight: 1, KeyD: 1 };
  var KEY_J = { ArrowUp: 1, KeyW: 1, Space: 1, KeyZ: 1, KeyK: 1 };

  function inputBits() {
    var b = 0, k;
    for (k in keys) {
      if (!keys[k]) continue;
      if (KEY_L[k]) b |= 1;
      if (KEY_R[k]) b |= 2;
      if (KEY_J[k]) b |= 4;
    }
    return b;
  }

  window.addEventListener('keydown', function (e) {
    var c = e.code;
    if (KEY_L[c] || KEY_R[c] || KEY_J[c] || c === 'KeyR' || c === 'BracketLeft' || c === 'BracketRight') e.preventDefault();
    if (e.repeat) return;
    keys[c] = true;
    if (c === 'KeyR' && mode === 0) restart();
    else if (c === 'BracketLeft') loadLevel(levelIdx - 1);
    else if (c === 'BracketRight') loadLevel(levelIdx + 1);
  });
  window.addEventListener('keyup', function (e) { keys[e.code] = false; });
  window.addEventListener('blur', function () { keys = {}; });

  // ---------- такт ----------
  function tick() {
    var k;
    if (mode === 0) {
      sim.step(P, lv, inputBits());
      ticks++;
      if (P.dead) { deaths++; burst(); mode = 1; modeT = 36; }
      else if (P.won) { mode = 2; modeT = 40; }
    } else if (mode === 1) {
      for (k = 0; k < NP; k++) { ppx[k] += pvx[k]; ppy[k] += pvy[k]; pvy[k] += 0.25; }
      if (pLife > 0) pLife--;
      if (--modeT <= 0) restart();
    } else if (--modeT <= 0) {
      loadLevel(levelIdx + 1);
    }
  }

  // ---------- отрисовка ----------
  function render() {
    var k, x, y, rx, ry, rw, rh;
    if (needFull || mode === 1) {
      ctx.drawImage(cache, 0, 0);
      needFull = false;
      lastRect.w = 0;
    } else if (lastRect.w) {
      ctx.drawImage(cache, lastRect.x, lastRect.y, lastRect.w, lastRect.h, lastRect.x, lastRect.y, lastRect.w, lastRect.h);
    }
    if (mode === 1) {
      ctx.fillStyle = COLORS.cube;
      var s = pLife > 12 ? 4 : 2;
      for (k = 0; k < NP; k++) ctx.fillRect(ppx[k] - s / 2, ppy[k] - s / 2, s, s);
      return;
    }
    x = Math.round(P.x); y = Math.round(P.y);
    ctx.fillStyle = COLORS.cubeDark;
    ctx.fillRect(x, y, SIZE, SIZE);
    ctx.fillStyle = COLORS.cube;
    ctx.fillRect(x + 2, y + 2, SIZE - 4, SIZE - 4);
    rx = Math.max(0, x - 2); ry = Math.max(0, y - 2);
    rw = Math.min(W - rx, SIZE + 4); rh = Math.min(H - ry, SIZE + 4);
    lastRect.x = rx; lastRect.y = ry; lastRect.w = rw; lastRect.h = rh;
  }

  function updateHud() {
    var s = Math.floor(ticks / 60);
    var txt = 'Уровень ' + (levelIdx + 1) + '/' + levels.length + ' · ' + lv.name + ' · смертей: ' + deaths + ' · ' + s + ' с';
    if (txt !== lastHud) { hud.textContent = txt; lastHud = txt; }
  }

  // ---------- цикл ----------
  var STEP = 1000 / 60, acc = 0, last = 0, raf = 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!last) last = now;
    var dt = now - last;
    last = now;
    if (dt > 100) dt = 100;
    acc += dt;
    var n = 0;
    while (acc >= STEP && n < 4) { tick(); acc -= STEP; n++; }
    if (n === 4) acc = 0;
    if (n > 0) { render(); updateHud(); }
  }

  function start() { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } keys = {}; }
  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });

  var saved = 0;
  try { saved = parseInt(localStorage.getItem('lowplat.level'), 10) || 0; } catch (e) {}
  loadLevel(saved);
  start();
})();
