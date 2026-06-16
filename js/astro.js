/* ============================================================================
   astro.js — MarsTalk astronomy & physics engine
   ----------------------------------------------------------------------------
   Heliocentric positions of the inner planets via Keplerian elements
   (E.M. Standish / JPL, "Keplerian Elements for Approximate Positions of the
   Major Planets", valid 1800–2050 AD), plus light-travel time, a Hohmann
   transfer estimate, a DSN data-rate model calibrated to published MRO numbers,
   and the three Deep Space Network ground complexes.

   No dependencies. Exposes a single global: `Astro`.
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---- Physical constants -------------------------------------------------- */
  const AU_KM  = 149597870.7;     // 1 astronomical unit, km
  const C_KMS  = 299792.458;      // speed of light, km/s
  const DEG    = Math.PI / 180;
  const J2000  = 2451545.0;       // Julian date of the J2000.0 epoch
  const DAY_MS = 86400000;        // ms per day

  /* ---- Keplerian elements + per-century rates -----------------------------
     order: [ a(AU), e, I(deg), L(deg), longPeri ϖ(deg), longNode Ω(deg) ]    */
  const ELEMENTS = {
    Mercury: {
      el:   [0.38709927, 0.20563593,  7.00497902,  252.25032350,  77.45779628,  48.33076593],
      rate: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]
    },
    Venus: {
      el:   [0.72333566, 0.00677672,  3.39467605, 181.97909950, 131.60246718,  76.67984255],
      rate: [0.00000390,-0.00004107, -0.00078890, 58517.81538729,  0.00268329, -0.27769418]
    },
    Earth: {
      el:   [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193,   0.0],
      rate: [0.00000562,-0.00004392, -0.01294668, 35999.37244981,  0.32327364,  0.0]
    },
    Mars: {
      el:   [1.52371034, 0.09339410,  1.84969142,  -4.55343205, -23.94362959,  49.55953891],
      rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499,  0.44441088, -0.29257343]
    },
    Jupiter: {
      el:   [5.20288700, 0.04838624,  1.30439695,  34.39644051,  14.72847983, 100.47390909],
      rate: [-0.00011607,-0.00013253,-0.00183714,  3034.74612775,  0.21252668,   0.20469106]
    }
  };

  /* ---- Visual metadata for each body (sizes are exaggerated for legibility) */
  const PLANETS = [
    { name: 'Mercury', color: 0x9c8b7a, vsize: 0.55, radiusKm: 2440,  dayH: 1407.6, moons: 0,  blurb: 'Smallest planet — scorching days, frozen nights, almost no atmosphere.' },
    { name: 'Venus',   color: 0xe3b873, vsize: 0.95, radiusKm: 6052,  dayH: 5832.5, moons: 0,  blurb: 'Runaway greenhouse — a crushing CO₂ sky and the hottest surface in the system (~465 °C).' },
    { name: 'Earth',   color: 0x4a90e2, vsize: 1.00, radiusKm: 6371,  dayH: 24.0,   moons: 1,  blurb: 'Our pale blue dot — the only world known to harbour life.' },
    { name: 'Mars',    color: 0xe0623a, vsize: 0.78, radiusKm: 3390,  dayH: 24.6,   moons: 2,  blurb: 'The red planet — thin CO₂ air, planet-wide dust storms, two tiny moons. Our destination.' },
    { name: 'Jupiter', color: 0xd7b48a, vsize: 2.60, radiusKm: 69911, dayH: 9.9,    moons: 95, blurb: 'King of planets — a giant ball of gas with a centuries-old storm, the Great Red Spot.' }
  ];

  // Hover facts for the Sun + projected SpaceX Starship (Mars) specs.
  const SUN_FACT = { name: 'The Sun', radiusKm: 696340, blurb: 'A G-type star with ~99.86% of the solar system’s mass. Its light reaches Earth in ~8 min 20 s.' };
  const MOON_FACT = { name: 'The Moon', radiusKm: 1737, blurb: 'Earth’s only natural satellite — about 384,400 km away (~1.3 light-seconds), and the farthest humans have ever travelled.' };
  const STARSHIP = {
    name: 'SpaceX Starship — Mars',
    rows: [
      ['Height', '~121 m stack (50 m ship + 71 m booster)'],
      ['Diameter', '9 m'],
      ['Engines', '6 Raptor (ship) + 33 Raptor (booster)'],
      ['Cycle', 'full-flow staged combustion'],
      ['Propellant', 'liquid methane + oxygen (CH₄/LOX) — makeable on Mars'],
      ['Liftoff thrust', '~74 MN (≈7,500 t)'],
      ['Payload', '~100–150 t to orbit · ~100 t to Mars (refuelled in orbit)'],
      ['Crew', 'up to ~100 people per flight (long-term goal)']
    ],
    note: 'Projected / aspirational SpaceX figures — still in development.'
  };

  /* ---- Deep Space Network ground complexes (~120° apart in longitude) ------
     One 70 m dish at each site; together they give continuous sky coverage
     as Earth rotates. Coordinates are the complex sites.                      */
  const DSN = [
    { name: 'Goldstone', country: 'USA',       lat:  35.426, lon: -116.890, dish: 'DSS-14 · 70 m' },
    { name: 'Madrid',    country: 'Spain',     lat:  40.431, lon:   -4.249, dish: 'DSS-63 · 70 m' },
    { name: 'Canberra',  country: 'Australia', lat: -35.402, lon:  148.981, dish: 'DSS-43 · 70 m' }
  ];

  /* ---- Time helpers -------------------------------------------------------- */
  function julianDate(date)  { return date.getTime() / DAY_MS + 2440587.5; }
  function centuries(date)   { return (julianDate(date) - J2000) / 36525; }
  function addDays(date, d)  { return new Date(date.getTime() + d * DAY_MS); }

  /* Solve Kepler's equation  M = E − e·sinE  (Newton). M in degrees, E in rad. */
  function eccentricAnomaly(Mdeg, e) {
    let M = (((Mdeg + 180) % 360) + 360) % 360 - 180;   // wrap to [-180,180]
    M *= DEG;
    let E = M + e * Math.sin(M);
    for (let i = 0; i < 8; i++) {
      E += (M - (E - e * Math.sin(E))) / (1 - e * Math.cos(E));
    }
    return E;
  }

  /* Heliocentric ecliptic position (J2000) of a body, in AU → {x, y, z}.
     z is the small out-of-ecliptic component (orbital inclination).          */
  function heliocentric(name, date) {
    const p  = ELEMENTS[name];
    const T  = centuries(date);
    const a  =  p.el[0] + p.rate[0] * T;
    const e  =  p.el[1] + p.rate[1] * T;
    const I  = (p.el[2] + p.rate[2] * T) * DEG;
    const L  =  p.el[3] + p.rate[3] * T;
    const lp =  p.el[4] + p.rate[4] * T;          // ϖ longitude of perihelion
    const ln =  p.el[5] + p.rate[5] * T;          // Ω longitude of node
    const w  = (lp - ln) * DEG;                   // ω argument of perihelion
    const O  =  ln * DEG;
    const E  =  eccentricAnomaly(L - lp, e);      // M = L − ϖ

    // position in the orbital plane
    const xp = a * (Math.cos(E) - e);
    const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);

    // rotate orbital plane → ecliptic (ω, I, Ω)
    const cw = Math.cos(w), sw = Math.sin(w);
    const cO = Math.cos(O), sO = Math.sin(O);
    const cI = Math.cos(I), sI = Math.sin(I);
    return {
      x: (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
      y: (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
      z: (sw * sI) * xp + (cw * sI) * yp
    };
  }

  function distanceAU(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /* Sample a full orbit (one period) as an array of points, for drawing rings. */
  function orbitPath(name, date, steps) {
    steps = steps || 256;
    // approximate sidereal period from semi-major axis: P(yr) = a^1.5
    const a = ELEMENTS[name].el[0];
    const periodDays = Math.pow(a, 1.5) * 365.25;
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      pts.push(heliocentric(name, addDays(date, (i / steps) * periodDays)));
    }
    return pts;
  }

  /* ---- Comms / rocket physics --------------------------------------------- */

  // Data rate (Mbps) vs Earth–Mars distance. Anchored to published MRO figures:
  //   record ~6 Mbps near closest (~0.52 AU); 3–4 Mbps at ~0.65 AU (60M mi);
  //   ≥0.5 Mbps floor near conjunction (~2.6 AU). Inverse-square law, clamped.
  function dataRate(rAU) {
    const r = Math.max(rAU, 0.30);
    const k = 0.52 / r;
    return Math.min(6, Math.max(0.5, 6 * k * k));
  }

  // Representative Hohmann transfer Earth→Mars:
  //   a_t = (1 + 1.5237)/2 AU ; transfer time = ½ · a_t^1.5 (years).
  const HOHMANN_DAYS = Math.round(0.5 * Math.pow((1 + 1.523679) / 2, 1.5) * 365.25); // ≈ 259

  // Representative interplanetary cruise speed (km/s) for the "if it flew
  // straight" hypothetical — roughly Mars's own orbital speed.
  const ROCKET_KMS = 24;

  // Angle (radians) between Mars-now and Mars-later, as seen from Earth.
  function leadAngle(date, daysAhead) {
    const earth = heliocentric('Earth', date);
    const now   = heliocentric('Mars', date);
    const later = heliocentric('Mars', addDays(date, daysAhead));
    const a = { x: now.x - earth.x,   y: now.y - earth.y,   z: now.z - earth.z };
    const b = { x: later.x - earth.x, y: later.y - earth.y, z: later.z - earth.z };
    const dot = a.x * b.x + a.y * b.y + a.z * b.z;
    const ma = Math.sqrt(a.x*a.x + a.y*a.y + a.z*a.z);
    const mb = Math.sqrt(b.x*b.x + b.y*b.y + b.z*b.z);
    return Math.acos(Math.min(1, Math.max(-1, dot / (ma * mb))));
  }

  /* A full Earth↔Mars snapshot for one instant. */
  function snapshot(date) {
    const earth = heliocentric('Earth', date);
    const mars  = heliocentric('Mars', date);
    const dAU   = distanceAU(earth, mars);
    const dKM   = dAU * AU_KM;
    const lightOneWay = dKM / C_KMS;                 // seconds
    const hh    = hohmann(date).days;                // per-date Hohmann transfer time
    return {
      date:            new Date(date.getTime()),
      earth, mars,
      distAU:          dAU,
      distKM:          dKM,
      lightSecOneWay:  lightOneWay,
      lightSecRound:   lightOneWay * 2,
      dataRateMbps:    dataRate(dAU),
      rocketDays:      hh,
      rocketStraightDays: dKM / (ROCKET_KMS * 86400),
      lightLeadRad:    leadAngle(date, lightOneWay / 86400),  // tiny
      rocketLeadRad:   leadAngle(date, hh)                    // large
    };
  }

  /* ---- Formatters ---------------------------------------------------------- */
  function fmtDuration(seconds) {
    seconds = Math.round(seconds);
    if (seconds < 90) return seconds + ' s';
    const m = Math.floor(seconds / 60), s = seconds % 60;
    if (seconds < 3600) return m + ' min' + (s ? ' ' + s + ' s' : '');
    const h = Math.floor(seconds / 3600), mm = Math.floor((seconds % 3600) / 60);
    if (seconds < 86400) return h + ' h' + (mm ? ' ' + mm + ' min' : '');
    const d = Math.floor(seconds / 86400);
    return d + ' days';
  }

  function fmtDays(days) {
    const months = days / 30.44;
    if (days < 60) return Math.round(days) + ' days';
    return Math.round(days) + ' days (' + months.toFixed(1) + ' months)';
  }

  function fmtKM(km) {
    if (km >= 1e6) return (km / 1e6).toFixed(1) + ' million km';
    if (km >= 1e3) return (km / 1e3).toFixed(0) + ' thousand km';
    return Math.round(km) + ' km';
  }

  function fmtRate(mbps) {
    return mbps >= 1 ? mbps.toFixed(1) + ' Mbps' : Math.round(mbps * 1000) + ' kbps';
  }

  function fmtDate(date) {
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  /* ========================================================================
     Two-body orbital mechanics — accurate Earth→Mars transfer.
     Units: AU, days. μ_sun = k² (Gaussian gravitational constant squared).
     ====================================================================== */
  const MU_SUN = 2.959122082855911e-4;   // AU³ / day²
  const AUDAY_KMS = AU_KM / 86400;        // 1 AU/day in km/s

  const vadd   = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
  const vsub   = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  const vscale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
  const vdot   = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const vcross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
  const vmag   = (a) => Math.sqrt(vdot(a, a));

  // Stumpff functions C(ψ), S(ψ).
  function stumpff(psi) {
    if (psi > 1e-6) { const s = Math.sqrt(psi); return [(1 - Math.cos(s)) / psi, (s - Math.sin(s)) / (s * psi)]; }
    if (psi < -1e-6) { const s = Math.sqrt(-psi); return [(1 - Math.cosh(s)) / psi, (Math.sinh(s) - s) / Math.sqrt(-psi * -psi * -psi)]; }
    return [0.5, 1 / 6];
  }

  // Universal-variable Kepler propagation of state (r0,v0) forward dt days.
  function keplerProp(r0, v0, dt) {
    const sqmu = Math.sqrt(MU_SUN);
    const r0m = vmag(r0), v0m = vmag(v0), rdotv = vdot(r0, v0);
    const alpha = -v0m * v0m / MU_SUN + 2 / r0m;          // 1/a
    let chi = sqmu * dt * alpha;                          // elliptic initial guess
    if (!isFinite(chi)) chi = sqmu * Math.abs(dt) / r0m;
    let r = r0m, c2 = 0.5, c3 = 1 / 6;
    for (let i = 0; i < 80; i++) {
      const psi = chi * chi * alpha;
      [c2, c3] = stumpff(psi);
      r = chi * chi * c2 + (rdotv / sqmu) * chi * (1 - psi * c3) + r0m * (1 - psi * c2);
      const dchi = (sqmu * dt - chi * chi * chi * c3 - (rdotv / sqmu) * chi * chi * c2 - r0m * chi * (1 - psi * c3)) / r;
      chi += dchi;
      if (Math.abs(dchi) < 1e-9) break;
    }
    const f = 1 - (chi * chi / r0m) * c2;
    const g = dt - (chi * chi * chi / sqmu) * c3;
    return vadd(vscale(r0, f), vscale(v0, g));            // position only
  }

  // Lambert solver (universal variables, single revolution, prograde short way).
  // Returns departure velocity v1 (AU/day), or null on failure.
  function lambert(r1, r2, tof) {
    const sqmu = Math.sqrt(MU_SUN);
    const r1m = vmag(r1), r2m = vmag(r2);
    let cosdnu = Math.min(1, Math.max(-1, vdot(r1, r2) / (r1m * r2m)));
    const tm = (vcross(r1, r2).z >= 0) ? 1 : -1;          // prograde (+z angular momentum)
    const A = tm * Math.sqrt(r1m * r2m * (1 + cosdnu));
    if (A === 0) return null;
    let psi = 0, c2 = 0.5, c3 = 1 / 6, psiUp = 4 * Math.PI * Math.PI, psiLow = -4 * Math.PI;
    let y = r1m + r2m, chi, dtCalc;
    for (let i = 0; i < 300; i++) {
      y = r1m + r2m + A * (psi * c3 - 1) / Math.sqrt(c2);
      if (A > 0 && y < 0) {
        let k = 0;
        while (y < 0 && k < 60) { psiLow += Math.PI; psi = (psiUp + psiLow) / 2; [c2, c3] = stumpff(psi); y = r1m + r2m + A * (psi * c3 - 1) / Math.sqrt(c2); k++; }
      }
      chi = Math.sqrt(y / c2);
      dtCalc = (chi * chi * chi * c3 + A * Math.sqrt(y)) / sqmu;
      if (Math.abs(dtCalc - tof) < 1e-6) break;
      if (dtCalc <= tof) psiLow = psi; else psiUp = psi;
      psi = (psiUp + psiLow) / 2;
      [c2, c3] = stumpff(psi);
    }
    const f = 1 - y / r1m, g = A * Math.sqrt(y / MU_SUN), gdot = 1 - y / r2m;
    if (g === 0 || !isFinite(g)) return null;
    const v1 = vscale(vsub(r2, vscale(r1, f)), 1 / g);          // departure velocity
    const v2 = vscale(vsub(vscale(r2, gdot), r1), 1 / g);       // arrival velocity
    return { v1, v2 };
  }

  // Per-date Hohmann transfer time from the ACTUAL heliocentric radii (varies
  // ~250–280 d over the eccentric orbits). Returns { aT, days }.
  function hohmann(date) {
    const rE = vmag(heliocentric('Earth', date));
    const rM = vmag(heliocentric('Mars', date));
    const aT = (rE + rM) / 2;
    return { aT, days: Math.PI * Math.sqrt(aT * aT * aT / MU_SUN) };
  }

  // Build the real transfer leaving Earth at `date`. Time of flight from the
  // per-date Hohmann; Lambert-solved to Mars' true position at arrival, so the
  // rocket genuinely intercepts. posAt(frac) gives the heliocentric position
  // (AU) at fraction frac of the flight by Kepler-propagating the solved orbit.
  function transfer(date) {
    const r1 = heliocentric('Earth', date);
    const tof = hohmann(date).days;
    const r2 = heliocentric('Mars', addDays(date, tof));
    const lam = lambert(r1, r2, tof);
    if (!lam || !isFinite(lam.v1.x) || !isFinite(lam.v1.y) || !isFinite(lam.v1.z)) return null;
    const v1 = lam.v1;
    const aT = 1 / (2 / vmag(r1) - vmag(v1) * vmag(v1) / MU_SUN);   // transfer semi-major axis
    const posAt = (frac) => frac <= 0 ? r1 : (frac >= 1 ? r2 : keplerProp(r1, v1, frac * tof));
    return {
      tofDays: tof, r1, r2, v1, a: aT, posAt,
      // instantaneous heliocentric speed (km/s) via vis-viva: v² = μ(2/r − 1/a)
      speedAt: (frac) => { const p = posAt(frac); const r = Math.sqrt(p.x*p.x + p.y*p.y + p.z*p.z); return Math.sqrt(MU_SUN * (2 / r - 1 / aT)) * AUDAY_KMS; }
    };
  }

  /* ---- Launch windows: low-energy Hohmann opportunities Earth → Mars ------
     For each candidate launch date we Lambert-solve a Hohmann-duration transfer
     and total the heliocentric Δv (departure rel. Earth + arrival rel. Mars).
     Real windows are the local minima of that Δv (they recur ~every 26 mo).   */
  function planetVel(name, date) {
    const dt = 0.5;
    return vscale(vsub(heliocentric(name, addDays(date, dt)), heliocentric(name, addDays(date, -dt))), 1 / (2 * dt));
  }
  function transferCost(date) {
    const r1 = heliocentric('Earth', date);
    const tof = hohmann(date).days;
    const r2 = heliocentric('Mars', addDays(date, tof));
    const lam = lambert(r1, r2, tof);
    if (!lam || !isFinite(lam.v1.x) || !isFinite(lam.v2.x)) return null;
    const dvDep = vmag(vsub(lam.v1, planetVel('Earth', date)));
    const dvArr = vmag(vsub(lam.v2, planetVel('Mars', addDays(date, tof))));
    return { tof, dvDepart: dvDep * AUDAY_KMS, dvArrive: dvArr * AUDAY_KMS, dvTotal: (dvDep + dvArr) * AUDAY_KMS };
  }
  function launchWindows(fromDate, count, years) {
    count = count || 8; years = years || 17;
    const step = 5, N = Math.round(years * 365.25 / step);
    const s = [];
    for (let i = 0; i <= N; i++) { const d = addDays(fromDate, i * step); const c = transferCost(d); if (c) s.push({ d, dv: c.dvTotal, c }); }
    const wins = [];
    for (let k = 1; k < s.length - 1; k++) {
      if (s[k].dv < s[k - 1].dv && s[k].dv <= s[k + 1].dv) {           // local Δv minimum
        let best = s[k];
        for (let dd = -step + 1; dd < step; dd++) {                    // refine to the day
          const d = addDays(s[k].d, dd); const c = transferCost(d);
          if (c && c.dvTotal < best.dv) best = { d, dv: c.dvTotal, c };
        }
        if (!wins.length || (best.d - wins[wins.length - 1].d) > 120 * DAY_MS) wins.push(best);
      }
    }
    return wins.slice(0, count).map(w => ({
      launch: w.d, tofDays: w.c.tof, arrive: addDays(w.d, w.c.tof),
      dvTotal: w.c.dvTotal, dvDepart: w.c.dvDepart, dvArrive: w.c.dvArrive
    }));
  }

  /* ---- Public API ---------------------------------------------------------- */
  global.Astro = {
    AU_KM, C_KMS, J2000, DAY_MS, HOHMANN_DAYS, ROCKET_KMS, MU_SUN,
    PLANETS, DSN, ELEMENTS, SUN_FACT, MOON_FACT, STARSHIP,
    julianDate, heliocentric, distanceAU, orbitPath,
    addDays, snapshot, dataRate, leadAngle,
    hohmann, transfer, keplerProp, lambert, launchWindows,
    fmtDuration, fmtDays, fmtKM, fmtRate, fmtDate
  };
})(typeof window !== 'undefined' ? window : this);
