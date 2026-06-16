# 🔴 MarsTalk

**How far is Mars right now, how long does light — or a rocket — take to get there, and what is it like to text the red planet across the void?**

MarsTalk is a zoomed-out, live 3D view of the inner solar system, built to make the *distance* and the *communication delay* between Earth and Mars feel real. It runs as a microsite and as a Chrome extension (same code).

🌐 **Live:** https://42-apps.github.io/marstalk/

---

## What it does

- **Real 3D solar system.** The Sun and inner planets are drawn at their true heliocentric positions for any date, using Keplerian orbital elements (JPL/Standish, valid 1800–2050).
- **The gulf, measured live.** A glowing line connects Earth and Mars. Read the distance (million km & AU), the **one-way light delay**, the **round-trip "ping"**, the **rocket transfer time**, and the **peak data rate** — all updating as you move through time.
- **Aim where Mars *will be*.** A dashed amber line and a ghost planet show where Mars will have moved to by the time a rocket arrives — the "lead the target" problem, drawn to scale.
- **Launch a Starship.** Fire a rocket and watch the chase play out in fast-forward. It flies the **real two-body transfer** (Lambert-solved + Kepler-propagated) from Earth's launch position to Mars's true position at arrival — speeding up near the Sun, slowing near aphelion — aiming at empty space until Mars slides in to meet it. A HUD shows the live **×real-time factor** (default ~30 s flight ≈ 700,000×) and **day X / N** progress; pick the flight length (15–120 s).
- **Find the best launch date.** A scrollable **launch-window table** lists the efficient Earth→Mars opportunities (low-energy Hohmann transfers, ~every 26 months) — found by Δv-minimising a Lambert transfer over the real ephemeris, with the best window flagged. Jump straight to one, then launch.
- **Time machine.** Drag the timeline to fly ±10 years. The track itself is a heatmap — bright where Earth and Mars are close, dark where they're on opposite sides of the Sun. Hit **▶** to watch the worlds orbit.
- **The Deep Space Network.** The three real DSN complexes — Goldstone (USA), Madrid (Spain), Canberra (Australia) — ride a spinning Earth ~120° apart, and the one currently facing Mars lights up and carries the signal.
- **Message the void — in real time.** Type a text, pick a direction, and a little envelope crosses the gap over the **actual one-way light delay** (a 17-minute lag really takes 17 minutes), clock counting real seconds. Send **as many as you like, both directions at once** — they spread into a stream across the void. Launch a rocket while messages are mid-flight and time fast-forwards, so they're simply marked delivered.

---

## The numbers (and the honesty)

- **Speed of light:** 299,792.458 km/s. Earth–Mars one-way delay ranges from ~3 minutes (closest approach) to ~22 minutes (conjunction).
- **Rocket:** the trajectory is a **real heliocentric two-body transfer** — a **Lambert solver** finds the orbit from Earth's launch position to Mars's true position, and **universal-variable Kepler propagation** flies the rocket along it (so it accelerates near perihelion and coasts near aphelion). Transfer time is a **per-date Hohmann estimate** from the actual orbital radii (~240–280 days; ~8–9 months), the path current chemical rockets use. Launch off a real transfer window and you'll get an honest, eccentric, inefficient orbit — but it still intercepts Mars, because we aim where Mars *will be*. (Still two-body: the Sun's gravity only — no planetary perturbations or finite-burn modelling.)
- **Data rate:** modeled on the **Mars Reconnaissance Orbiter**, which set the planetary record at **~6 Mbps** and runs **3–4 Mbps** near closest approach, dropping toward **~500 kbps** near conjunction. MarsTalk uses an inverse-square fit to those published anchors (X-band to a 34/70 m DSN dish).
- **Positions** are accurate to a few arc-minutes for 1800–2050 — plenty for visualizing geometry, not for navigation. The Earth spin / DSN hand-off is an illustrative continuous loop, not real-time station pointing.

Sources: NASA — [MRO X-band Communications](https://mars.nasa.gov/mro/mission/communications/commxband/), [Deep Space Network](https://www.jpl.nasa.gov/missions/dsn/); JPL/Standish, *Keplerian Elements for Approximate Positions of the Major Planets*.

---

## Install (Chrome extension)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Click the MarsTalk icon — it opens the full-tab experience.

## Run as a site

It's fully static. Open `index.html`, or serve the folder:

```bash
python3 -m http.server 8080   # then visit http://localhost:8080
```

---

## Project layout

```
index.html        full-tab app (microsite + extension entry)
marstalk.css      styles
js/astro.js       Keplerian positions, light-time, data-rate model, DSN data
js/scene.js       Three.js solar system, lines, DSN, rocket, photon
js/app.js         timeline, play, launch, messaging, stat binding
lib/              vendored three.min.js + OrbitControls (MV3 blocks remote scripts)
manifest.json     MV3 manifest (full-tab via background.js)
background.js     opens index.html on toolbar click
icons/            logo.svg + rendered PNGs
```

Built with [Three.js](https://threejs.org/). Have fun out there. 🚀
