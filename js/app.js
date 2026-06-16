/* ============================================================================
   app.js — MarsTalk UI wiring & interactions
   ----------------------------------------------------------------------------
   Owns the displayed date, drives the timeline / play / rocket-launch / message
   flows, and keeps the stat chips, DSN panel and readouts in sync with the
   scene. Depends on Astro + Scene.
   ========================================================================== */
(function () {
  'use strict';
  const A = window.Astro, S = window.Scene;
  const $ = (id) => document.getElementById(id);
  const DAY = 86400000;
  const TODAY = new Date();

  const state = {
    date: new Date(TODAY.getTime()),
    playing: false,
    speed: 30,            // days advanced per real second
    playDir: 1,           // ping-pong direction
    dir: 'E2M',           // message direction
    mission: null,        // active rocket flight
    message: null         // active in-flight message
  };

  /* ---- boot ---------------------------------------------------------------- */
  function boot() {
    S.init($('stage'));
    buildDSNPanel();
    S.onDSNChange = onDSNChange;
    onDSNChange(Math.max(0, S.activeDSN));   // apply initial highlight (first frame ran before wiring)
    paintTimelineHeatmap();
    wireControls();
    setDate(state.date);
    $('introDate').textContent = A.fmtDate(state.date);
    requestAnimationFrame(loop);
    setTimeout(() => $('loading').classList.add('gone'), 350);
  }

  /* ---- central: set the displayed date and refresh all readouts ----------- */
  function setDate(date) {
    state.date = date;
    S.update(date);
    const s = A.snapshot(date);

    // stat chips
    $('vDist').textContent  = A.fmtKM(s.distKM) + ' · ' + s.distAU.toFixed(2) + ' AU';
    $('vLight').textContent = A.fmtDuration(s.lightSecOneWay);
    $('vRound').textContent = A.fmtDuration(s.lightSecRound);
    $('vRocket').textContent = A.fmtDays(s.rocketDays);
    $('vRate').textContent  = A.fmtRate(s.dataRateMbps);

    // timeline readout
    $('tlDate').textContent = A.fmtDate(date);
    $('tlRel').textContent  = relLabel(date);
    const st = $('tlState');
    if (s.distAU < 0.85)      { st.textContent = '🟢 close approach'; st.className = 'tl-state close'; }
    else if (s.distAU > 1.8)  { st.textContent = '○ far side of the Sun'; st.className = 'tl-state far'; }
    else                      { st.textContent = ''; st.className = 'tl-state'; }

    // keep slider synced (clamped to its range)
    const off = Math.round((date.getTime() - TODAY.getTime()) / DAY);
    $('timeSlider').value = Math.max(-1825, Math.min(1825, off));

    // DSN rate + message hint
    state._rate = s.dataRateMbps;
    updateDSNRate();
    $('msgHint').textContent = 'arrives in ' + A.fmtDuration(s.lightSecOneWay);
  }

  function relLabel(date) {
    const days = Math.round((date.getTime() - TODAY.getTime()) / DAY);
    if (Math.abs(days) <= 1) return 'today';
    if (Math.abs(days) < 60) return (days > 0 ? '+' : '−') + Math.abs(days) + ' days';
    const yr = days / 365.25;
    return (yr > 0 ? '+' : '−') + Math.abs(yr).toFixed(1) + ' yr ' + (yr > 0 ? 'ahead' : 'ago');
  }

  /* ---- main loop (advances time during play / rocket missions) ------------- */
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;

    if (state.mission) {
      const p = (now - state.mission.t0) / state.mission.durMs;
      const prog = Math.min(1, p);
      const dms = state.mission.launchMs + (state.mission.arriveMs - state.mission.launchMs) * prog;
      setDate(new Date(dms));
      S.setRocket(prog);
      if (prog >= 1) endMission();
    } else if (state.playing) {
      let off = (state.date.getTime() - TODAY.getTime()) / DAY;
      off += state.speed * state.playDir * dt;
      if (off >= 1825)  { off = 1825;  state.playDir = -1; }
      if (off <= -1825) { off = -1825; state.playDir = 1; }
      setDate(new Date(TODAY.getTime() + off * DAY));
    }

    if (state.message) tickMessage(now);

    requestAnimationFrame(loop);
  }

  /* ---- controls wiring ----------------------------------------------------- */
  function wireControls() {
    $('timeSlider').addEventListener('input', (e) => {
      if (state.mission) return;
      stopPlay();
      setDate(new Date(TODAY.getTime() + (+e.target.value) * DAY));
    });
    $('todayBtn').addEventListener('click', () => { stopPlay(); setDate(new Date(TODAY.getTime())); toast('Back to today'); });
    $('playBtn').addEventListener('click', togglePlay);
    $('speedSel').addEventListener('change', (e) => { state.speed = +e.target.value; });
    $('launchBtn').addEventListener('click', launchRocket);

    // message direction
    document.querySelectorAll('.dir-btn').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.dir-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.dir = b.dataset.dir;
      document.body.classList.toggle('dir-m2e', state.dir === 'M2E');
    }));
    $('sendBtn').addEventListener('click', sendMessage);
    $('msgInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendMessage();
    });

    // intro
    $('introX').addEventListener('click', closeIntro);
    $('introGo').addEventListener('click', closeIntro);

    // double-click the void to frame Earth↔Mars
    $('stage').addEventListener('dblclick', () => S.focusEarthMars());
  }

  function closeIntro() { $('intro').classList.add('gone'); }

  /* ---- play / pause -------------------------------------------------------- */
  function togglePlay() {
    state.playing ? stopPlay() : startPlay();
  }
  function startPlay() {
    if (state.mission) return;
    state.playing = true;
    $('playBtn').textContent = '❚❚';
    $('playBtn').classList.add('playing');
  }
  function stopPlay() {
    state.playing = false;
    $('playBtn').textContent = '▶';
    $('playBtn').classList.remove('playing');
  }

  /* ---- rocket mission ------------------------------------------------------ */
  function launchRocket() {
    if (state.mission) return;
    stopPlay();
    S.showAim(false);
    const info = S.beginRocket(state.date);
    state.mission = {
      t0: performance.now(),
      durMs: 15000,
      launchMs: info.launchDate.getTime(),
      arriveMs: info.arrivalDate.getTime()
    };
    $('launchBtn').disabled = true;
    $('launchBtn').textContent = '🚀 In flight…';
    toast('Rocket launched — aiming for where Mars will be in ' + A.fmtDays(A.HOHMANN_DAYS));
  }
  function endMission() {
    state.mission = null;
    S.setRocket(1);
    S.endRocket(true);          // keep the trajectory drawn
    S.showAim(true);
    $('launchBtn').disabled = false;
    $('launchBtn').textContent = '🚀 Launch rocket';
    toast('🛬 Arrival! The rocket met Mars after ' + A.fmtDays(A.HOHMANN_DAYS) + ' — see how far Mars travelled.');
  }

  /* ---- messaging ----------------------------------------------------------- */
  function sendMessage() {
    if (state.message) { toast('A message is already in flight…'); return; }
    const txt = $('msgInput').value.trim();
    if (!txt) { $('msgInput').focus(); return; }
    const s = A.snapshot(state.date);
    const lightSec = s.lightSecOneWay;
    const dir = state.dir;

    // wall-clock time-lapse: real delay compressed to 4–11 s
    const durMs = 4000 + Math.min(1, lightSec / 1320) * 7000;

    const bubble = makeBubble(dir, txt, lightSec);
    $('msgLog').prepend(bubble.el);

    state.message = { dir, t0: performance.now(), durMs, lightSec, bubble, txt };
    S.setMessage(dir, 0);
    $('sendBtn').disabled = true;
    $('msgInput').value = '';
  }

  function tickMessage(now) {
    const m = state.message;
    const prog = Math.min(1, (now - m.t0) / m.durMs);
    S.setMessage(m.dir, prog);
    const elapsed = prog * m.lightSec;
    m.bubble.clock.textContent = mmss(elapsed) + ' / ' + mmss(m.lightSec);
    m.bubble.bar.style.width = (prog * 100) + '%';
    if (prog >= 1) deliverMessage();
  }

  function deliverMessage() {
    const m = state.message;
    S.setMessage(m.dir, null);
    m.bubble.el.classList.remove('flight');
    m.bubble.meta.innerHTML = dirLabel(m.dir) + ' · <span class="ok">delivered</span>';
    m.bubble.clockWrap.innerHTML = '✓ took ' + A.fmtDuration(m.lightSec);
    state.message = null;
    $('sendBtn').disabled = false;
    toast('📨 Message delivered after ' + A.fmtDuration(m.lightSec));
  }

  function makeBubble(dir, txt, lightSec) {
    const el = document.createElement('div');
    el.className = 'bubble flight ' + dir.toLowerCase();
    const meta = document.createElement('div'); meta.className = 'who'; meta.innerHTML = dirLabel(dir) + ' · in flight';
    const body = document.createElement('div'); body.textContent = txt;
    const clockWrap = document.createElement('div'); clockWrap.className = 'stamp';
    const clock = document.createElement('span'); clock.className = 'flight-clock'; clock.textContent = '0:00 / ' + mmss(lightSec);
    clockWrap.appendChild(clock);
    const prog = document.createElement('div'); prog.className = 'prog';
    const bar = document.createElement('i'); prog.appendChild(bar);
    el.append(meta, body, clockWrap, prog);
    return { el, meta, clock, clockWrap, bar };
  }

  function dirLabel(dir) { return dir === 'E2M' ? '🌍 Earth → Mars 🔴' : '🔴 Mars → Earth 🌍'; }
  function mmss(sec) {
    sec = Math.round(sec);
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  /* ---- DSN panel ----------------------------------------------------------- */
  let dsnItems = [];
  function buildDSNPanel() {
    const ul = $('dsnList');
    dsnItems = A.DSN.map((d, i) => {
      const li = document.createElement('li');
      li.className = 'dsn-item'; li.dataset.i = i;
      li.innerHTML =
        '<span class="dsn-led"></span>' +
        '<div><div class="dsn-name">' + d.name + ' <span class="dsn-meta">· ' + d.country + '</span></div>' +
        '<div class="dsn-meta">' + d.dish + '</div></div>' +
        '<span class="dsn-tx">— Mbps</span>';
      ul.appendChild(li);
      return li;
    });
  }
  function onDSNChange(idx) {
    dsnItems.forEach((li, i) => li.classList.toggle('active', i === idx));
    updateDSNRate();
  }
  function updateDSNRate() {
    const rate = state._rate != null ? A.fmtRate(state._rate) : '—';
    dsnItems.forEach((li, i) => {
      const tx = li.querySelector('.dsn-tx');
      tx.textContent = '↓ ' + rate;
    });
  }

  /* ---- timeline closeness heatmap ----------------------------------------- */
  function paintTimelineHeatmap() {
    const stops = [];
    const N = 64;
    for (let i = 0; i <= N; i++) {
      const off = -1825 + (3650 * i / N);
      const d = new Date(TODAY.getTime() + off * DAY);
      const au = A.snapshot(d).distAU;
      const k = Math.max(0, Math.min(1, (au - 0.45) / (2.4 - 0.45))); // 0 close → 1 far
      stops.push(mix(0x6fe3ff, 0x1b2233, k) + ' ' + (i / N * 100).toFixed(1) + '%');
    }
    $('timeSlider').style.setProperty('--tl-grad', 'linear-gradient(90deg,' + stops.join(',') + ')');
  }
  function mix(a, b, t) {
    const ar=(a>>16)&255, ag=(a>>8)&255, ab=a&255, br=(b>>16)&255, bg=(b>>8)&255, bb=b&255;
    const r=Math.round(ar+(br-ar)*t), g=Math.round(ag+(bg-ag)*t), bl=Math.round(ab+(bb-ab)*t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }

  /* ---- toast --------------------------------------------------------------- */
  let toastT;
  function toast(msg) {
    const el = $('toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 3400);
  }

  /* ---- go ------------------------------------------------------------------ */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
