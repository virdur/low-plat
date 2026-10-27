/* Физика и разбор уровней. Никакого DOM: тот же код гоняет tools/solve.js в Node. */
(function (root) {
  'use strict';

  var T = 20;        // размер тайла, px
  var COLS = 32;
  var ROWS = 18;     // поле 640x360
  var SIZE = 14;     // сторона куба

  // всё в px и кадрах (60 кадров/с)
  var C = {
    grav: 0.42,
    maxFall: 8.5,
    slide: 1.4,        // скорость скольжения по стене, когда держишься
    accel: 0.55,
    airAccel: 0.4,
    fric: 0.6,
    airDrag: 0.12,
    maxRun: 3.2,
    // высота прыжка зависит от того, сколько держишь кнопку: стартовая скорость
    // jump, потом пока кнопка зажата (до jumpFrames кадров) к ней добавляется jumpBoost за кадр
    jump: 3.0,
    jumpBoost: 0.62,
    jumpFrames: 10,
    // отскок от стены растёт с удержанием так же, как обычный прыжок: короткий тап -
    // слабый подпрыг, на нём можно карабкаться вдоль стены; полное удержание -
    // сильный отскок (по горизонтали wallJX + wallFrames * wallBoostX = 4.2, как раньше)
    wallJump: 3.0,
    wallBoost: 0.62,
    wallJX: 1.2,
    wallBoostX: 0.3,
    wallFrames: 10,
    coyote: 6,
    wallCoyote: 5,
    buffer: 6
  };

  var EMPTY = 0, SOLID = 1, SPIKE = 2;

  // Уровень -> сетка. ops: ['#'|'^'|'.', x, y, w, h], рамка добавляется сама.
  function parseLevel(def) {
    var grid = new Uint8Array(COLS * ROWS);
    var i, x, y;
    function fill(ch, x0, y0, w, h) {
      var v = ch === '#' ? SOLID : ch === '^' ? SPIKE : EMPTY;
      for (y = y0; y < y0 + h; y++) {
        for (x = x0; x < x0 + w; x++) {
          if (x >= 0 && y >= 0 && x < COLS && y < ROWS) grid[y * COLS + x] = v;
        }
      }
    }
    fill('#', 0, 0, COLS, 1);
    fill('#', 0, ROWS - 1, COLS, 1);
    fill('#', 0, 0, 1, ROWS);
    fill('#', COLS - 1, 0, 1, ROWS);
    for (i = 0; i < def.ops.length; i++) {
      var o = def.ops[i];
      fill(o[0], o[1], o[2], o[3], o[4]);
    }
    return {
      name: def.name,
      grid: grid,
      sx: def.start[0] * T + (T - SIZE) / 2,
      sy: (def.start[1] + 1) * T - SIZE,
      ex: def.exit[0],
      ey: def.exit[1]
    };
  }

  function newState() {
    return { x: 0, y: 0, vx: 0, vy: 0, g: false, jh: false, buf: 0, coyote: 0,
             wallT: 0, wallSide: 0, grip: 0, jt: 0, jb: 0, jx: 0, dead: false, won: false };
  }

  function reset(s, lv) {
    s.x = lv.sx; s.y = lv.sy; s.vx = 0; s.vy = 0;
    s.g = false; s.jh = false; s.buf = 0; s.coyote = 0;
    s.wallT = 0; s.wallSide = 0; s.grip = 0; s.jt = 0; s.jb = 0; s.jx = 0;
    s.dead = false; s.won = false;
  }

  function copyState(a, b) {
    b.x = a.x; b.y = a.y; b.vx = a.vx; b.vy = a.vy; b.g = a.g; b.jh = a.jh;
    b.buf = a.buf; b.coyote = a.coyote; b.wallT = a.wallT; b.wallSide = a.wallSide;
    b.grip = a.grip; b.jt = a.jt; b.jb = a.jb; b.jx = a.jx; b.dead = a.dead; b.won = a.won;
  }

  // Бокс (x,y,SIZE) пересекает твёрдый тайл? Всё за краем поля - стена.
  function hitsSolid(lv, x, y) {
    var x0 = Math.floor(x / T), x1 = Math.floor((x + SIZE - 0.001) / T);
    var y0 = Math.floor(y / T), y1 = Math.floor((y + SIZE - 0.001) / T);
    var tx, ty;
    for (ty = y0; ty <= y1; ty++) {
      for (tx = x0; tx <= x1; tx++) {
        if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) return true;
        if (lv.grid[ty * COLS + tx] === SOLID) return true;
      }
    }
    return false;
  }

  function hitsSpike(lv, x, y) {
    var m = 4; // шипы бьют только по "ядру" куба
    var x0 = Math.floor((x + m) / T), x1 = Math.floor((x + SIZE - m) / T);
    var y0 = Math.floor((y + m) / T), y1 = Math.floor((y + SIZE - m) / T);
    var tx, ty;
    for (ty = y0; ty <= y1; ty++) {
      for (tx = x0; tx <= x1; tx++) {
        if (tx >= 0 && ty >= 0 && tx < COLS && ty < ROWS && lv.grid[ty * COLS + tx] === SPIKE) return true;
      }
    }
    return false;
  }

  function approach(v, t, a) {
    return v < t ? Math.min(v + a, t) : Math.max(v - a, t);
  }

  // inp: 1 = влево, 2 = вправо, 4 = прыжок (зажат)
  function step(s, lv, inp) {
    var dir = ((inp & 2) ? 1 : 0) - ((inp & 1) ? 1 : 0);
    var jh = (inp & 4) !== 0;

    if (jh && !s.jh) s.buf = C.buffer; else if (s.buf > 0) s.buf--;
    s.jh = jh;

    // стены рядом (с зазором в 1px)
    var wl = hitsSolid(lv, s.x - 1, s.y);
    var wr = hitsSolid(lv, s.x + 1, s.y);
    s.grip = 0;
    if (!s.g) {
      if (wl || wr) {
        s.wallT = C.wallCoyote;
        s.wallSide = (dir === 1 && wr) ? 1 : (dir === -1 && wl) ? -1 : (wl ? -1 : 1);
      } else if (s.wallT > 0) {
        s.wallT--;
      }
      // держимся за стену только если давим в её сторону
      if (dir === -1 && wl) s.grip = -1;
      else if (dir === 1 && wr) s.grip = 1;
    } else {
      s.wallT = 0;
    }

    // бег; пока держишь прыжок после отскока от стены, куб летит по инерции отскока
    if (!(s.jx !== 0 && s.jt > 0 && jh)) {
      var a = dir === 0 ? (s.g ? C.fric : C.airDrag) : (s.g ? C.accel : C.airAccel);
      s.vx = approach(s.vx, dir * C.maxRun, a);
    }

    // прыжок
    if (s.g) s.coyote = C.coyote; else if (s.coyote > 0) s.coyote--;
    if (s.buf > 0) {
      if (s.coyote > 0) {
        s.vy = -C.jump; s.jt = C.jumpFrames; s.jb = C.jumpBoost; s.jx = 0;
        s.coyote = 0; s.buf = 0; s.g = false;
      } else if (s.wallT > 0) {
        s.vy = -C.wallJump; s.jt = C.wallFrames; s.jb = C.wallBoost;
        s.vx = -s.wallSide * C.wallJX; s.jx = -s.wallSide * C.wallBoostX;
        s.wallT = 0; s.buf = 0; s.grip = 0;
      }
    }
    if (s.jt > 0) {
      if (jh) { s.vy -= s.jb; s.vx += s.jx; s.jt--; } else s.jt = 0;
    }

    // гравитация; на стене с нажатием "в стену" падаем медленно
    s.vy += C.grav;
    if (s.grip !== 0 && s.vy > C.slide) s.vy = C.slide;
    else if (s.vy > C.maxFall) s.vy = C.maxFall;

    // движение по осям, скорости < T, так что туннелирования нет
    var nx = s.x + s.vx;
    if (hitsSolid(lv, nx, s.y)) {
      if (s.vx > 0) nx = Math.floor((nx + SIZE - 0.001) / T) * T - SIZE;
      else nx = (Math.floor(nx / T) + 1) * T;
      s.vx = 0;
    }
    s.x = nx;

    var ny = s.y + s.vy;
    s.g = false;
    if (hitsSolid(lv, s.x, ny)) {
      if (s.vy > 0) { ny = Math.floor((ny + SIZE - 0.001) / T) * T - SIZE; s.g = true; }
      else { ny = (Math.floor(ny / T) + 1) * T; s.jt = 0; }
      s.vy = 0;
    }
    s.y = ny;

    if (hitsSpike(lv, s.x, s.y)) s.dead = true;
    var ex = lv.ex * T, ey = lv.ey * T;
    if (s.x + SIZE > ex && s.x < ex + T && s.y + SIZE > ey && s.y < ey + T) s.won = true;
  }

  var LP = root.LP = root.LP || {};
  LP.sim = { T: T, COLS: COLS, ROWS: ROWS, SIZE: SIZE, C: C, EMPTY: EMPTY, SOLID: SOLID, SPIKE: SPIKE,
             parseLevel: parseLevel, newState: newState, reset: reset, copyState: copyState, step: step };
})(typeof globalThis !== 'undefined' ? globalThis : window);
