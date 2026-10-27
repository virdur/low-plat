/* Звук: короткие эффекты, синтезируются на лету (Web Audio), файлов нет.
   Браузер разрешает звук только после действия пользователя, поэтому контекст создаётся в unlock(),
   который вызывается из обработчиков клавиш и касаний. Пока контекста нет или звук выключен, play() ничего не делает. */
(function (root) {
  'use strict';

  var VOLUME = 0.35;
  var ctx = null, master = null, noiseBuf = null, muted = false, broken = false;
  var suspendedByGame = false;   // на паузе контекст держим остановленным, даже если пришло новое касание

  function unlock() {
    if (broken) return;
    if (!ctx) {
      var AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) { broken = true; return; }
      try {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : VOLUME;
        master.connect(ctx.destination);
      } catch (e) { ctx = null; broken = true; return; }
    }
    if (ctx.state === 'suspended' && !suspendedByGame) { try { ctx.resume(); } catch (e) {} }
  }

  function suspend() {
    suspendedByGame = true;
    if (ctx && ctx.state === 'running') { try { ctx.suspend(); } catch (e) {} }
  }

  function resume() {
    suspendedByGame = false;
    if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
  }

  function setMuted(m) {
    muted = !!m;
    if (master) master.gain.value = muted ? 0 : VOLUME;
  }

  function isMuted() { return muted; }

  // тон с плавным изменением высоты и затуханием; at - сдвиг по времени, с
  function tone(f0, f1, dur, type, vol, at) {
    var t = ctx.currentTime + (at || 0);
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  function noise(dur, vol, f0, f1) {
    if (!noiseBuf) {
      var n = Math.floor(ctx.sampleRate * 0.4), d, k;
      noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
      d = noiseBuf.getChannelData(0);
      for (k = 0; k < n; k++) d[k] = Math.random() * 2 - 1;
    }
    var t = ctx.currentTime;
    var s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf;
    f.type = 'lowpass';
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t); s.stop(t + dur + 0.02);
  }

  var SFX = {
    jump: function () { tone(360, 640, 0.10, 'triangle', 0.5); },
    wall: function () { tone(300, 520, 0.09, 'triangle', 0.5); tone(620, 920, 0.06, 'sine', 0.25); },
    land: function () { tone(170, 70, 0.07, 'sine', 0.45); },
    die: function () { noise(0.28, 0.6, 2400, 200); tone(260, 50, 0.30, 'sawtooth', 0.3); },
    win: function () {
      tone(523, 523, 0.10, 'triangle', 0.45, 0);
      tone(659, 659, 0.10, 'triangle', 0.45, 0.09);
      tone(784, 784, 0.10, 'triangle', 0.45, 0.18);
      tone(1047, 1047, 0.30, 'triangle', 0.45, 0.27);
    }
  };

  function play(name) {
    if (!ctx || muted || ctx.state !== 'running') return;
    SFX[name]();
  }

  var LP = root.LP = root.LP || {};
  LP.audio = { unlock: unlock, play: play, setMuted: setMuted, isMuted: isMuted, suspend: suspend, resume: resume };
})(typeof globalThis !== 'undefined' ? globalThis : window);
