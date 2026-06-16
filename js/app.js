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
    messages: []          // in-flight messages (real-time, concurrent, both directions)
  };
  let msgSeq = 0;
  const MAX_MSGS = 99;   // effectively unlimited — send as many as you like

  /* ---- boot ---------------------------------------------------------------- */
  function boot() {
    S.init($('stage'));
    buildDSNPanel();
    S.onDSNChange = onDSNChange;
    S.onHover = handleHover;
    onDSNChange(Math.max(0, S.activeDSN));   // apply initial highlight (first frame ran before wiring)
    paintTimelineHeatmap();
    wireControls();
    updateFactorHint();
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
    $('timeSlider').value = Math.max(-3650, Math.min(3650, off));

    // DSN rate + message hint
    state._rate = s.dataRateMbps;
    updateDSNRate();
    $('msgHint').textContent = A.fmtDuration(s.lightSecOneWay) + ' each way · real time';
    updateFactorHint();
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
      const prog = Math.min(1, (now - state.mission.t0) / state.mission.durMs);
      const dms = state.mission.launchMs + (state.mission.arriveMs - state.mission.launchMs) * prog;
      setDate(new Date(dms));
      S.setRocket(prog);
      updateRocketHud(prog);
      if (prog >= 1) endMission();
    } else if (state.playing) {
      let off = (state.date.getTime() - TODAY.getTime()) / DAY;
      off += state.speed * state.playDir * dt;
      if (off >= 3650)  { off = 3650;  state.playDir = -1; }
      if (off <= -3650) { off = -3650; state.playDir = 1; }
      setDate(new Date(TODAY.getTime() + off * DAY));
    }

    if (state.messages.length) { if (state.mission) flushMessages(); else tickMessages(now); }

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
    $('rocketDur').addEventListener('change', updateFactorHint);
    $('launchBtn').addEventListener('click', launchRocket);
    $('windowsBtn').addEventListener('click', openWindows);
    $('winX').addEventListener('click', () => $('windowsModal').classList.add('gone'));
    $('windowsModal').addEventListener('click', (e) => { if (e.target.id === 'windowsModal') $('windowsModal').classList.add('gone'); });

    // message direction
    document.querySelectorAll('.dir-btn').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.dir-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.dir = b.dataset.dir;
      document.body.classList.toggle('dir-m2e', state.dir === 'M2E');
    }));
    $('sendBtn').addEventListener('click', sendMessage);
    $('msgInput').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.ctrlKey || e.metaKey) {            // Ctrl/Cmd+Enter → new line
        e.preventDefault();
        const ta = e.target, s = ta.selectionStart, en = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + '\n' + ta.value.slice(en);
        ta.selectionStart = ta.selectionEnd = s + 1;
      } else if (!e.shiftKey) {                 // Enter → send (Shift+Enter keeps default newline)
        e.preventDefault();
        sendMessage();
      }
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
    const durSec = +($('rocketDur').value) || 30;
    const info = S.beginRocket(state.date);
    const factor = (info.tofDays * 86400) / durSec;       // ×real-time
    state.mission = {
      t0: performance.now(),
      durMs: durSec * 1000,
      launchMs: info.launchDate.getTime(),
      arriveMs: info.arrivalDate.getTime(),
      tofN: Math.round(info.tofDays)
    };
    flushMessages();                                       // time is about to skip months
    $('launchBtn').disabled = true;
    $('launchBtn').textContent = '🚀 In flight…';
    $('rocketDur').disabled = true;
    $('rktFactor').textContent = '⏩ ' + fmtFactor(factor) + ' real time';
    $('rocketHud').classList.remove('hidden');
    updateRocketHud(0);
    toast('🚀 Launched at ' + fmtFactor(factor) + ' real time — a ' + A.fmtDays(info.tofDays) +
          ' transfer in ' + durSec + ' s. Watch it aim ahead of Mars.');
  }
  function endMission() {
    const tof = state.mission ? state.mission.tofN : A.HOHMANN_DAYS;
    state.mission = null;
    S.setRocket(1);
    S.endRocket(true);          // keep the trajectory drawn
    S.showAim(true);
    updateRocketHud(1);
    setTimeout(() => $('rocketHud').classList.add('hidden'), 2600);
    $('launchBtn').disabled = false;
    $('launchBtn').textContent = '🚀 Launch rocket';
    $('rocketDur').disabled = false;
    toast('🛬 Arrival! The rocket met Mars after ' + A.fmtDays(tof) + ' — see how far Mars travelled.');
  }
  function updateRocketHud(prog) {
    const N = state.mission ? state.mission.tofN : A.HOHMANN_DAYS;
    $('rktProg').textContent = 'day ' + Math.round(N * prog) + ' / ' + N + ' to Mars';
    $('rktBar').style.width = (prog * 100) + '%';
    const sp = S.rocketSpeed();
    $('rktSpeed').textContent = sp
      ? '🚀 ' + sp.toFixed(1) + ' km/s · 1/' + Math.round(A.C_KMS / sp).toLocaleString() + ' of light speed'
      : '';
  }
  function fmtFactor(n) {
    return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M×'
                    : Math.round(n / 1000) + 'k×';
  }
  function updateFactorHint() {
    const durSec = +($('rocketDur').value) || 30;
    const tof = A.hohmann(state.date).days;
    $('rktFactorHint').textContent = '≈' + fmtFactor((tof * 86400) / durSec);
  }

  /* ---- messaging ----------------------------------------------------------- */
  function sendMessage() {
    const txt = $('msgInput').value.trim();
    if (!txt) { $('msgInput').focus(); return; }
    if (state.messages.length >= MAX_MSGS) { toast('Let some messages arrive first…'); return; }
    const lightSec = A.snapshot(state.date).lightSecOneWay;
    const dir = state.dir;
    const id = ++msgSeq;

    // REAL TIME: the photon travels for the full one-way light delay.
    const durMs = lightSec * 1000;
    const bubble = makeBubble(dir, txt, lightSec);
    $('msgLog').prepend(bubble.el);

    S.addPhoton(id, dir);
    S.setPhoton(id, 0);
    state.messages.push({ id, dir, t0: performance.now(), durMs, lightSec, bubble, txt });
    $('msgInput').value = '';
    toast('🛰️ Transmitting in real time — ' + A.fmtDuration(lightSec) + ' to cross the void');
  }

  function tickMessages(now) {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      const prog = Math.min(1, (now - m.t0) / m.durMs);
      S.setPhoton(m.id, prog);
      const elapsed = prog * m.lightSec;
      m.bubble.clock.textContent = mmss(elapsed) + ' / ' + mmss(m.lightSec);
      m.bubble.bar.style.width = (prog * 100) + '%';
      if (prog >= 1) { deliverMessage(m); state.messages.splice(i, 1); }
    }
  }

  function deliverMessage(m, silent) {
    S.removePhoton(m.id);
    m.bubble.el.classList.remove('flight');
    m.bubble.meta.innerHTML = dirLabel(m.dir) + ' · <span class="ok">delivered</span>';
    m.bubble.clockWrap.innerHTML = silent
      ? '✓ delivered (time sped up)'
      : '✓ took ' + A.fmtDuration(m.lightSec) + ' (real time)';
    if (!silent) toast('📨 ' + (m.dir === 'E2M' ? 'Mars received your message' : 'Earth received the message') +
          ' after ' + A.fmtDuration(m.lightSec));
  }

  // When a rocket sim fast-forwards months, any in-flight message has long
  // since arrived — deliver them all at once.
  function flushMessages() {
    if (!state.messages.length) return;
    state.messages.forEach(m => deliverMessage(m, true));
    state.messages.length = 0;
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
    const N = 100;
    for (let i = 0; i <= N; i++) {
      const off = -3650 + (7300 * i / N);
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

  /* ---- hover tooltips (planets / Sun / rocket) ----------------------------- */
  let lastHoverKey = null;
  function handleHover(key, x, y) {
    const tip = $('hoverTip');
    if (!key) { tip.classList.remove('show'); lastHoverKey = null; return; }
    if (key !== lastHoverKey || key === 'rocket') { tip.innerHTML = tooltipHTML(key); lastHoverKey = key; }
    tip.classList.add('show');
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let left = x + 16, top = y + 16;
    if (left + w + pad > innerWidth) left = x - w - 16;
    if (top + h + pad > innerHeight) top = y - h - 16;
    tip.style.left = Math.max(pad, left) + 'px';
    tip.style.top = Math.max(pad, top) + 'px';
  }
  function tooltipHTML(key) {
    if (key === 'rocket') return rocketTip();
    if (key === 'Sun') return sunTip();
    if (key === 'Moon') return moonTip();
    if (key.indexOf('DSN:') === 0) return dsnTip(+key.slice(4));
    return planetTip(key);
  }
  function dsnTip(i) {
    const d = A.DSN[i], active = Scene.activeDSN === i;
    return '<div class="tip-title"><span class="tip-dot" style="background:' + (active ? '#6fe3ff' : '#8aa0c0') + '"></span>' + d.name + '</div>' +
      '<div class="tip-rows">' +
      '<span class="k">Network</span><span class="v">Deep Space Network</span>' +
      '<span class="k">Location</span><span class="v">' + d.country + '</span>' +
      '<span class="k">Antenna</span><span class="v">' + d.dish + '</span>' +
      '<span class="k">Status</span><span class="v">' + (active ? '▶ live to Mars' : 'standby') + '</span>' +
      (active && state._rate ? '<span class="k">Downlink</span><span class="v">' + A.fmtRate(state._rate) + '</span>' : '') +
      '</div><div class="tip-blurb">A ground station — one of three 70 m dishes ~120° apart, so Earth always has one facing Mars.</div>';
  }
  function planetTip(name) {
    const p = A.PLANETS.find(x => x.name === name);
    const au = A.ELEMENTS[name].el[0];
    const period = Math.pow(au, 1.5);
    const periodStr = period < 1 ? (period * 12).toFixed(1) + ' months' : period.toFixed(1) + ' yr';
    const day = p.dayH < 72 ? p.dayH.toFixed(1) + ' h' : (p.dayH / 24).toFixed(0) + ' days';
    const dot = '#' + p.color.toString(16).padStart(6, '0');
    return '<div class="tip-title"><span class="tip-dot" style="background:' + dot + '"></span>' + name + '</div>' +
      '<div class="tip-rows">' +
      '<span class="k">Diameter</span><span class="v">' + (2 * p.radiusKm).toLocaleString() + ' km</span>' +
      '<span class="k">From Sun</span><span class="v">' + au.toFixed(2) + ' AU</span>' +
      '<span class="k">Orbit</span><span class="v">' + periodStr + '</span>' +
      '<span class="k">Day</span><span class="v">' + day + '</span>' +
      '<span class="k">Moons</span><span class="v">' + p.moons + '</span>' +
      '</div><div class="tip-blurb">' + p.blurb + '</div>';
  }
  function sunTip() {
    const s = A.SUN_FACT;
    return '<div class="tip-title"><span class="tip-dot" style="background:#ffd27a"></span>' + s.name + '</div>' +
      '<div class="tip-rows"><span class="k">Diameter</span><span class="v">' + (2 * s.radiusKm).toLocaleString() + ' km</span>' +
      '<span class="k">vs Earth</span><span class="v">~109× wider</span></div>' +
      '<div class="tip-blurb">' + s.blurb + '</div>';
  }
  function moonTip() {
    const m = A.MOON_FACT;
    return '<div class="tip-title"><span class="tip-dot" style="background:#cfd6e0"></span>' + m.name + '</div>' +
      '<div class="tip-rows">' +
      '<span class="k">Diameter</span><span class="v">' + (2 * m.radiusKm).toLocaleString() + ' km</span>' +
      '<span class="k">From Earth</span><span class="v">384,400 km</span>' +
      '<span class="k">Light delay</span><span class="v">~1.3 s</span>' +
      '</div><div class="tip-blurb">' + m.blurb + '</div>';
  }
  function rocketTip() {
    const s = A.STARSHIP;
    const rows = s.rows.map(r => '<span class="k">' + r[0] + '</span><span class="v">' + r[1] + '</span>').join('');
    const sp = S.rocketSpeed();
    const live = sp ? '<div class="tip-live">⚡ now: ' + sp.toFixed(1) + ' km/s · 1/' + Math.round(A.C_KMS / sp).toLocaleString() + ' of light speed</div>' : '';
    return '<div class="tip-title">🚀 ' + s.name + '</div><div class="tip-rows">' + rows + '</div>' + live +
      '<div class="tip-note">' + s.note + '</div>';
  }

  /* ---- launch windows table ------------------------------------------------ */
  let windowsBuilt = false;
  function openWindows() {
    if (!windowsBuilt) { renderWindows(); windowsBuilt = true; }
    $('windowsModal').classList.remove('gone');
  }
  function renderWindows() {
    const wins = A.launchWindows(TODAY, 8, 17);
    const list = $('windowsList'); list.innerHTML = '';
    if (!wins.length) { list.innerHTML = '<p class="win-foot">No windows found.</p>'; return; }
    const dvs = wins.map(w => w.dvTotal);
    const minDv = Math.min.apply(null, dvs), maxDv = Math.max.apply(null, dvs);
    wins.forEach(w => {
      const best = w.dvTotal === minDv;
      const frac = (w.dvTotal - minDv) / Math.max(0.01, maxDv - minDv);   // 0 best .. 1 worst
      const hue = Math.round(140 - frac * 130);                            // green → red
      const row = document.createElement('div');
      row.className = 'win-row win-item' + (best ? ' best' : '');
      row.innerHTML =
        '<span class="wl-date">' + A.fmtDate(w.launch) + (best ? '<span class="win-best-tag">★ BEST</span>' : '') + '</span>' +
        '<span class="wl-arr">' + A.fmtDate(w.arrive) + '</span>' +
        '<span class="wl-trip">' + Math.round(w.tofDays) + ' d</span>' +
        '<span class="wl-dv"><i class="dvbar" style="width:' + Math.round(12 + frac * 48) + 'px;background:hsl(' + hue + ',72%,55%)"></i>' + w.dvTotal.toFixed(1) + ' km/s</span>' +
        '<button class="wl-jump">Jump →</button>';
      const go = () => jumpToWindow(w);
      row.querySelector('.wl-jump').addEventListener('click', (e) => { e.stopPropagation(); go(); });
      row.addEventListener('click', go);
      list.appendChild(row);
    });
  }
  function jumpToWindow(w) {
    stopPlay();
    setDate(new Date(w.launch.getTime()));
    $('windowsModal').classList.add('gone');
    toast('🗓 Jumped to ' + A.fmtDate(w.launch) + ' — optimal Mars window (Δv ' + w.dvTotal.toFixed(1) + ' km/s). Now hit 🚀 Launch rocket!');
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
