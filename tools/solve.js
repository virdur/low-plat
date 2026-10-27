/* Проверка проходимости уровней: node tools/solve.js [номер уровня] [--map]
   BFS по настоящей физике из src/sim.js. Найден путь -> уровень точно проходим.
   Не найден -> неубедительно (ключ состояния квантуется), но повод присмотреться. */
'use strict';
require('../src/sim.js');
require('../src/levels.js');
var LP = globalThis.LP, sim = LP.sim;

var SKIP = 3;
var ACTIONS = [0, 1, 2, 4, 5, 6]; // ничего, влево, вправо, прыжок, влево+прыжок, вправо+прыжок
var MAX_NODES = 4e6;

function key(s) {
  return [Math.round(s.x / 2), Math.round(s.y / 2), Math.round(s.vx * 2), Math.round(s.vy * 2),
          s.g ? 1 : 0, s.jh ? 1 : 0, s.coyote > 0 ? 1 : 0, s.wallT > 0 ? s.wallSide : 0, s.lock > 0 ? 1 : 0,
          s.buf > 0 ? 1 : 0].join(',');
}

function solve(lv) {
  var start = sim.newState();
  sim.reset(start, lv);
  var seen = new Set([key(start)]);
  var nodes = [{ s: start, parent: -1, a: 0 }];
  var head = 0;
  while (head < nodes.length && nodes.length < MAX_NODES) {
    var n = nodes[head];
    for (var i = 0; i < ACTIONS.length; i++) {
      var s = sim.newState();
      sim.copyState(n.s, s);
      var dead = false, won = false;
      for (var f = 0; f < SKIP; f++) {
        sim.step(s, lv, ACTIONS[i]);
        if (s.dead) { dead = true; break; }
        if (s.won) { won = true; break; }
      }
      if (dead) continue;
      if (won) {
        var path = [ACTIONS[i]];
        for (var k = head; nodes[k].parent >= 0; k = nodes[k].parent) path.push(nodes[k].a);
        return { frames: path.length * SKIP, path: path.reverse(), nodes: nodes.length };
      }
      var kk = key(s);
      if (seen.has(kk)) continue;
      seen.add(kk);
      nodes.push({ s: s, parent: head, a: ACTIONS[i] });
    }
    head++;
  }
  return { frames: -1, nodes: nodes.length };
}

function ascii(lv) {
  var rows = [];
  for (var y = 0; y < sim.ROWS; y++) {
    var r = '';
    for (var x = 0; x < sim.COLS; x++) {
      var v = lv.grid[y * sim.COLS + x];
      r += (x === lv.ex && y === lv.ey) ? 'E' : v === sim.SOLID ? '#' : v === sim.SPIKE ? '^' : '.';
    }
    rows.push(r);
  }
  return rows.join('\n');
}

var arg = process.argv[2];
var only = arg && arg !== '--map' ? parseInt(arg, 10) - 1 : -1;
var map = process.argv.indexOf('--map') >= 0;
var failed = 0;
LP.levelDefs.forEach(function (def, i) {
  if (only >= 0 && only !== i) return;
  var lv = sim.parseLevel(def);
  if (map) console.log(ascii(lv));
  var t = Date.now();
  var r = solve(lv);
  if (r.frames < 0) failed++;
  console.log((i + 1) + ' ' + def.name + ': ' + (r.frames < 0 ? 'НЕ НАЙДЕНО' : 'ok, ' + (r.frames / 60).toFixed(1) + ' с') +
              ' (' + r.nodes + ' узлов, ' + (Date.now() - t) + ' мс)');
});
process.exit(failed ? 1 : 0);
