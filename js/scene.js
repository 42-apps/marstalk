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
  let aimDays = 0;   // transfer time used for the "where Mars will be" aim line (0 = min-energy Hohmann)
  let dsnGroup, dsnDots = [], earthSpin = 0;
  let moon = null, moonLabel = null, moonAngle = 0;
  const rockets = new Map();   // id -> { transfer, curve, pts, group, flame, trail, plan, t }
  let rocketSeq = 0;
  const photons = new Map();   // id -> { dir, sprite, trail, sx, sy }
  const ENV_SIZE = 6;          // world-size of the flying envelopes
  let curDate = new Date();
  let _activeDSN = -1;
  const raycaster = new THREE.Raycaster();
  const pointerNDC = new THREE.Vector2();

  const COL = {
    light: 0x6fe3ff, aim: 0xffcf5a, rocket: 0x8cff9e,
    sun: 0xffd27a, ghost: 0xffb15a
  };

  let texLoader;
  function loadTex(name) {
    const t = texLoader.load('textures/' + name + '.jpg');
    t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
    return t;
  }

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
    sp.raycast = () => {};      // labels aren't hover targets
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
    sp.raycast = () => {};      // glow sprites aren't hover targets
    return sp;
  }

  /* ---- build the scene ----------------------------------------------------- */
  function init(container) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.outputEncoding = THREE.sRGBEncoding;
    texLoader = new THREE.TextureLoader();
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    clock = new THREE.Clock();

    camera = new THREE.PerspectiveCamera(46, innerWidth / innerHeight, 0.1, 8000);
    camera.position.set(36, 132, 150);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.07;
    controls.minDistance = 20; controls.maxDistance = 900;
    controls.target.set(0, 0, 0);

    scene.add(new THREE.AmbientLight(0x5a6a86, 0.4));
    const sunLight = new THREE.PointLight(0xfff2d8, 2.4, 0, 1.2);
    scene.add(sunLight);

    buildStarfield();
    buildSun();
    buildPlanets();
    buildMoon();
    buildOrbits();
    buildLines();
    buildDSN();

    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerleave', () => { if (Scene.onHover) Scene.onHover(null); renderer.domElement.style.cursor = 'default'; });
    addEventListener('resize', onResize);
    update(curDate);
    animate();
  }

  function buildStarfield() {
    // Real Milky Way star map (NASA-derived) on a giant inward-facing sphere —
    // a true night sky with the galactic band, replacing the procedural dots.
    const mat = new THREE.MeshBasicMaterial({ map: loadTex('stars_milky_way'), side: THREE.BackSide, depthWrite: false });
    mat.color.setScalar(0.72);                 // gently dim so the planets stay the focus
    starfield = new THREE.Mesh(new THREE.SphereGeometry(5000, 60, 40), mat);
    starfield.raycast = () => {};
    starfield.renderOrder = -1;
    scene.add(starfield);
  }

  function buildSun() {
    sun = new THREE.Mesh(
      new THREE.SphereGeometry(5.6, 48, 48),
      new THREE.MeshBasicMaterial({ map: loadTex('sun') })
    );
    scene.add(sun);
    sun.userData.hoverKey = 'Sun';
    sun.add(radialSprite(COL.sun, 34, 0.9));
    sun.add(radialSprite(0xffae40, 60, 0.35));
    const lbl = makeLabel('Sun', 0xffd27a, 3.6); lbl.position.y = 8.5; sun.add(lbl);
  }

  function buildPlanets() {
    A.PLANETS.forEach(p => {
      const r = p.vsize * 1.5;
      const tex = loadTex(p.name.toLowerCase());
      const mat = new THREE.MeshStandardMaterial({
        map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.24,
        roughness: 1, metalness: 0
      });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 48, 48), mat);
      mesh.userData.hoverKey = p.name;
      mesh.rotation.y = Math.random() * Math.PI * 2;   // varied starting longitudes
      scene.add(mesh);
      const big = (p.name === 'Earth' || p.name === 'Mars');
      const label = makeLabel(p.name, p.color === 0x4a90e2 ? 0x7db6ff : p.color, big ? 4.6 : 3.4);
      label.visible = big;            // keep clutter down; Earth & Mars labelled
      scene.add(label);
      bodies[p.name] = { mesh, label, r, big };
    });
  }

  // Earth's Moon — real size ratio (~0.27× Earth), distance exaggerated so it's
  // visible at this scale. Orbits Earth slowly; textured like the planets.
  function buildMoon() {
    const tex = loadTex('moon');
    moon = new THREE.Mesh(
      new THREE.SphereGeometry(bodyR('Earth') * 0.27, 32, 32),
      new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.24, roughness: 1, metalness: 0 })
    );
    moon.userData.hoverKey = 'Moon';
    scene.add(moon);
    moonLabel = makeLabel('Moon', 0xcfd6e0, 2.4);
    moonLabel.visible = false;
    scene.add(moonLabel);
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
    ghostLabel = makeLabel('Mars on arrival', COL.ghost, 3.4);
    scene.add(ghostLabel);
  }
  function bodyR(name){ const p = A.PLANETS.find(x=>x.name===name); return p.vsize*1.5; }

  // lat/lon → position on a sphere, matching three.js SphereGeometry +
  // an equirectangular (prime-meridian-centred) Earth texture.
  function latLonToVec3(lat, lon, r) {
    const d = Math.PI / 180, la = lat * d, lo = lon * d, c = Math.cos(la);
    return new THREE.Vector3(r * c * Math.cos(lo), r * Math.sin(la), -r * c * Math.sin(lo));
  }

  // A little parabolic dish antenna on a post (built pointing +Y).
  function makeDish() {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xb9c2d2, emissive: 0x3a4658, emissiveIntensity: 0.55, metalness: 0.55, roughness: 0.5, side: THREE.DoubleSide });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.1, 8), mat); post.position.y = 0.05;
    const bowl = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.09, 18, 1, true), mat); bowl.position.y = 0.14; bowl.rotation.x = Math.PI; // open face outward
    const feed = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 8), mat); feed.position.y = 0.17;
    g.add(post, bowl, feed);
    const glow = radialSprite(COL.light, 1.2, 0); glow.position.y = 0.14; g.add(glow);
    g.userData.mat = mat; g.userData.glow = glow;
    return g;
  }

  /* Deep Space Network — dish antennas planted ON Earth's surface at real
     lat/lon, parented to the Earth mesh so they rotate with the globe
     (Goldstone→California, Madrid→Spain, Canberra→Australia). The dish facing
     Mars lights up and hands off as Earth turns. */
  function buildDSN() {
    const earth = bodies.Earth.mesh, rE = bodyR('Earth');
    A.DSN.forEach((s, i) => {
      const dir = latLonToVec3(s.lat, s.lon, 1).normalize();
      const pin = makeDish();
      pin.position.copy(dir.clone().multiplyScalar(rE * 0.99));              // base sits on the surface
      pin.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);   // stand it upright, dish to the sky
      pin.userData.hoverKey = 'DSN:' + i;
      earth.add(pin);
      dsnDots.push(pin);
    });
  }

  // Build ONE Starship (stainless body + nosecone + fore/aft flaps + exhaust),
  // nose toward +Y. Returns the group + its flame mesh. Many can exist at once.
  function makeStarship() {
    const g = new THREE.Group();
    const hull = new THREE.MeshStandardMaterial({ color: 0xdde3ec, metalness: 0.62, roughness: 0.33, emissive: 0x3a4150, emissiveIntensity: 0.5 });
    const fin  = new THREE.MeshStandardMaterial({ color: 0x99a2b1, metalness: 0.45, roughness: 0.5 });
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 2.8, 24), hull));
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.5, 24), hull); nose.position.y = 2.15; g.add(nose);
    const mkFlap = (w, h, x, y, rz) => { const f = new THREE.Mesh(new THREE.BoxGeometry(0.1, h, w), fin); f.position.set(x, y, 0); f.rotation.z = rz; g.add(f); };
    mkFlap(0.85, 1.05, 0.55, -1.0, 0.22); mkFlap(0.85, 1.05, -0.55, -1.0, -0.22);   // aft flaps
    mkFlap(0.55, 0.70, 0.50, 1.25, 0.16); mkFlap(0.55, 0.70, -0.50, 1.25, -0.16);   // fwd flaps
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.38, 1.7, 18), new THREE.MeshBasicMaterial({ color: 0xffb24a, transparent: true, opacity: 0.92 }));
    flame.position.y = -2.15; flame.rotation.x = Math.PI; g.add(flame);
    const glow = radialSprite(0xffd27a, 4.6, 0.9); glow.position.y = -2.0; g.add(glow);
    g.scale.setScalar(1.6);
    return { group: g, flame };
  }

  // A clear envelope on a soft glow halo, drawn once per direction and cached.
  const envTex = {};
  function envelopeTexture(dir) {
    if (envTex[dir]) return envTex[dir];
    const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
    const x = c.getContext('2d');
    const glow   = dir === 'E2M' ? 'rgba(111,200,255,0.6)' : 'rgba(255,150,110,0.6)';
    const body   = dir === 'E2M' ? '#cfe6ff' : '#ffdac8';
    const edge   = dir === 'E2M' ? '#2f6fd0' : '#c8502a';
    const accent = dir === 'E2M' ? '#1d4f9e' : '#a13a18';
    // soft glow halo
    const g = x.createRadialGradient(S/2, S/2, 8, S/2, S/2, S/2);
    g.addColorStop(0, glow); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    // envelope body (rounded rectangle)
    const L = 48, T = 80, W = 160, H = 104, r = 16;
    x.beginPath();
    x.moveTo(L + r, T);
    x.arcTo(L + W, T, L + W, T + H, r); x.arcTo(L + W, T + H, L, T + H, r);
    x.arcTo(L, T + H, L, T, r);         x.arcTo(L, T, L + W, T, r);
    x.closePath();
    x.fillStyle = body; x.fill();
    x.lineWidth = 9; x.strokeStyle = edge; x.lineJoin = 'round'; x.stroke();
    // flap
    x.beginPath();
    x.moveTo(L + 5, T + 8); x.lineTo(L + W / 2, T + H * 0.52); x.lineTo(L + W - 5, T + 8);
    x.lineWidth = 9; x.strokeStyle = accent; x.lineCap = 'round'; x.stroke();
    const tex = new THREE.CanvasTexture(c); tex.minFilter = THREE.LinearFilter; tex.anisotropy = 4;
    envTex[dir] = tex; return tex;
  }
  // Each in-flight message is a little envelope. Any number can cross at once,
  // both directions, spread laterally around the line so they don't stack up.
  function addPhoton(id, dir) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: envelopeTexture(dir), transparent: true, depthTest: false, depthWrite: false }));
    sprite.scale.set(ENV_SIZE, ENV_SIZE, 1); sprite.renderOrder = 22; sprite.raycast = () => {};
    const col = dir === 'E2M' ? 0x9fd0ff : 0xffb59a;
    const trail = new THREE.Line(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.4 }));
    trail.renderOrder = 4;
    scene.add(sprite); scene.add(trail);
    // deterministic lateral spread from the id (golden-ratio scatter)
    const sx = ((id * 0.61803398875) % 1) - 0.5;
    const sy = ((id * 0.75487766624) % 1) - 0.5;
    photons.set(id, { dir, sprite, trail, sx, sy });
  }
  function setPhoton(id, t) {
    const p = photons.get(id); if (!p) return;
    const e = bodies.Earth.mesh.position, m = bodies.Mars.mesh.position;
    const from = p.dir === 'E2M' ? e : m, to = p.dir === 'E2M' ? m : e;
    const dir3 = new THREE.Vector3().subVectors(to, from).normalize();
    let perp = new THREE.Vector3().crossVectors(dir3, new THREE.Vector3(0, 1, 0));
    if (perp.lengthSq() < 1e-4) perp.set(1, 0, 0);
    perp.normalize();
    const vert = new THREE.Vector3().crossVectors(dir3, perp).normalize();
    const SPREAD = 5.5;
    const off = perp.multiplyScalar(p.sx * SPREAD).add(vert.multiplyScalar(p.sy * SPREAD));
    const cur = new THREE.Vector3().lerpVectors(from, to, Math.max(0, Math.min(1, t))).add(off);
    p.sprite.position.copy(cur);
    p.trail.geometry.setFromPoints([new THREE.Vector3().copy(from).add(off), cur]);
  }
  function removePhoton(id) {
    const p = photons.get(id); if (!p) return;
    scene.remove(p.sprite); scene.remove(p.trail);
    p.sprite.material.dispose();
    p.trail.geometry.dispose(); p.trail.material.dispose();
    photons.delete(id);   // envelope texture is cached/shared, not disposed
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

    // aim line + ghost Mars (where Mars will be when a rocket launched now arrives,
    // using the currently-selected transfer time)
    const hd = aimDays > 0 ? aimDays : A.hohmann(date).days;
    const future = toScene(A.heliocentric('Mars', A.addDays(date, hd)));
    aimLine.geometry.setFromPoints([e, future]);
    aimLine.computeLineDistances();
    ghostMars.position.copy(future);
    ghostLabel.position.set(future.x, future.y + bodyR('Mars') + 3, future.z);

  }

  /* ---- render loop --------------------------------------------------------- */
  function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta(), t = clock.elapsedTime;

    controls.update();
    if (sun) sun.rotation.y += dt * 0.05;
    if (starfield) starfield.rotation.y += dt * 0.003;
    A.PLANETS.forEach(p => { bodies[p.name].mesh.rotation.y += dt * 0.12; });   // spin textured planets
    updateMoon(dt);

    // DSN pins ride the spinning Earth mesh; recompute which faces Mars
    updateDSNActive();

    // pulse the light path
    if (distLine) distLine.material.opacity = 0.65 + 0.3 * Math.sin(t * 2.2);

    // flutter + gentle bob on in-flight envelopes; flicker the rocket exhaust
    photons.forEach(p => {
      const s = ENV_SIZE * (1 + 0.05 * Math.sin(t * 4));
      p.sprite.scale.set(s, s, 1);
      p.sprite.material.rotation = 0.16 * Math.sin(t * 2.4 + (p.sx + 0.5) * 6);
    });
    rockets.forEach(r => r.flame.scale.set(1, 0.75 + 0.35 * Math.abs(Math.sin(t * 22)), 1));

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
      d.userData.mat.color.set(on ? COL.light : 0xb9c2d2);
      d.userData.mat.emissive.set(on ? 0x2a6a7a : 0x3a4658);
      d.userData.glow.material.opacity = on ? 0.95 : 0;
      d.scale.setScalar(on ? 1.3 : 1);
    });
    if (best !== _activeDSN) { _activeDSN = best; if (Scene.onDSNChange) Scene.onDSNChange(best); }
  }

  /* ---- rocket mission ------------------------------------------------------ */
  // Launch a rocket on the real two-body transfer (Lambert + Kepler) leaving
  // Earth at `date` for a `tofDays` trip (default min-energy Hohmann). Many can
  // be in flight at once. Returns its id + arrival.
  function launchRocket(date, tofDays) {
    const tr = A.transfer(date, tofDays);
    let pts, tof, arrDate, curve = null;
    if (tr) {
      tof = tr.tofDays; arrDate = A.addDays(date, tof);
      pts = [];
      for (let i = 0; i <= 200; i++) pts.push(toScene(tr.posAt(i / 200)));
    } else {
      tof = A.hohmann(date).days; arrDate = A.addDays(date, tof);
      const eH = A.heliocentric('Earth', date), mH = A.heliocentric('Mars', arrDate);
      const rE = Math.hypot(eH.x, eH.y), rM = Math.hypot(mH.x, mH.y);
      let thE = Math.atan2(eH.y, eH.x), dth = Math.atan2(mH.y, mH.x) - thE;
      while (dth <= 0) dth += 2 * Math.PI;
      pts = [];
      for (let i = 0; i <= 160; i++) { const s = i/160; pts.push(toScene({ x: (rE+(rM-rE)*s)*Math.cos(thE+dth*s), y: (rE+(rM-rE)*s)*Math.sin(thE+dth*s), z: eH.z+(mH.z-eH.z)*s })); }
      curve = new THREE.CatmullRomCurve3(pts);
    }
    const id = ++rocketSeq;
    const ship = makeStarship();
    ship.group.userData.hoverKey = 'rocket:' + id;
    ship.group.position.copy(pts[0]);
    scene.add(ship.group);
    const trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: COL.rocket, transparent: true, opacity: 0.95 }));
    trail.geometry.setFromPoints([pts[0]]);
    const plan = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: COL.rocket, transparent: true, opacity: 0.22 }));
    plan.geometry.setFromPoints(pts);
    scene.add(trail); scene.add(plan);
    rockets.set(id, { id, transfer: tr, curve, pts, group: ship.group, flame: ship.flame, trail, plan, t: 0 });
    return { id, launchDate: new Date(date.getTime()), arrivalDate: arrDate, tofDays: tof };
  }

  // Place rocket `id` at fraction `t` of its flight TIME (Kepler-sampled, so it
  // speeds up near perihelion and slows near aphelion), growing its trail.
  function setRocketProgress(id, t) {
    const r = rockets.get(id); if (!r) return;
    r.t = Math.max(0, Math.min(1, t));
    const at = (fr) => r.transfer ? toScene(r.transfer.posAt(fr)) : r.curve.getPoint(fr);
    const p = at(r.t);
    r.group.position.copy(p);
    const ahead = at(Math.min(1, r.t + 0.004));
    if (ahead.distanceToSquared(p) > 1e-6) { r.group.lookAt(ahead); r.group.rotateX(Math.PI / 2); }
    const seg = Math.max(2, Math.floor(r.t * 200) + 1);
    const tp = [];
    for (let i = 0; i < seg; i++) tp.push(at(i / 200));
    tp.push(p);
    r.trail.geometry.setFromPoints(tp);
  }

  function endRocketFlight(id) { setRocketProgress(id, 1); }   // park it at Mars
  function removeRocket(id) {
    const r = rockets.get(id); if (!r) return;
    scene.remove(r.group); scene.remove(r.trail); scene.remove(r.plan);
    r.trail.geometry.dispose(); r.trail.material.dispose();
    r.plan.geometry.dispose(); r.plan.material.dispose();
    rockets.delete(id);
  }
  function rocketSpeed(id) {
    const r = rockets.get(id);
    return r && r.transfer ? r.transfer.speedAt(r.t) : null;
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
  function focusEarth() {
    const e = bodies.Earth.mesh.position, off = bodyR('Earth') * 7 + 3;
    animateCamera(new THREE.Vector3(e.x + off, e.y + off * 0.45, e.z + off), e.clone());
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

  function updateMoon(dt) {
    if (!moon) return;
    moonAngle += dt * 0.5;
    const e = bodies.Earth.mesh.position, md = bodyR('Earth') * 3.6;
    moon.position.set(e.x + Math.cos(moonAngle) * md, e.y + Math.sin(moonAngle) * md * 0.3, e.z + Math.sin(moonAngle) * md);
    moon.rotation.y += dt * 0.1;
    moonLabel.position.set(moon.position.x, moon.position.y + bodyR('Earth') * 0.27 + 1.5, moon.position.z);
  }

  // hover detection → reports a hover key ('Sun' | planet name | 'rocket') + cursor pos
  function onPointerMove(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    const w = rect.width || innerWidth, h = rect.height || innerHeight;   // robust if rect is 0×0
    pointerNDC.x = ((e.clientX - rect.left) / w) * 2 - 1;
    pointerNDC.y = -((e.clientY - rect.top) / h) * 2 + 1;
    raycaster.setFromCamera(pointerNDC, camera);
    const targets = A.PLANETS.map(p => bodies[p.name].mesh);
    targets.push(sun);
    if (moon) targets.push(moon);
    rockets.forEach(r => targets.push(r.group));
    const hits = raycaster.intersectObjects(targets, true);
    let key = null;
    if (hits.length) { let o = hits[0].object; while (o && !(o.userData && o.userData.hoverKey)) o = o.parent; if (o) key = o.userData.hoverKey; }
    renderer.domElement.style.cursor = key ? 'pointer' : 'default';
    if (Scene.onHover) Scene.onHover(key, e.clientX, e.clientY);
  }

  function onResize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  }

  /* ---- public API ---------------------------------------------------------- */
  const Scene = {
    init, update,
    launchRocket, setRocketProgress, endRocketFlight, removeRocket,
    addPhoton, setPhoton, removePhoton,
    resetView, focusEarthMars, focusEarth,
    showAim(v){ aimLine.visible = v; ghostMars.visible = v; ghostLabel.visible = v; },
    setAimDays(d){ aimDays = d || 0; },
    onDSNChange: null,
    onHover: null,
    rocketSpeed,
    get activeDSN(){ return _activeDSN; },
    earthPos(){ return bodies.Earth.mesh.position.clone(); },
    marsPos(){ return bodies.Mars.mesh.position.clone(); }
  };
  global.Scene = Scene;
})(typeof window !== 'undefined' ? window : this);
