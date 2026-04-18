# Artillery

Browser-only, turn-based artillery duel set on a distant sci-fi world. 2–4 players over peer-to-peer WebRTC, no backend.

**Live:** https://lettfeti.github.io/artillery/

## How it works

- Pure HTML / CSS / JS — no build step, no server.
- WebRTC via [PeerJS](https://peerjs.com/) (free public broker).
- Host creates a 6-character room code; joiners connect with the code.
- Host is authoritative: simulates the world, relays state to joiners, accepts inputs on each player's turn.
- Destructible terrain rendered as a bitmap mask; projectiles and movement collide pixel-by-pixel.

## Play

1. Open the link on each phone / browser.
2. Enter a callsign.
3. Host taps **Host game**, shares the code.
4. Others tap **Join game**, enter the code.
5. Host taps **Start match** once ≥2 commanders are in the lobby.

### Controls

**Touch:** tap the directional buttons to walk / jump, ↑↓ to aim, hold **FIRE** to charge power, release to fire. Tap the weapon icons to swap. For airstrike, tap on the battlefield to target.

**Keyboard:** ←/→ walk, ↑ jump, A/D aim, W/S power, Space hold to charge/fire, 1–4 select weapon.

## Weapons

- **Plasma Bazooka** — ∞ — direct fire, wind-affected.
- **Photon Grenade** — ×5 — arced throw, 3s fuse, bounces.
- **Antimatter Charge** — ×3 — dropped at feet, 3s fuse, big boom.
- **Orbital Strike** — ×2 — tap a spot; three bombs fall.

## Deploy

Static site — GitHub Pages serves `index.html` from `main`. No build.

## Local dev

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Files

- `index.html` — markup, screens, canvas
- `style.css` — all visuals
- `game.js` — game loop, terrain, physics, weapons, PeerJS, rendering
- `peerjs.min.js` — vendored
- `manifest.webmanifest` — PWA
