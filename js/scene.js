/* ============================================================================
   scene.js — MarsTalk 3D solar system (Three.js r128)
   ----------------------------------------------------------------------------
   Renders the Sun + inner planets at real heliocentric positions, the live
   Earth↔Mars distance line (the light/radio path), the "where Mars will be"
   aim line, a Deep Space Network constellation around a spinning Earth, a
   rocket Hohmann-transfer animation, and a message photon.

   Depends on THREE, THREE.OrbitControls, and Astro. Exposes global `Scene`.
   ========================================================================== */
(function (global) {
  'use strict';
  const A = global.Astro;

  /* ---- Scene-unit scaling -------------------------------------------------- */
  const AU2U = 42;                 // scene units per AU
  const toScene = (h) => new THREE.Vector3(h.x * AU2U, h.z * AU2U, h.y * AU2U);

  let renderer, scene, camera, controls, clock;
  let sun, starfield;
  const bodies = {};               // name -> { mesh, label }
  let distLine, aimLine, ghostMars, ghostLabel;
  let dsnGroup, dsnDots = [], earthSpin = 0;
  let rocket, rocketTrail, rocketPlan, rocketCurve = null, rocketActive = false, rocketT = 0;
  const photons = new Map();   // id -> { dir, mesh, glow, trail }
  let curDate = new Date();
  let _activeDSN = -1;

  const COL = {
    light: 0x6fe3ff, aim: 0xffcf5a, rocket: 0x8cff9e,
    sun: 0xffd27a, ghost: 0xffb15a
  };

  /* ---- small helpers ------------------------------------------------------- */
  function makeLabel(text, hex, sizeU) {
    const fs = 52, pad = 16;
    const c = document.createElement('canvas');
    let ctx = c.getContext('2d');
    ctx.font = `600 ${fs}px -apple-system, system-ui, sans-serif`;
    const w = Math.ceil(ctx.measureText(text).width);
    c.width = w + pad * 2; c.height = fs + pad * 2;
    ctx = c.getContext('2d');
    ctx.font = `600 ${fs}px -apple-system, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,.85)'; ctx.shadowBlur = 10;
    ctx.fillStyle = '#' + hex.toString(16).padStart(6, '0');
    ctx.fillText(text, pad, c.height / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.minFilter = THREE.LinearFilter; tex.anisotropy = 4;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    const h = sizeU || 4.4;
    sp.scale.set(h * c.width / c.height, h, 1);
    sp.renderOrder = 20;
    return sp;
  }

  function radialSprite(hex, sizeU, opacity) {
    const s = 128, c = document.createElement('canvas'); c.width = c.height = s;
    const ctx = c.getContext('2d');
    const col = '#' + hex.toString(16).padStart(6, '0');
    const g = ctx.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
    g.addColorStop(0, col); g.addColorStop(0.25, col);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    const tex = new THREE.CanvasTexture(c);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: opacity == null ? 1 : opacity
    }));
    sp.scale.set(sizeU, sizeU, 1);
    return sp;
  }

  /* ---- build the scene ----------------------------------------------------- */
  function init(container) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    clock = new THREE.Clock();

    camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, 0.1, 8000);
    camera.position.set(36, 132, 150);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.07;
    controls.minDistance = 20; controls.maxDistance = 900;
    controls.target.set(0, 0, 0);

    scene.add(new THREE.AmbientLight(0x404a66, 0.55));
    const sunLight = new THREE.PointLight(0xfff2d8, 2.4, 0, 1.2);
    scene.add(sunLight);

    buildStarfield();
    buildSun();
    buildPlanets();
    buildOrbits();
    buildLines();
    buildDSN();
    buildRocket();

    addEventListener('resize', onResize);
    update(curDate);
    animate();
  }

  function buildStarfield() {
    const N = 2600, pos = new Float32Array(N * 3);
    // deterministic scatter (no Math.random dependency for reproducibility)
    for (let i = 0; i < N; i++) {
      const a = i * 2.39996323, r = 1400 + ((i * 97) % 600);
      const y = 1 - (i / N) * 2, rad = Math.sqrt(1 - y * y);
      pos[i*3]   = Math.cos(a) * rad * r;
      pos[i*3+1] = y * r;
      pos[i*3+2] = Math.sin(a) * rad * r;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    starfield = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xaecbff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.8 }));
    scene.add(starfield);
  }

  function buildSun() {
    sun = new THREE.Mesh(
      new THREE.SphereGeometry(5.6, 32, 32),
      new THREE.MeshBasicMaterial({ color: COL.sun })
    );
    scene.add(sun);
    sun.add(radialSprite(COL.sun, 34, 0.9));
    sun.add(radialSprite(0xffae40, 60, 0.35));
    const lbl = makeLabel('Sun', 0xffd27a, 3.6); lbl.position.y = 8.5; sun.add(lbl);
  }

  function buildPlanets() {
    A.PLANETS.forEach(p => {
      const r = p.vsize * 1.5;
      const mat = new THREE.MeshStandardMaterial({
        color: p.color, emissive: p.color, emissiveIntensity: 0.18, roughness: 0.85, metalness: 0.0
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 28, 28), mat);
      scene.add(mesh);
      const big = (p.name === 'Earth' || p.name === 'Mars');
      const label = makeLabel(p.name, p.color === 0x4a90e2 ? 0x7db6ff : p.color, big ? 4.6 : 3.4);
      label.visible = big;            // keep clutter down; show all on hover-zoom later
      scene.add(label);
      // highlight ring for Earth & Mars
      let halo = null;
      if (big) { halo = radialSprite(p.color, r * 6, 0.5); mesh.add(halo); }
      bodies[p.name] = { mesh, label, r, halo, big };
    });
  }

  function buildOrbits() {
    A.PLANETS.forEach(p => {
      const pts = A.orbitPath(p.name, curDate, 320).map(toScene);
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const big = (p.name === 'Earth' || p.name === 'Mars');
      const mat = new THREE.LineBasicMaterial({
        color: p.color, transparent: true, opacity: big ? 0.4 : 0.16
      });
      scene.add(new THREE.LineLoop(g, mat));
    });
  }

  function buildLines() {
    distLine = new THREE.Line(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: COL.light, transparent: true, opacity: 0.95 }));
    distLine.renderOrder = 5; scene.add(distLine);

    aimLine = new THREE.Line(new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: COL.aim, dashSize: 2.4, gapSize: 1.8, transparent: true, opacity: 0.85 }));
    scene.add(aimLine);

    ghostMars = new THREE.Mesh(
      new THREE.SphereGeometry(bodyR('Mars'), 20, 20),
      new THREE.MeshBasicMaterial({ color: COL.ghost, wireframe: true, transparent: true, opacity: 0.5 })
    );
    scene.add(ghostMars);
    ghostLabel = makeLabel('Mars in ' + A.HOHMANN_DAYS + ' d', COL.ghost, 3.4);
    scene.add(ghostLabel);
  }
  function bodyR(name){ const p = A.PLANETS.find(x=>x.name===name); return p.vsize*1.5; }

  /* Deep Space Network — three dishes on a ring around Earth (~120° apart). */
  function buildDSN() {
    dsnGroup = new THREE.Group();
    scene.add(dsnGroup);
    const rE = bodyR('Earth');
    A.DSN.forEach((s, i) => {
      const ang = i * 2 * Math.PI / 3;
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.34, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0x8aa0c0 })
      );
      // place on a ring slightly above Earth's surface, tilted to read in 3D
      dot.position.set(Math.cos(ang) * rE * 1.5, Math.sin(ang) * rE * 0.5, Math.sin(ang) * rE * 1.5);
      dot.userData = { i, base: dot.position.clone() };
      dot.add(radialSprite(COL.light, 4, 0)); // glow, opacity toggled when active
      dsnGroup.add(dot);
      dsnDots.push(dot);
    });
  }

  function buildRocket() {
    rocket = new THREE.Group();
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.7, 2.2, 14),
      new THREE.MeshStandardMaterial({ color: 0xf2f6ff, emissive: 0xbfe9ff, emissiveIntensity: 0.5, roughness: 0.4 })
    );
    rocket.add(cone);
    rocket.add(radialSprite(COL.rocket, 6, 0.9));
    rocket.visible = false;
    scene.add(rocket);

    rocketTrail = new THREE.Line(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: COL.rocket, transparent: true, opacity: 0.95 }));
    scene.add(rocketTrail);
    rocketPlan = new THREE.Line(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: COL.rocket, transparent: true, opacity: 0.22 }));
    scene.add(rocketPlan);
  }

  // Each in-flight message is its own photon (so several can cross at once,
  // in both directions). dir: 'E2M' Earth→Mars, 'M2E' Mars→Earth.
  function addPhoton(id, dir) {
    const col = dir === 'E2M' ? 0x9fd0ff : 0xffb59a;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.85, 12, 12),
      new THREE.MeshBasicMaterial({ color: col }));
    const glow = radialSprite(col, 11, 1);
    mesh.add(glow);
    const trail = new THREE.Line(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.45 }));
    trail.renderOrder = 4;
    scene.add(mesh); scene.add(trail);
    photons.set(id, { dir, mesh, glow, trail });
  }
  function setPhoton(id, t) {
    const p = photons.get(id); if (!p) return;
    const e = bodies.Earth.mesh.position, m = bodies.Mars.mesh.position;
    const from = p.dir === 'E2M' ? e : m, to = p.dir === 'E2M' ? m : e;
    const cur = new THREE.Vector3().lerpVectors(from, to, Math.max(0, Math.min(1, t)));
    p.mesh.position.copy(cur);
    p.trail.geometry.setFromPoints([from, cur]);   // comet trail from source
  }
  function removePhoton(id) {
    const p = photons.get(id); if (!p) return;
    scene.remove(p.mesh); scene.remove(p.trail);
    p.mesh.geometry.dispose(); p.mesh.material.dispose();
    p.trail.geometry.dispose(); p.trail.material.dispose();
    photons.delete(id);
  }

  /* ---- per-date update (positions of everything that depends on the date) -- */
  function update(date) {
    curDate = date;
    A.PLANETS.forEach(p => {
      const v = toScene(A.heliocentric(p.name, date));
      const b = bodies[p.name];
      b.mesh.position.copy(v);
      b.label.position.set(v.x, v.y + b.r + 3, v.z);
    });
    const e = bodies.Earth.mesh.position, m = bodies.Mars.mesh.position;

    // light / distance line
    distLine.geometry.setFromPoints([e, m]);

    // aim line + ghost Mars (where Mars will be after a Hohmann transfer)
    const future = toScene(A.heliocentric('Mars', A.addDays(date, A.HOHMANN_DAYS)));
    aimLine.geometry.setFromPoints([e, future]);
    aimLine.computeLineDistances();
    ghostMars.position.copy(future);
    ghostLabel.position.set(future.x, future.y + bodyR('Mars') + 3, future.z);

    // DSN follows Earth
    dsnGroup.position.copy(e);
  }

  /* ---- render loop --------------------------------------------------------- */
  function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta(), t = clock.elapsedTime;

    controls.update();
    if (sun) sun.rotation.y += dt * 0.05;
    if (starfield) starfield.rotation.y += dt * 0.003;

    // gentle Earth spin → DSN constellation turns; recompute who faces Mars
    earthSpin += dt * 0.5;
    dsnGroup.rotation.y = earthSpin;
    updateDSNActive();

    // pulse the light path
    if (distLine) distLine.material.opacity = 0.65 + 0.3 * Math.sin(t * 2.2);

    // pulse in-flight message photons so they read as "alive"
    photons.forEach(p => { p.glow.material.opacity = 0.6 + 0.4 * Math.abs(Math.sin(t * 3)); });

    renderer.render(scene, camera);
  }

  function updateDSNActive() {
    const e = bodies.Earth.mesh.position, m = bodies.Mars.mesh.position;
    const toMars = new THREE.Vector3().subVectors(m, e).normalize();
    let best = -1, bestDot = -2;
    const wp = new THREE.Vector3();
    dsnDots.forEach((d, i) => {
      d.getWorldPosition(wp);
      const dir = wp.sub(e).normalize();
      const dp = dir.dot(toMars);
      if (dp > bestDot) { bestDot = dp; best = i; }
    });
    dsnDots.forEach((d, i) => {
      const on = i === best;
      d.material.color.set(on ? COL.light : 0x8aa0c0);
      d.scale.setScalar(on ? 1.6 : 1);
      d.children[0].material.opacity = on ? 0.95 : 0;
    });
    if (best !== _activeDSN) { _activeDSN = best; if (Scene.onDSNChange) Scene.onDSNChange(best); }
  }

  /* ---- rocket mission ------------------------------------------------------ */
  // Build a transfer arc from Earth@launch to Mars@(launch + Hohmann days).
  function beginRocket(date) {
    const eH = A.heliocentric('Earth', date);
    const arrDate = A.addDays(date, A.HOHMANN_DAYS);
    const mH = A.heliocentric('Mars', arrDate);

    const rE = Math.hypot(eH.x, eH.y), rM = Math.hypot(mH.x, mH.y);
    let thE = Math.atan2(eH.y, eH.x), thM = Math.atan2(mH.y, mH.x);
    let dth = thM - thE; while (dth <= 0) dth += 2 * Math.PI; // sweep prograde
    const zE = eH.z, zM = mH.z;

    const pts = [];
    const N = 160;
    for (let i = 0; i <= N; i++) {
      const s = i / N;
      const th = thE + dth * s;
      const r = rE + (rM - rE) * s;          // perihelion(Earth) → aphelion(Mars)
      const z = zE + (zM - zE) * s;
      pts.push(toScene({ x: r * Math.cos(th), y: r * Math.sin(th), z }));
    }
    rocketCurve = new THREE.CatmullRomCurve3(pts);
    rocketPlan.geometry.setFromPoints(pts);
    rocketTrail.geometry.setFromPoints([pts[0]]);
    rocketActive = true; rocketT = 0;
    rocket.visible = true;
    rocket.position.copy(pts[0]);
    return { launchDate: new Date(date.getTime()), arrivalDate: arrDate };
  }

  function setRocket(t) {
    if (!rocketActive || !rocketCurve) return;
    rocketT = Math.max(0, Math.min(1, t));
    const p = rocketCurve.getPoint(rocketT);
    rocket.position.copy(p);
    if (rocketT < 1) {
      const ahead = rocketCurve.getPoint(Math.min(1, rocketT + 0.01));
      rocket.lookAt(ahead);
      rocket.rotateX(Math.PI / 2); // cone points along travel
    }
    // grow trail
    const seg = Math.max(2, Math.floor(rocketT * 160) + 1);
    const tp = [];
    for (let i = 0; i < seg; i++) tp.push(rocketCurve.getPoint(i / 160));
    tp.push(p);
    rocketTrail.geometry.setFromPoints(tp);
  }

  function endRocket(keepTrail) {
    rocketActive = false;
    if (!keepTrail) {
      rocket.visible = false;
      rocketTrail.geometry.setFromPoints([]);
      rocketPlan.geometry.setFromPoints([]);
      rocketCurve = null;
    }
  }

  /* ---- camera helpers ------------------------------------------------------ */
  function resetView() {
    animateCamera(new THREE.Vector3(36, 132, 150), new THREE.Vector3(0, 0, 0));
  }
  function focusEarthMars() {
    const e = bodies.Earth.mesh.position, m = bodies.Mars.mesh.position;
    const mid = new THREE.Vector3().addVectors(e, m).multiplyScalar(0.5);
    const dist = e.distanceTo(m) * 1.6 + 50;
    animateCamera(new THREE.Vector3(mid.x, dist * 0.7, mid.z + dist), mid);
  }
  let camAnim = null;
  function animateCamera(toPos, toTarget) {
    camAnim = { fromPos: camera.position.clone(), toPos, fromT: controls.target.clone(), toTarget, t0: clock.elapsedTime, dur: 1.1 };
    // simple lerp driven inside animate()
    const step = () => {
      if (!camAnim) return;
      const k = Math.min(1, (clock.elapsedTime - camAnim.t0) / camAnim.dur);
      const e = k < .5 ? 2*k*k : 1 - Math.pow(-2*k+2,2)/2;
      camera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, e);
      controls.target.lerpVectors(camAnim.fromT, camAnim.toTarget, e);
      if (k < 1) requestAnimationFrame(step); else camAnim = null;
    };
    step();
  }

  function onResize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }

  /* ---- public API ---------------------------------------------------------- */
  const Scene = {
    init, update,
    beginRocket, setRocket, endRocket,
    addPhoton, setPhoton, removePhoton,
    resetView, focusEarthMars,
    showAim(v){ aimLine.visible = v; ghostMars.visible = v; ghostLabel.visible = v; },
    onDSNChange: null,
    get activeDSN(){ return _activeDSN; },
    earthPos(){ return bodies.Earth.mesh.position.clone(); },
    marsPos(){ return bodies.Mars.mesh.position.clone(); }
  };
  global.Scene = Scene;
})(typeof window !== 'undefined' ? window : this);
