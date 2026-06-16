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
    { name: 'Mercury', color: 0x9c8b7a, vsize: 0.55, radiusKm: 2440 },
    { name: 'Venus',   color: 0xe3b873, vsize: 0.95, radiusKm: 6052 },
    { name: 'Earth',   color: 0x4a90e2, vsize: 1.00, radiusKm: 6371 },
    { name: 'Mars',    color: 0xe0623a, vsize: 0.78, radiusKm: 3390 },
    { name: 'Jupiter', color: 0xd7b48a, vsize: 2.60, radiusKm: 69911 }
  ];

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
    return {
      date:            new Date(date.getTime()),
      earth, mars,
      distAU:          dAU,
      distKM:          dKM,
      lightSecOneWay:  lightOneWay,
      lightSecRound:   lightOneWay * 2,
      dataRateMbps:    dataRate(dAU),
      rocketDays:      HOHMANN_DAYS,
      rocketStraightDays: dKM / (ROCKET_KMS * 86400),
      lightLeadRad:    leadAngle(date, lightOneWay / 86400),  // tiny
      rocketLeadRad:   leadAngle(date, HOHMANN_DAYS)          // large
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

  /* ---- Public API ---------------------------------------------------------- */
  global.Astro = {
    AU_KM, C_KMS, J2000, DAY_MS, HOHMANN_DAYS, ROCKET_KMS,
    PLANETS, DSN, ELEMENTS,
    julianDate, heliocentric, distanceAU, orbitPath,
    addDays, snapshot, dataRate, leadAngle,
    fmtDuration, fmtDays, fmtKM, fmtRate, fmtDate
  };
})(typeof window !== 'undefined' ? window : this);
