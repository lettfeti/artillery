(() => {
  'use strict';

  // =====================================================================
  //                          CONFIG & CONSTANTS
  // =====================================================================

  const W = 1600, H = 900;
  const PEER_PREFIX = 'artillery-lettfeti-';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const STORAGE_NAME = 'artillery_name_v1';

  const TURN_TIME = 30;                 // seconds
  const POST_TURN_WAIT = 90;            // frames of settling after fire before rolling turn
  const MAX_PLAYERS = 4;

  const GRAV = 0.35;
  const WALK_SPEED = 2.4;
  const JUMP_VY = -7.2;
  const WORM_R = 12;
  const WORM_HP = 100;
  const FALL_V_THRESHOLD = 10;          // vy at which fall damage kicks in
  const MAX_MOVE = 320;                 // pixels of horizontal travel allowed per turn
  const NET_TICK_MS = 80;               // host → joiner snapshot rate

  const SKY_COLORS = ['#070a1a', '#1a1f5e', '#3a1a5e'];
  const PLAYER_COLORS = [
    { id: 'cyan',   main: '#4dd0ff', glow: '#9be6ff' },
    { id: 'violet', main: '#a06cff', glow: '#d1b4ff' },
    { id: 'green',  main: '#66e4a6', glow: '#b0f2ce' },
    { id: 'amber',  main: '#ffd056', glow: '#ffe69c' },
  ];

  const WEAPONS = {
    bazooka:   { name: 'Plasma Bazooka',    ico: '►', ammo: Infinity },
    grenade:   { name: 'Photon Grenade',    ico: '●', ammo: 5 },
    dynamite:  { name: 'Antimatter Charge', ico: '♦', ammo: 3 },
    airstrike: { name: 'Orbital Strike',    ico: '☢', ammo: 2 },
  };
  const WEAPON_ORDER = ['bazooka', 'grenade', 'dynamite', 'airstrike'];

  // =====================================================================
  //                              STATE
  // =====================================================================

  const S = {
    screen: 'home',

    // net
    peer: null,
    conns: new Map(),        // host: peerId → DataConnection. joiner: single entry "host" → conn
    isHost: false,
    myId: null,              // peer id string (or 'host')
    hostId: null,
    code: null,
    solo: false,

    // meta
    myName: '',
    players: [],             // [{id, name, colorIdx, connected, isLocal, ready}]
    maxPlayers: MAX_PLAYERS,

    // world
    terrain: null,           // { mask: Uint8Array, canvas: HTMLCanvasElement }
    seed: 0,
    starfield: null,         // cached background canvas

    // match
    worms: [],               // [{id, playerId, colorIdx, x, y, vx, vy, hp, dead, facing, aim, onGround}]
    turnIdx: 0,              // index into worms of current turn; advance through alive
    turnTimer: TURN_TIME,
    wind: 0,
    weapon: 'bazooka',
    ammo: {},                // {playerId: {weapon: count}}
    projectiles: [],
    explosions: [],
    particles: [],
    fired: false,
    postTurnT: 0,
    awaitTarget: false,
    charging: false,
    chargePower: 0,          // 0..1
    banner: { text: '', t: 0 },
    winner: null,            // playerId or 'draw'
    matchStarted: false,

    // local input (only meaningful on whichever client owns the active worm)
    inputs: {
      left: false, right: false, jump: false,
      aimUp: false, aimDn: false,
    },
    // host maps playerId → latest inputs received
    perPlayerInputs: new Map(),

    // net scheduling
    lastSnap: 0,
  };

  const $ = (id) => document.getElementById(id);

  // =====================================================================
  //                         UTILITY / RNG
  // =====================================================================

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function genCode() {
    let out = '';
    const buf = new Uint32Array(6);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    for (let i = 0; i < 6; i++) out += CODE_CHARS[buf[i] % CODE_CHARS.length];
    return out;
  }
  function peerIdFromCode(code) { return PEER_PREFIX + code.toUpperCase() + '-host'; }

  function show(screen) {
    S.screen = screen;
    document.querySelectorAll('.screen').forEach((el) => {
      el.hidden = el.dataset.screen !== screen;
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // =====================================================================
  //                         TERRAIN (gen / destroy)
  // =====================================================================
  // The terrain is both a Uint8Array bitmask (1 = solid, used for physics)
  // and an HTMLCanvasElement (the painted visual). Destruction updates both:
  // the mask by clearing bits inside the circle, the canvas by erasing
  // pixels with globalCompositeOperation='destination-out'.

  function genTerrain(seed) {
    const rand = mulberry32(seed || 1);
    const heights = new Float32Array(W);
    // layered sinusoids → rolling alien terrain
    const layers = [
      { amp: 130, freq: 0.0028, phase: rand() * Math.PI * 2 },
      { amp: 60,  freq: 0.0075, phase: rand() * Math.PI * 2 },
      { amp: 28,  freq: 0.019,  phase: rand() * Math.PI * 2 },
      { amp: 12,  freq: 0.05,   phase: rand() * Math.PI * 2 },
    ];
    const base = H * 0.58;
    for (let x = 0; x < W; x++) {
      let h = base;
      for (const l of layers) h += l.amp * Math.sin(x * l.freq + l.phase);
      heights[x] = Math.max(160, Math.min(H - 60, h));
    }

    const mask = new Uint8Array(W * H);
    for (let x = 0; x < W; x++) {
      const top = Math.floor(heights[x]);
      for (let y = top; y < H - 20; y++) mask[y * W + x] = 1;
    }

    const tc = document.createElement('canvas');
    tc.width = W; tc.height = H;
    const g = tc.getContext('2d');

    // terrain body — layered fill
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#6b3aa8');
    grad.addColorStop(0.25, '#4b1f7a');
    grad.addColorStop(0.6, '#2a0f52');
    grad.addColorStop(1, '#0f062a');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, H - 20);
    for (let x = 0; x < W; x++) g.lineTo(x, heights[x]);
    g.lineTo(W, H - 20);
    g.closePath();
    g.fill();

    // glowing top edge (alien bioluminescence)
    g.beginPath();
    for (let x = 0; x < W; x++) {
      if (x === 0) g.moveTo(x, heights[x]);
      else g.lineTo(x, heights[x]);
    }
    g.strokeStyle = '#c58bff';
    g.lineWidth = 2;
    g.shadowColor = '#a06cff';
    g.shadowBlur = 14;
    g.stroke();
    g.shadowBlur = 0;

    // speckled mineral flecks
    for (let i = 0; i < 1400; i++) {
      const x = rand() * W;
      const topY = heights[x | 0];
      const y = topY + rand() * (H - topY - 20);
      const r = rand() * 1.6 + 0.4;
      g.fillStyle = rand() < 0.75 ? 'rgba(160, 108, 255, 0.22)' : 'rgba(77, 208, 255, 0.3)';
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }

    return { mask, canvas: tc, heights };
  }

  function destroyTerrain(x, y, r) {
    if (!S.terrain) return;
    const mask = S.terrain.mask;
    const r2 = r * r;
    const minX = Math.max(0, (x - r - 1) | 0);
    const maxX = Math.min(W - 1, (x + r + 1) | 0);
    const minY = Math.max(0, (y - r - 1) | 0);
    const maxY = Math.min(H - 1, (y + r + 1) | 0);
    for (let yy = minY; yy <= maxY; yy++) {
      for (let xx = minX; xx <= maxX; xx++) {
        const dx = xx - x, dy = yy - y;
        if (dx * dx + dy * dy <= r2) mask[yy * W + xx] = 0;
      }
    }
    const ctx = S.terrain.canvas.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // scorched halo
    ctx.save();
    const halo = ctx.createRadialGradient(x, y, r * 0.85, x, y, r * 1.25);
    halo.addColorStop(0, 'rgba(0,0,0,0)');
    halo.addColorStop(0.4, 'rgba(255, 140, 60, 0.22)');
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(x, y, r * 1.25, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function maskAt(x, y) {
    if (x < 0 || x >= W || y < 0 || y >= H) return 0;
    return S.terrain.mask[(y | 0) * W + (x | 0)];
  }

  // Sample a ring of points around a circle to test if it overlaps terrain.
  function circleInTerrain(cx, cy, r) {
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      if (maskAt(cx + Math.cos(a) * r, cy + Math.sin(a) * r)) return true;
    }
    return false;
  }

  // =====================================================================
  //                        PLAYERS / WORMS SETUP
  // =====================================================================

  function addPlayer(id, name, isLocal) {
    if (S.players.find((p) => p.id === id)) return;
    const colorIdx = S.players.length % PLAYER_COLORS.length;
    S.players.push({
      id, name: (name || 'Commander').slice(0, 16),
      colorIdx, connected: true, isLocal: !!isLocal,
    });
    S.ammo[id] = {};
    for (const k of WEAPON_ORDER) S.ammo[id][k] = WEAPONS[k].ammo;
  }

  function removePlayer(id) {
    const p = S.players.find((x) => x.id === id);
    if (!p) return;
    p.connected = false;
    // mark worm dead so turns skip
    const w = S.worms.find((w) => w.playerId === id);
    if (w && !w.dead) { w.dead = true; w.hp = 0; }
  }

  function placeWorms(seed) {
    S.worms = [];
    const rand = mulberry32(seed + 7919);
    const alive = S.players;
    // choose distinct x positions, min distance apart
    const slots = [];
    const tries = 200;
    for (const p of alive) {
      let placed = false;
      for (let t = 0; t < tries; t++) {
        const x = 120 + rand() * (W - 240);
        if (slots.every((s) => Math.abs(s - x) > 220)) {
          slots.push(x); placed = true; break;
        }
      }
      if (!placed) slots.push(200 + slots.length * 300);
    }
    for (let i = 0; i < alive.length; i++) {
      const x = slots[i];
      // drop down to terrain surface
      let y = 0;
      while (y < H - 20 && !maskAt(x, y + WORM_R + 1)) y++;
      S.worms.push({
        id: i,
        playerId: alive[i].id,
        colorIdx: alive[i].colorIdx,
        name: alive[i].name,
        x, y: Math.max(WORM_R + 20, y - WORM_R),
        vx: 0, vy: 0,
        hp: WORM_HP, dead: false,
        facing: x < W / 2 ? 1 : -1,
        aim: x < W / 2 ? -Math.PI / 4 : -3 * Math.PI / 4,
        onGround: true, _jumped: false,
        moveRem: MAX_MOVE,
      });
    }
  }

  function activeWorm() {
    if (!S.worms.length) return null;
    return S.worms[S.turnIdx] || null;
  }
  function activePlayerId() {
    const w = activeWorm();
    return w ? w.playerId : null;
  }

  function advanceTurn() {
    S.fired = false;
    S.postTurnT = 0;
    S.charging = false;
    S.chargePower = 0;
    S.awaitTarget = false;

    // reset inputs for everyone — prevents stuck "holding" after turn change
    S.inputs = { left: false, right: false, jump: false, aimUp: false, aimDn: false };
    S.perPlayerInputs.clear();

    // check win
    const aliveByPlayer = {};
    for (const w of S.worms) if (!w.dead) aliveByPlayer[w.playerId] = true;
    const winners = Object.keys(aliveByPlayer);
    if (winners.length <= 1) {
      S.winner = winners[0] || 'draw';
      if (S.isHost || S.solo) broadcast({ type: 'end', winner: S.winner });
      showBanner(S.winner === 'draw' ? 'Stalemate' : `${nameOf(S.winner)} wins!`);
      showEndBar();
      return;
    }

    // next alive worm (round-robin). In solo mode the dummy is a sandbox
    // target, not a player — stay on the user's worm forever.
    let n = S.worms.length;
    if (S.solo) {
      // keep current turnIdx; reset the turn for another shot
    } else {
      for (let i = 1; i <= n; i++) {
        const idx = (S.turnIdx + i) % n;
        if (!S.worms[idx].dead) { S.turnIdx = idx; break; }
      }
    }
    S.turnTimer = TURN_TIME;
    S.wind = (Math.random() * 2 - 1) * 0.7;

    const w = activeWorm();
    if (w) w.moveRem = MAX_MOVE;
    showBanner(`${nameOf(w.playerId)}'s turn`);
  }

  function nameOf(pid) {
    const p = S.players.find((x) => x.id === pid);
    return p ? p.name : '—';
  }

  // =====================================================================
  //                           INPUTS (active)
  // =====================================================================

  function activeInputs() {
    const pid = activePlayerId();
    if (!pid) return { left: false, right: false, jump: false, aimUp: false, aimDn: false };
    if (S.solo) return S.inputs;
    if (S.isHost) {
      if (pid === S.myId) return S.inputs;
      return S.perPlayerInputs.get(pid) || { left: false, right: false, jump: false, aimUp: false, aimDn: false };
    }
    // joiner: only send if it's my turn
    if (pid === S.myId) return S.inputs;
    return { left: false, right: false, jump: false, aimUp: false, aimDn: false };
  }

  function isMyTurn() {
    if (S.solo) return true;   // solo: control every worm locally
    return activePlayerId() === S.myId;
  }

  // =====================================================================
  //                           WORMS & PHYSICS
  // =====================================================================

  function applyDamage(w, amount) {
    if (w.dead) return;
    w.hp = Math.max(0, w.hp - Math.round(amount));
    if (w.hp <= 0) {
      w.dead = true;
      // puff of particles
      for (let i = 0; i < 22; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 1 + Math.random() * 4;
        S.particles.push({
          x: w.x, y: w.y,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2,
          life: 50, color: PLAYER_COLORS[w.colorIdx].main, size: 3,
        });
      }
    }
  }

  function updateWorm(w) {
    if (w.dead) return;

    const isActive = activeWorm() === w && !S.fired;
    const inputs = isActive ? activeInputs() : null;
    const xBefore = w.x;

    let wantDX = 0;
    if (inputs) {
      if (w.onGround) {
        // movement budget: once exhausted, the worm can still change
        // facing (so it can aim the other way) but can't walk further.
        const canWalk = (w.moveRem == null ? MAX_MOVE : w.moveRem) > 0;
        if (inputs.left)  { if (canWalk) wantDX = -WALK_SPEED; w.facing = -1; }
        if (inputs.right) { if (canWalk) wantDX =  WALK_SPEED; w.facing =  1; }
        if (inputs.jump && !w._jumped && canWalk) {
          w.vy = JUMP_VY;
          w.vx = (inputs.left ? -1 : inputs.right ? 1 : 0) * 2.8;
          w.onGround = false;
          w._jumped = true;
        }
        if (!inputs.jump) w._jumped = false;
      }
      // aim: keep it in the upper hemisphere (-π..0). Walk direction
      // picks left/right facing; aim angle freely swings across.
      const aimStep = 0.025;
      if (inputs.aimUp) w.aim -= aimStep;
      if (inputs.aimDn) w.aim += aimStep;
      w.aim = Math.max(-Math.PI * 0.995, Math.min(-Math.PI * 0.005, w.aim));
    }

    // gravity
    w.vy += GRAV;

    // horizontal intent + airborne momentum
    let nx = w.x + (w.onGround ? wantDX : w.vx);
    let ny = w.y + w.vy;

    // step-climb: if we hit terrain horizontally, try nudging up to 7px
    if (w.onGround && wantDX !== 0 && circleInTerrain(nx, w.y, WORM_R)) {
      let climbed = false;
      for (let up = 1; up <= 7; up++) {
        if (!circleInTerrain(nx, w.y - up, WORM_R)) {
          w.y -= up; climbed = true; break;
        }
      }
      if (!climbed) nx = w.x;
    }

    // vertical: settle onto ground / ceiling
    if (circleInTerrain(nx, ny, WORM_R)) {
      if (w.vy > 0) {
        // push up until clear
        let yy = ny;
        while (yy > 0 && circleInTerrain(nx, yy, WORM_R)) yy--;
        if (w.vy > FALL_V_THRESHOLD) {
          applyDamage(w, (w.vy - FALL_V_THRESHOLD) * 3);
        }
        ny = yy;
        w.vy = 0;
        w.onGround = true;
        w.vx = 0;
      } else {
        // moving up into ceiling
        w.vy = 0;
        ny = w.y;
      }
    } else {
      w.onGround = circleInTerrain(nx, ny + 2, WORM_R);
      if (!w.onGround) {
        // slight air drag
        w.vx *= 0.997;
      }
    }

    w.x = nx;
    w.y = ny;

    // consume movement budget from input-driven travel on the active worm.
    // Explosion knockback also moves the worm, but we only count walking,
    // not being blown around — so limit to cases where the player is holding
    // a direction on the ground.
    if (isActive && w.onGround && wantDX !== 0 && w.moveRem != null) {
      w.moveRem = Math.max(0, w.moveRem - Math.abs(w.x - xBefore));
    }

    // water / off-map death
    if (w.y > H - 30 || w.x < -30 || w.x > W + 30) {
      applyDamage(w, 999);
    }
  }

  // =====================================================================
  //                           PROJECTILES
  // =====================================================================
  // Projectile types:
  //   'rocket'   : direct-fire, wind-affected, explodes on contact.
  //   'grenade'  : bounces up to N times, fuse ticks down, explodes on fuse=0.
  //   'dynamite' : stationary-ish, fuse, big boom.
  //   'bomb'     : airstrike bombs, fall straight down.

  function fireRocket(x, y, ang, power) {
    S.projectiles.push({
      type: 'rocket', x, y,
      vx: Math.cos(ang) * power, vy: Math.sin(ang) * power,
      windAff: true, bounce: 0, fuse: null,
      radius: 55, damage: 50, age: 0, trail: true,
    });
  }
  function fireGrenade(x, y, ang, power) {
    S.projectiles.push({
      type: 'grenade', x, y,
      vx: Math.cos(ang) * power, vy: Math.sin(ang) * power,
      windAff: true, bounce: 3, fuse: 180,
      radius: 55, damage: 50, age: 0,
    });
  }
  function fireDynamite(x, y) {
    S.projectiles.push({
      type: 'dynamite', x, y: y - 5,
      vx: 0, vy: 0,
      windAff: false, bounce: 0, fuse: 180,
      radius: 78, damage: 75, age: 0,
    });
  }
  function fireAirstrike(tx) {
    // three bombs dropped with small x-spread
    for (let i = 0; i < 3; i++) {
      const ox = (i - 1) * 70 + (Math.random() * 20 - 10);
      S.projectiles.push({
        type: 'bomb', x: tx + ox, y: 30 + i * 25,
        vx: 0, vy: 2,
        windAff: false, bounce: 0, fuse: null,
        radius: 48, damage: 35, age: 0, trail: true,
      });
    }
  }

  function approxNormal(x, y) {
    // finite-difference gradient of mask (smoothed)
    let gx = 0, gy = 0;
    const r = 3;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (maskAt(x + dx, y + dy)) { gx -= dx; gy -= dy; }
      }
    }
    const m = Math.hypot(gx, gy);
    if (m < 0.001) return { x: 0, y: -1 };
    return { x: gx / m, y: gy / m };
  }

  function updateProjectile(p) {
    p.age++;
    if (p.windAff) p.vx += S.wind * 0.04;
    p.vy += GRAV * 0.9;

    const nx = p.x + p.vx;
    const ny = p.y + p.vy;

    // hit terrain?
    if (maskAt(nx, ny)) {
      if (p.bounce > 0) {
        const nrm = approxNormal(nx, ny);
        const dot = p.vx * nrm.x + p.vy * nrm.y;
        p.vx = (p.vx - 2 * dot * nrm.x) * 0.55;
        p.vy = (p.vy - 2 * dot * nrm.y) * 0.55;
        p.bounce--;
        p.x += p.vx * 0.5; p.y += p.vy * 0.5;
        return;
      }
      if (p.fuse != null) {
        // rest roughly in place, keep ticking
        p.vx *= 0.4; p.vy = 0;
        p.x = nx; p.y = ny - 1;
      } else {
        // explode on contact
        doExplosion(p.x, p.y, p.radius, p.damage, p.type);
        p.dead = true;
        return;
      }
    } else {
      p.x = nx; p.y = ny;
    }

    // worm direct hit (only non-fuse projectiles — grenade bounces off worms too)
    if (p.fuse == null) {
      for (const w of S.worms) {
        if (w.dead) continue;
        const dx = w.x - p.x, dy = w.y - p.y;
        if (dx * dx + dy * dy < (WORM_R + 3) * (WORM_R + 3)) {
          doExplosion(p.x, p.y, p.radius, p.damage, p.type);
          p.dead = true;
          return;
        }
      }
    }

    // fuse expire
    if (p.fuse != null) {
      p.fuse--;
      if (p.fuse <= 0) {
        doExplosion(p.x, p.y, p.radius, p.damage, p.type);
        p.dead = true;
        return;
      }
    }

    // out of bounds
    if (p.x < -80 || p.x > W + 80 || p.y > H + 80) p.dead = true;

    // trail particle
    if (p.trail && p.age % 2 === 0) {
      S.particles.push({
        x: p.x, y: p.y,
        vx: -p.vx * 0.1 + (Math.random() - 0.5),
        vy: -p.vy * 0.1 + (Math.random() - 0.5),
        life: 20, color: 'rgba(255, 200, 120, 0.6)', size: 2,
      });
    }
  }

  function doExplosion(x, y, r, dmg, kind) {
    destroyTerrain(x, y, r);

    for (const w of S.worms) {
      if (w.dead) continue;
      const dx = w.x - x, dy = w.y - y;
      const d = Math.hypot(dx, dy);
      const edge = r + WORM_R;
      if (d < edge) {
        const falloff = 1 - d / edge;
        applyDamage(w, dmg * falloff);
        const k = falloff * 9;
        const inv = d > 0.001 ? 1 / d : 0;
        w.vx += dx * inv * k;
        w.vy += dy * inv * k - 2;
        w.onGround = false;
      }
    }

    S.explosions.push({ x, y, r, t: 0, max: 24 });
    const colors = ['#ff6a8a', '#ffb866', '#fff2aa', '#ffffff'];
    const count = Math.min(36, 12 + (r / 4) | 0);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 6;
      S.particles.push({
        x, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1.5,
        life: 30 + Math.random() * 25,
        color: colors[(Math.random() * colors.length) | 0],
        size: 2 + Math.random() * 2,
      });
    }

    if (S.isHost) {
      broadcast({ type: 'destroy', x, y, r });
      broadcast({ type: 'explosion', x, y, r, kind });
    }
  }

  // =====================================================================
  //                           FIRING
  // =====================================================================

  function ammoOf(pid, wpn) {
    const a = S.ammo[pid];
    return a ? a[wpn] : 0;
  }
  function consumeAmmo(pid, wpn) {
    const a = S.ammo[pid];
    if (!a) return;
    if (a[wpn] !== Infinity) a[wpn] = Math.max(0, a[wpn] - 1);
  }

  // Called on host (and solo). Fires the active worm's current weapon.
  function doFire(power01, targetX, targetY) {
    if (S.fired || S.winner) return;
    const w = activeWorm();
    if (!w || w.dead) return;
    const wpn = S.weapon;
    if (ammoOf(w.playerId, wpn) <= 0) return;

    if (wpn === 'airstrike') {
      if (targetX == null) return;   // need a target tap
      fireAirstrike(targetX);
    } else if (wpn === 'dynamite') {
      fireDynamite(w.x, w.y);
    } else {
      const power = 6 + power01 * 14;     // power scale 6..20
      const muzzleX = w.x + Math.cos(w.aim) * (WORM_R + 2);
      const muzzleY = w.y + Math.sin(w.aim) * (WORM_R + 2);
      if (wpn === 'bazooka') fireRocket(muzzleX, muzzleY, w.aim, power);
      else if (wpn === 'grenade') fireGrenade(muzzleX, muzzleY, w.aim, power * 0.9);
    }

    consumeAmmo(w.playerId, wpn);
    S.fired = true;
    S.charging = false;
    S.chargePower = 0;
    S.awaitTarget = false;
  }

  // =====================================================================
  //                              PeerJS
  // =====================================================================

  const TRANSIENT = new Set(['network', 'socket-error', 'socket-closed', 'server-error', 'disconnected']);
  const ERR_MSG = {
    'network': 'Network issue — check your connection',
    'socket-error': 'Network issue — check your connection',
    'socket-closed': 'Connection dropped',
    'server-error': 'Matchmaking server unavailable',
    'disconnected': 'Disconnected from matchmaking',
    'browser-incompatible': 'Browser does not support WebRTC',
    'peer-unavailable': 'Could not find that game. Check the code.',
    'invalid-id': 'Invalid game code',
    'unavailable-id': 'Code already in use',
  };
  function errText(e) { return (e && ERR_MSG[e.type]) || (e && e.message) || 'Unknown error'; }

  function createPeer(id) {
    if (typeof Peer === 'undefined') throw new Error('PeerJS failed to load. Reload the page.');
    const opts = { debug: 1 };
    return id ? new Peer(id, opts) : new Peer(opts);
  }
  function destroyPeer() {
    try { for (const c of S.conns.values()) c.close && c.close(); } catch {}
    try { if (S.peer) S.peer.destroy(); } catch {}
    S.peer = null;
    S.conns.clear();
  }

  // =====================================================================
  //                             HOSTING
  // =====================================================================

  let hostRetries = 0;

  function hostGame() {
    S.solo = false;
    S.isHost = true;
    S.code = genCode();
    S.matchStarted = false;
    S.players = [];
    S.ammo = {};
    S.myId = 'host';
    S.hostId = 'host';
    addPlayer('host', S.myName, true);
    show('lobby');
    renderLobby(true);

    destroyPeer();
    let peer;
    try { peer = createPeer(peerIdFromCode(S.code)); }
    catch (e) { $('lobbyStatus').textContent = e.message; return; }
    S.peer = peer;

    peer.on('open', () => {
      hostRetries = 0;
      $('lobbyStatus').textContent = 'Share the code. 2–4 commanders.';
    });
    peer.on('connection', (conn) => {
      if (S.matchStarted) { try { conn.close(); } catch {} return; }
      if (S.players.length >= MAX_PLAYERS) { try { conn.close(); } catch {} return; }
      setupHostConn(conn);
    });
    peer.on('disconnected', () => {
      try { peer.reconnect(); } catch {}
    });
    peer.on('error', (err) => {
      console.error('[host] peer error', err);
      if (err.type === 'unavailable-id') { destroyPeer(); setTimeout(hostGame, 200); return; }
      if (TRANSIENT.has(err.type) && hostRetries < 2) {
        hostRetries++;
        $('lobbyStatus').textContent = `Network hiccup, retrying (${hostRetries}/2)…`;
        return;
      }
      $('lobbyStatus').textContent = errText(err);
    });
  }

  function setupHostConn(conn) {
    conn.on('open', () => {
      S.conns.set(conn.peer, conn);
      // we wait for 'hello' to learn the joiner's name, then add & broadcast
    });
    conn.on('data', (msg) => onHostMessage(conn, msg));
    conn.on('close', () => {
      S.conns.delete(conn.peer);
      removePlayer(conn.peer);
      if (!S.matchStarted) renderLobby(true);
      else broadcastSnapshot(true);
    });
    conn.on('error', (e) => console.error('conn err', e));
  }

  function onHostMessage(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'hello': {
        addPlayer(conn.peer, msg.name, false);
        // tell the new joiner who everyone is
        conn.send({
          type: 'welcome',
          myId: conn.peer,
          hostId: 'host',
          players: S.players.map(publicPlayer),
        });
        // broadcast updated lobby to everyone else
        broadcastLobby();
        renderLobby(true);
        break;
      }
      case 'setName': {
        const p = S.players.find((x) => x.id === conn.peer);
        if (p) { p.name = (msg.name || '').slice(0, 16) || p.name; }
        broadcastLobby();
        renderLobby(true);
        break;
      }
      case 'input': {
        if (!S.matchStarted || S.winner) return;
        if (conn.peer !== activePlayerId()) return;
        S.perPlayerInputs.set(conn.peer, msg.inputs || {});
        break;
      }
      case 'weapon': {
        if (!S.matchStarted || S.winner || S.fired) return;
        if (conn.peer !== activePlayerId()) return;
        if (WEAPONS[msg.key]) {
          S.weapon = msg.key;
          S.awaitTarget = (msg.key === 'airstrike');
        }
        break;
      }
      case 'fire': {
        if (!S.matchStarted || S.winner || S.fired) return;
        if (conn.peer !== activePlayerId()) return;
        doFire(clamp01(+msg.power || 0));
        break;
      }
      case 'target': {
        if (!S.matchStarted || S.winner || S.fired) return;
        if (conn.peer !== activePlayerId()) return;
        if (S.weapon === 'airstrike') doFire(0, +msg.x, +msg.y);
        break;
      }
      case 'rematch': {
        // host decides when to restart
        if (S.winner) startMatch();
        break;
      }
      case 'bye': {
        removePlayer(conn.peer);
        try { conn.close(); } catch {}
        break;
      }
    }
  }

  function publicPlayer(p) {
    return { id: p.id, name: p.name, colorIdx: p.colorIdx, connected: p.connected };
  }
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  function broadcast(msg) {
    for (const c of S.conns.values()) { try { if (c.open) c.send(msg); } catch {} }
  }
  function broadcastLobby() {
    broadcast({ type: 'lobby', players: S.players.map(publicPlayer) });
  }

  function broadcastSnapshot(force) {
    if (!S.isHost || !S.matchStarted) return;
    const now = Date.now();
    if (!force && now - S.lastSnap < NET_TICK_MS) return;
    S.lastSnap = now;
    broadcast({
      type: 'state',
      worms: S.worms.map((w) => ({
        id: w.id, pid: w.playerId, ci: w.colorIdx, x: w.x|0, y: w.y|0,
        vx: +w.vx.toFixed(2), vy: +w.vy.toFixed(2),
        hp: w.hp, d: w.dead ? 1 : 0, f: w.facing, a: +w.aim.toFixed(3),
        mr: w.moveRem == null ? MAX_MOVE : w.moveRem|0,
      })),
      proj: S.projectiles.map((p) => ({
        t: p.type, x: p.x|0, y: p.y|0, vx: +p.vx.toFixed(2), vy: +p.vy.toFixed(2),
        fuse: p.fuse, age: p.age,
      })),
      turnIdx: S.turnIdx, turnTimer: +S.turnTimer.toFixed(1),
      wind: +S.wind.toFixed(3), weapon: S.weapon, awaitTarget: !!S.awaitTarget,
      charging: !!S.charging, chargePower: +S.chargePower.toFixed(3),
      ammo: S.ammo, fired: !!S.fired, winner: S.winner,
    });
  }

  // =====================================================================
  //                              JOINING
  // =====================================================================

  let joinRetries = 0;

  function joinGame(code) {
    code = (code || '').toUpperCase().trim();
    if (code.length !== 6) {
      $('joinStatus').textContent = 'Code must be 6 characters.';
      return;
    }
    S.solo = false;
    S.isHost = false;
    S.code = code;
    show('connecting');
    $('connectStatus').textContent = 'Opening channel…';
    $('joinRetryBtn').hidden = true;

    destroyPeer();
    let peer;
    try { peer = createPeer(null); }
    catch (e) { $('connectStatus').textContent = e.message; return; }
    S.peer = peer;

    peer.on('open', (id) => {
      S.myId = id;
      joinRetries = 0;
      $('connectStatus').textContent = 'Finding host…';
      const conn = peer.connect(peerIdFromCode(code), { reliable: true });
      S.conns.set('host', conn);
      setupJoinerConn(conn);
      setTimeout(() => {
        if (S.screen === 'connecting' && !(conn && conn.open)) {
          $('connectStatus').textContent = 'Could not find that game.';
          $('joinRetryBtn').hidden = false;
        }
      }, 9000);
    });
    peer.on('disconnected', () => { try { peer.reconnect(); } catch {} });
    peer.on('error', (err) => {
      console.error('[join] peer error', err);
      if (TRANSIENT.has(err.type) && joinRetries < 2) {
        joinRetries++;
        $('connectStatus').textContent = `Network hiccup, retrying (${joinRetries}/2)…`;
        return;
      }
      if (S.screen === 'connecting') {
        $('connectStatus').textContent = errText(err);
        $('joinRetryBtn').hidden = false;
      }
    });
  }

  function setupJoinerConn(conn) {
    conn.on('open', () => {
      conn.send({ type: 'hello', name: S.myName });
      setConnDot(true);
    });
    conn.on('data', onJoinerMessage);
    conn.on('close', () => {
      setConnDot(false);
      if (S.screen === 'game') {
        showBanner('Host disconnected');
        S.winner = 'draw';
        showEndBar();
      } else if (S.screen === 'connecting') {
        $('connectStatus').textContent = 'Disconnected';
      }
    });
    conn.on('error', (e) => console.error('conn err', e));
  }

  function onJoinerMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'welcome':
        S.myId = msg.myId;
        S.hostId = msg.hostId;
        S.players = msg.players || [];
        show('lobby');
        renderLobby(false);
        break;
      case 'lobby':
        S.players = msg.players || [];
        renderLobby(false);
        break;
      case 'start':
        S.seed = msg.seed;
        S.terrain = genTerrain(S.seed);
        // copy worms
        S.worms = (msg.worms || []).map((w) => ({
          id: w.id, playerId: w.pid, colorIdx: w.ci, name: w.name,
          x: w.x, y: w.y, vx: 0, vy: 0, hp: w.hp,
          dead: false, facing: w.f, aim: w.a, onGround: true,
          moveRem: MAX_MOVE,
        }));
        S.turnIdx = msg.turnIdx || 0;
        S.wind = msg.wind || 0;
        S.ammo = msg.ammo || {};
        S.weapon = msg.weapon || 'bazooka';
        S.projectiles = []; S.explosions = []; S.particles = [];
        S.winner = null; S.matchStarted = true;
        show('game');
        buildWeaponRow();
        resizeCanvas();
        break;
      case 'state':
        applySnapshot(msg);
        break;
      case 'destroy':
        destroyTerrain(msg.x, msg.y, msg.r);
        break;
      case 'explosion':
        // visual-only copy
        S.explosions.push({ x: msg.x, y: msg.y, r: msg.r, t: 0, max: 24 });
        for (let i = 0; i < 20; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 2 + Math.random() * 5;
          S.particles.push({
            x: msg.x, y: msg.y,
            vx: Math.cos(a)*sp, vy: Math.sin(a)*sp - 1.5,
            life: 30 + Math.random()*25,
            color: ['#ff6a8a','#ffb866','#fff2aa'][(Math.random()*3)|0],
            size: 2 + Math.random()*2,
          });
        }
        break;
      case 'end':
        S.winner = msg.winner;
        showBanner(S.winner === 'draw' ? 'Stalemate' : `${nameOf(S.winner)} wins!`);
        showEndBar();
        break;
      case 'banner':
        showBanner(msg.text);
        break;
    }
  }

  function applySnapshot(s) {
    if (!s) return;
    // worms: reconcile by id
    const byId = new Map(S.worms.map((w) => [w.id, w]));
    S.worms = (s.worms || []).map((n) => {
      const prev = byId.get(n.id) || {};
      return {
        ...prev,
        id: n.id, playerId: n.pid, colorIdx: n.ci,
        x: n.x, y: n.y, vx: n.vx, vy: n.vy, hp: n.hp,
        dead: !!n.d, facing: n.f, aim: n.a,
        moveRem: n.mr != null ? n.mr : (prev.moveRem != null ? prev.moveRem : MAX_MOVE),
        name: prev.name || (S.players.find((p) => p.id === n.pid)?.name) || '',
      };
    });
    S.projectiles = (s.proj || []).map((p) => ({
      type: p.t, x: p.x, y: p.y, vx: p.vx, vy: p.vy, fuse: p.fuse, age: p.age,
      radius: (WEAPONS[p.t]?.radius) || 50, trail: p.t !== 'grenade',
    }));
    S.turnIdx = s.turnIdx;
    S.turnTimer = s.turnTimer;
    S.wind = s.wind;
    S.weapon = s.weapon;
    S.ammo = s.ammo;
    S.awaitTarget = !!s.awaitTarget;
    S.charging = !!s.charging;
    S.chargePower = +s.chargePower || 0;
    S.fired = !!s.fired;
    S.winner = s.winner;
    updateWeaponRow();
  }

  // =====================================================================
  //                           MATCH LIFECYCLE
  // =====================================================================

  function startMatch() {
    S.seed = (Math.random() * 1e9) | 0;
    S.terrain = genTerrain(S.seed);
    placeWorms(S.seed);
    // reset ammo
    for (const p of S.players) {
      S.ammo[p.id] = {};
      for (const k of WEAPON_ORDER) S.ammo[p.id][k] = WEAPONS[k].ammo;
    }
    S.turnIdx = 0;
    S.turnTimer = TURN_TIME;
    S.wind = (Math.random() * 2 - 1) * 0.7;
    S.weapon = 'bazooka';
    S.projectiles = []; S.explosions = []; S.particles = [];
    S.fired = false; S.postTurnT = 0; S.awaitTarget = false;
    S.charging = false; S.chargePower = 0;
    S.winner = null; S.matchStarted = true;

    if (S.isHost) {
      broadcast({
        type: 'start',
        seed: S.seed,
        worms: S.worms.map((w) => ({
          id: w.id, pid: w.playerId, ci: w.colorIdx, name: w.name,
          x: w.x, y: w.y, hp: w.hp, f: w.facing, a: w.aim,
        })),
        turnIdx: S.turnIdx, wind: S.wind, weapon: S.weapon, ammo: S.ammo,
      });
    }

    show('game');
    $('endbar').hidden = true;
    buildWeaponRow();
    resizeCanvas();
    showBanner(`${nameOf(activePlayerId())}'s turn`);
  }

  // Solo mode — just host locally vs a second local worm (practice)
  function soloGame() {
    destroyPeer();
    S.solo = true;
    S.isHost = true;
    S.myId = 'local';
    S.hostId = 'local';
    S.players = [];
    S.ammo = {};
    addPlayer('local', S.myName || 'You', true);
    addPlayer('cpu', 'Dummy', true);      // second worm is a sandbox target
    startMatch();
  }

  function goHome() {
    if (S.conns.size) {
      try { broadcast({ type: 'bye' }); } catch {}
    }
    destroyPeer();
    S.matchStarted = false;
    S.winner = null;
    S.players = [];
    S.worms = [];
    S.projectiles = []; S.explosions = []; S.particles = [];
    S.solo = false;
    S.isHost = false;
    $('endbar').hidden = true;
    show('home');
  }

  // =====================================================================
  //                           GAME LOOP
  // =====================================================================

  let rafLast = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - rafLast) / 1000);
    rafLast = now;
    tick(dt);
    render();
    requestAnimationFrame(loop);
  }

  function tick(dt) {
    if (S.screen !== 'game' || !S.matchStarted) return;

    // HOST / SOLO simulates. Joiner just interpolates from snapshots.
    if (S.isHost || S.solo) {
      // turn timer
      if (!S.fired && !S.winner) {
        S.turnTimer -= dt;
        if (S.turnTimer <= 0) {
          // time up: end turn (no fire)
          S.turnTimer = 0;
          S.fired = true;       // treat as fired so we roll to next turn
          showBanner('Time!');
          if (S.isHost) broadcast({ type: 'banner', text: 'Time!' });
        }
      }

      // charging updates power
      if (S.charging) S.chargePower = Math.min(1, S.chargePower + dt / 1.5);

      // simulate worms
      for (const w of S.worms) updateWorm(w);

      // simulate projectiles
      for (const p of S.projectiles) if (!p.dead) updateProjectile(p);
      S.projectiles = S.projectiles.filter((p) => !p.dead);

      // end-of-turn cleanup: after fire+settle, advance
      if (S.fired && !S.winner) {
        const moving = S.projectiles.length > 0
          || S.worms.some((w) => !w.dead && (Math.abs(w.vx) > 0.05 || Math.abs(w.vy) > 0.08 || !w.onGround));
        if (!moving) {
          S.postTurnT += dt;
          if (S.postTurnT > 0.9) advanceTurn();
        } else {
          S.postTurnT = 0;
        }
      }

      broadcastSnapshot();
    }

    // visuals advance on everyone
    for (const e of S.explosions) e.t++;
    S.explosions = S.explosions.filter((e) => e.t < e.max);
    for (const pr of S.particles) {
      pr.vy += 0.12;
      pr.x += pr.vx;
      pr.y += pr.vy;
      pr.vx *= 0.99;
      pr.life--;
    }
    S.particles = S.particles.filter((p) => p.life > 0);

    if (S.banner.t > 0) S.banner.t--;

    updateHUD();
  }

  // =====================================================================
  //                           RENDERING
  // =====================================================================

  const canvas = () => $('game');
  function ensureStarfield() {
    if (S.starfield) return S.starfield;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    const rand = mulberry32(42);
    for (let i = 0; i < 240; i++) {
      const x = rand() * W, y = rand() * (H * 0.7);
      const r = rand() * 1.4 + 0.2;
      const a = 0.3 + rand() * 0.7;
      g.fillStyle = `rgba(${200 + (rand()*55)|0},${200 + (rand()*55)|0},255,${a})`;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    // big distant planet
    const grd = g.createRadialGradient(W * 0.82, H * 0.2, 10, W * 0.82, H * 0.2, 120);
    grd.addColorStop(0, 'rgba(160,108,255,0.9)');
    grd.addColorStop(0.5, 'rgba(110,70,200,0.5)');
    grd.addColorStop(1, 'rgba(40,20,90,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(W * 0.82, H * 0.2, 120, 0, Math.PI * 2); g.fill();
    // small moon
    g.fillStyle = 'rgba(220, 240, 255, 0.9)';
    g.beginPath(); g.arc(W * 0.18, H * 0.14, 16, 0, Math.PI * 2); g.fill();

    S.starfield = c;
    return c;
  }

  function resizeCanvas() {
    const c = canvas();
    if (!c) return;
    c.width = W;
    c.height = H;
  }

  function render() {
    if (S.screen !== 'game') return;
    const c = canvas();
    if (!c) return;
    const ctx = c.getContext('2d');

    // sky
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, SKY_COLORS[0]);
    sky.addColorStop(0.55, SKY_COLORS[1]);
    sky.addColorStop(1, SKY_COLORS[2]);
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);

    // stars / distant bodies
    ctx.drawImage(ensureStarfield(), 0, 0);

    // terrain
    if (S.terrain) ctx.drawImage(S.terrain.canvas, 0, 0);

    // water line
    const water = ctx.createLinearGradient(0, H - 30, 0, H);
    water.addColorStop(0, 'rgba(77, 208, 255, 0.05)');
    water.addColorStop(1, 'rgba(30, 120, 220, 0.7)');
    ctx.fillStyle = water; ctx.fillRect(0, H - 30, W, 30);
    // subtle wave
    ctx.strokeStyle = 'rgba(180, 230, 255, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const wavT = performance.now() * 0.002;
    for (let x = 0; x < W; x += 10) {
      const y = H - 26 + Math.sin(x * 0.02 + wavT) * 2;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // projectiles
    for (const p of S.projectiles) drawProjectile(ctx, p);

    // worms
    for (const w of S.worms) drawWorm(ctx, w);

    // aim line on active worm (only on current turn, pre-fire)
    const aw = activeWorm();
    if (aw && !aw.dead && !S.fired && !S.winner && S.matchStarted) drawAim(ctx, aw);

    // explosions + particles
    for (const e of S.explosions) drawExplosion(ctx, e);
    for (const p of S.particles) drawParticle(ctx, p);

    // airstrike target reticle
    if (S.awaitTarget && !S.fired && aw) drawAirReticle(ctx);
  }

  function drawWorm(ctx, w) {
    if (w.dead) return;
    const col = PLAYER_COLORS[w.colorIdx];

    // name + HP bar
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.font = 'bold 18px -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = col.glow;
    ctx.shadowColor = col.main; ctx.shadowBlur = 8;
    ctx.fillText(w.name || '', w.x, w.y - WORM_R - 22);
    ctx.shadowBlur = 0;

    // HP bar
    const barW = 50, barH = 6;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(w.x - barW/2, w.y - WORM_R - 18, barW, barH);
    const pct = Math.max(0, w.hp / WORM_HP);
    const hpCol = pct > 0.5 ? '#66e4a6' : pct > 0.25 ? '#ffd056' : '#ff6a8a';
    ctx.fillStyle = hpCol;
    ctx.fillRect(w.x - barW/2, w.y - WORM_R - 18, barW * pct, barH);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.strokeRect(w.x - barW/2 + 0.5, w.y - WORM_R - 18 + 0.5, barW - 1, barH - 1);

    // move budget — shown on the active worm only
    if (activeWorm() === w && !S.fired && w.moveRem != null) {
      const mpct = Math.max(0, Math.min(1, w.moveRem / MAX_MOVE));
      const mH = 3;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(w.x - barW/2, w.y - WORM_R - 10, barW, mH);
      ctx.fillStyle = mpct > 0.3 ? '#4dd0ff' : '#ffb866';
      ctx.fillRect(w.x - barW/2, w.y - WORM_R - 10, barW * mpct, mH);
    }

    // body glow
    ctx.save();
    const body = ctx.createRadialGradient(w.x, w.y - 2, 2, w.x, w.y, WORM_R + 6);
    body.addColorStop(0, col.glow);
    body.addColorStop(0.6, col.main);
    body.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = body;
    ctx.shadowColor = col.main; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(w.x, w.y, WORM_R, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // helmet visor
    ctx.save();
    ctx.fillStyle = 'rgba(8, 16, 40, 0.9)';
    ctx.beginPath();
    ctx.ellipse(w.x + w.facing * 2, w.y - 2, WORM_R * 0.78, WORM_R * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    // visor highlight
    ctx.fillStyle = 'rgba(160, 220, 255, 0.5)';
    ctx.beginPath();
    ctx.ellipse(w.x + w.facing * 2 - 3, w.y - 5, 5, 2.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // eyes through visor
    ctx.fillStyle = '#e6ecff';
    ctx.beginPath(); ctx.arc(w.x + w.facing * 3, w.y - 2, 1.4, 0, Math.PI * 2); ctx.fill();
  }

  function drawAim(ctx, w) {
    const isLocalTurn = S.isHost ? (activePlayerId() === S.myId || S.solo) : (activePlayerId() === S.myId);
    const len = 60 + (S.charging ? S.chargePower * 80 : 50);
    ctx.save();
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = isLocalTurn ? '#fff2aa' : 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.moveTo(w.x, w.y);
    ctx.lineTo(w.x + Math.cos(w.aim) * len, w.y + Math.sin(w.aim) * len);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // charging power ring around worm
    if (S.charging) {
      ctx.save();
      ctx.strokeStyle = `rgba(255, 220, 120, ${0.4 + 0.6 * S.chargePower})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(w.x, w.y, WORM_R + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * S.chargePower);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawProjectile(ctx, p) {
    ctx.save();
    if (p.type === 'rocket' || p.type === 'bomb') {
      // plasma bolt
      const ang = Math.atan2(p.vy, p.vx);
      ctx.translate(p.x, p.y);
      ctx.rotate(ang);
      const g = ctx.createLinearGradient(-12, 0, 6, 0);
      g.addColorStop(0, 'rgba(255,180,60,0)');
      g.addColorStop(0.6, 'rgba(255,200,80,0.9)');
      g.addColorStop(1, '#fff2aa');
      ctx.fillStyle = g;
      ctx.shadowColor = '#ffb866'; ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.ellipse(0, 0, 12, 4, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (p.type === 'grenade') {
      ctx.translate(p.x, p.y);
      ctx.fillStyle = '#66e4a6';
      ctx.shadowColor = '#66e4a6'; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill();
      // blinking fuse indicator
      if (p.fuse != null && (p.fuse % 20 < 10)) {
        ctx.fillStyle = '#ff6a8a';
        ctx.beginPath(); ctx.arc(0, -5, 2, 0, Math.PI * 2); ctx.fill();
      }
    } else if (p.type === 'dynamite') {
      ctx.translate(p.x, p.y);
      ctx.fillStyle = '#ff6a8a';
      ctx.shadowColor = '#ff6a8a'; ctx.shadowBlur = 14;
      ctx.fillRect(-5, -9, 10, 18);
      ctx.fillStyle = '#ffd056';
      ctx.fillRect(-5, -9, 10, 3);
      // fuse blink
      if (p.fuse != null && (p.fuse % 16 < 8)) {
        ctx.fillStyle = '#fff2aa';
        ctx.beginPath(); ctx.arc(0, -11, 2.4, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawExplosion(ctx, e) {
    const k = e.t / e.max;
    const r = e.r * (0.4 + k * 1.1);
    ctx.save();
    const g = ctx.createRadialGradient(e.x, e.y, 2, e.x, e.y, r);
    g.addColorStop(0, `rgba(255, 245, 200, ${1 - k})`);
    g.addColorStop(0.5, `rgba(255, 160, 60, ${0.8 * (1 - k)})`);
    g.addColorStop(1, 'rgba(255, 60, 40, 0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(e.x, e.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawParticle(ctx, p) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 40));
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size || 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawAirReticle(ctx) {
    const t = performance.now() * 0.003;
    const x = S._airHover?.x ?? W / 2;
    const y = S._airHover?.y ?? H / 3;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 106, 138, 0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.arc(x, y, 40 + Math.sin(t) * 4, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(x - 16, y); ctx.lineTo(x + 16, y);
    ctx.moveTo(x, y - 16); ctx.lineTo(x, y + 16);
    ctx.stroke();
    ctx.restore();
  }

  // =====================================================================
  //                              HUD / UI
  // =====================================================================

  function updateHUD() {
    if (S.screen !== 'game') return;
    const w = activeWorm();
    const col = w ? PLAYER_COLORS[w.colorIdx] : null;
    const tn = $('turnName');
    tn.textContent = w ? (nameOf(w.playerId) + (activePlayerId() === S.myId ? ' (you)' : '')) : '—';
    if (col) { tn.style.color = col.main; tn.style.textShadow = `0 0 10px ${col.main}`; }
    const tt = $('turnTimer');
    tt.textContent = Math.max(0, Math.ceil(S.turnTimer));
    tt.classList.toggle('low', S.turnTimer < 8);

    const arrow = $('windArrow');
    const windVal = $('windVal');
    const absW = Math.abs(S.wind);
    arrow.style.transform = `rotate(${S.wind >= 0 ? 0 : 180}deg) scaleX(${0.5 + Math.min(1.5, absW * 2)})`;
    arrow.style.color = absW < 0.2 ? '#8896c2' : '#4dd0ff';
    windVal.textContent = S.wind.toFixed(2);

    $('weaponLabel').textContent = WEAPONS[S.weapon].name;
    const pid = activePlayerId();
    const a = pid && S.ammo[pid] ? S.ammo[pid][S.weapon] : 0;
    $('weaponAmmo').textContent = a === Infinity ? '∞' : `×${a}`;

    $('powerBar').hidden = !S.charging;
    $('powerFill').style.width = (S.chargePower * 100).toFixed(0) + '%';

    // controls enabled only on our turn
    const our = isMyTurn() && !S.fired && !S.winner && S.matchStarted;
    document.querySelectorAll('.cbtn').forEach((b) => { b.disabled = !our; });
    updateWeaponRow();
  }

  function buildWeaponRow() {
    const row = $('weaponRow');
    row.innerHTML = '';
    for (const k of WEAPON_ORDER) {
      const btn = document.createElement('button');
      btn.className = 'wbtn';
      btn.dataset.key = k;
      btn.innerHTML = `<span class="wico">${WEAPONS[k].ico}</span><div>${WEAPONS[k].name.split(' ')[0]}</div><div class="wammo"></div>`;
      btn.addEventListener('click', () => selectWeapon(k));
      row.appendChild(btn);
    }
    updateWeaponRow();
  }
  function updateWeaponRow() {
    const pid = activePlayerId();
    document.querySelectorAll('.wbtn').forEach((btn) => {
      const k = btn.dataset.key;
      btn.classList.toggle('active', k === S.weapon);
      const a = pid && S.ammo[pid] ? S.ammo[pid][k] : 0;
      const label = a === Infinity ? '∞' : `×${a}`;
      btn.querySelector('.wammo').textContent = label;
      btn.disabled = !isMyTurn() || S.fired || !!S.winner || a <= 0;
    });
  }

  function selectWeapon(k) {
    if (!isMyTurn() || S.fired || S.winner) return;
    if (!WEAPONS[k]) return;
    const pid = activePlayerId();
    if (S.ammo[pid][k] <= 0) return;
    if (S.isHost || S.solo) {
      S.weapon = k;
      S.awaitTarget = (k === 'airstrike');
    } else {
      send('host', { type: 'weapon', key: k });
    }
    updateWeaponRow();
  }

  function renderLobby(asHost) {
    const codeEl = $('lobbyCode');
    const codeActions = $('lobbyCodeActions');
    const title = $('lobbyTitle');
    if (asHost) {
      codeEl.textContent = S.code || '——————';
      codeActions.hidden = false;
      title.textContent = 'Your lobby';
    } else {
      codeEl.textContent = S.code || '——————';
      codeActions.hidden = true;
      title.textContent = 'Lobby';
    }

    const list = $('playerList');
    list.innerHTML = '';
    for (const p of S.players) {
      const row = document.createElement('div');
      row.className = 'player-row';
      const sw = document.createElement('div');
      sw.className = 'swatch';
      const col = PLAYER_COLORS[p.colorIdx];
      sw.style.background = col.main;
      sw.style.color = col.main;
      row.appendChild(sw);

      const name = document.createElement('div');
      name.className = 'pname';
      if (p.id === S.myId) {
        const inp = document.createElement('input');
        inp.type = 'text'; inp.value = p.name; inp.maxLength = 16;
        inp.addEventListener('input', () => {
          p.name = inp.value.slice(0, 16);
          S.myName = p.name;
          localStorage.setItem(STORAGE_NAME, S.myName);
          if (asHost) { broadcastLobby(); }
          else { send('host', { type: 'setName', name: S.myName }); }
        });
        name.appendChild(inp);
      } else {
        name.textContent = p.name;
      }
      row.appendChild(name);

      const tag = document.createElement('div');
      tag.className = 'ptag';
      tag.textContent = p.id === 'host' ? 'HOST' : (p.id === S.myId ? 'YOU' : '');
      row.appendChild(tag);
      list.appendChild(row);
    }
    const startBtn = $('startBtn');
    if (asHost) {
      startBtn.hidden = false;
      startBtn.disabled = S.players.filter((p) => p.connected).length < 2;
      $('lobbyStatus').textContent = `${S.players.length}/${MAX_PLAYERS} connected`;
    } else {
      startBtn.hidden = true;
      $('lobbyStatus').textContent = 'Waiting for host to start…';
    }
  }

  function showBanner(text) {
    S.banner.text = text; S.banner.t = 120;
    const el = $('banner');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(showBanner._t);
    showBanner._t = setTimeout(() => { el.hidden = true; }, 1800);
  }

  function showEndBar() {
    const bar = $('endbar');
    const txt = $('endText');
    txt.classList.remove('win', 'lose');
    if (S.winner === 'draw' || !S.winner) {
      txt.textContent = 'Stalemate';
    } else if (S.winner === S.myId) {
      txt.textContent = 'Victory';
      txt.classList.add('win');
    } else {
      txt.textContent = `${nameOf(S.winner)} wins`;
      txt.classList.add('lose');
    }
    bar.hidden = false;
  }

  function setConnDot(ok) {
    const d = $('connDot');
    const t = $('connText');
    if (d) d.classList.toggle('bad', !ok);
    if (t) t.textContent = ok ? 'Connected' : 'Offline';
  }

  // =====================================================================
  //                             INPUT WIRING
  // =====================================================================

  function setInput(key, val) {
    if (S.inputs[key] === val) return;
    S.inputs[key] = val;
    // joiners relay to host whenever it's their turn
    if (!S.isHost && !S.solo && isMyTurn() && S.matchStarted) {
      send('host', { type: 'input', inputs: { ...S.inputs } });
    }
  }

  function startCharge() {
    if (!isMyTurn() || S.fired || S.winner) return;
    if (S.weapon === 'dynamite') {
      // one-shot: fire immediately (dynamite drops at feet, no charge/aim)
      if (S.isHost || S.solo) doFire(0);
      else send('host', { type: 'fire', power: 0 });
      return;
    }
    if (S.weapon === 'airstrike') {
      // needs target tap on canvas
      S.awaitTarget = true;
      if (S.isHost || S.solo) {} // nothing to broadcast; state snapshot will handle it
      else send('host', { type: 'weapon', key: 'airstrike' });
      return;
    }
    S.charging = true;
    S.chargePower = 0;
    $('fireBtn').classList.add('charging');
  }
  function releaseCharge() {
    if (!isMyTurn() || S.fired || S.winner) { S.charging = false; $('fireBtn').classList.remove('charging'); return; }
    if (!S.charging) return;
    const p = Math.max(0.05, S.chargePower);
    S.charging = false;
    $('fireBtn').classList.remove('charging');
    if (S.isHost || S.solo) doFire(p);
    else send('host', { type: 'fire', power: p });
  }

  function wireInput() {
    // --- keyboard ---
    const keymap = {
      ArrowLeft: 'left', a: 'left', A: 'left',
      ArrowRight: 'right', d: 'right', D: 'right',
      ArrowUp: 'jump',
      w: 'aimUp', W: 'aimUp',
      s: 'aimDn', S: 'aimDn',
    };
    window.addEventListener('keydown', (e) => {
      if (S.screen !== 'game') return;
      if (e.repeat) return;
      if (keymap[e.key]) { setInput(keymap[e.key], true); e.preventDefault(); return; }
      if (e.key === ' ') { startCharge(); e.preventDefault(); return; }
      if (['1','2','3','4'].includes(e.key)) {
        selectWeapon(WEAPON_ORDER[+e.key - 1]);
      }
    });
    window.addEventListener('keyup', (e) => {
      if (S.screen !== 'game') return;
      if (keymap[e.key]) { setInput(keymap[e.key], false); e.preventDefault(); return; }
      if (e.key === ' ') { releaseCharge(); e.preventDefault(); return; }
    });

    // --- on-screen buttons ---
    const bind = (sel, key) => {
      const el = typeof sel === 'string' ? $(sel) : sel;
      if (!el) return;
      const down = (e) => { e.preventDefault(); setInput(key, true); };
      const up = (e) => { e.preventDefault(); setInput(key, false); };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', up);
    };
    document.querySelectorAll('.cbtn[data-ctrl]').forEach((b) => {
      const ctrl = b.dataset.ctrl;
      if (ctrl === 'left') bind(b, 'left');
      else if (ctrl === 'right') bind(b, 'right');
      else if (ctrl === 'jump') bind(b, 'jump');
      else if (ctrl === 'aim-up') bind(b, 'aimUp');
      else if (ctrl === 'aim-dn') bind(b, 'aimDn');
    });

    // --- fire button ---
    const fire = $('fireBtn');
    fire.addEventListener('pointerdown', (e) => { e.preventDefault(); startCharge(); });
    fire.addEventListener('pointerup',   (e) => { e.preventDefault(); releaseCharge(); });
    fire.addEventListener('pointercancel', () => { S.charging = false; fire.classList.remove('charging'); });

    // --- canvas taps (airstrike target) ---
    const c = canvas();
    const canvasToWorld = (clientX, clientY) => {
      const rect = c.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * W;
      const y = ((clientY - rect.top) / rect.height) * H;
      return { x, y };
    };
    c.addEventListener('pointermove', (e) => {
      if (!S.awaitTarget) return;
      S._airHover = canvasToWorld(e.clientX, e.clientY);
    });
    c.addEventListener('pointerdown', (e) => {
      if (!S.awaitTarget || !isMyTurn() || S.fired) return;
      const pos = canvasToWorld(e.clientX, e.clientY);
      if (S.isHost || S.solo) doFire(0, pos.x, pos.y);
      else send('host', { type: 'target', x: pos.x, y: pos.y });
    });
  }

  function send(key, msg) {
    const c = S.conns.get(key);
    if (c && c.open) c.send(msg);
  }

  // =====================================================================
  //                              WIRING / BOOT
  // =====================================================================

  function wireUI() {
    S.myName = (localStorage.getItem(STORAGE_NAME) || '').trim();
    const nameInput = $('nameInput');
    nameInput.value = S.myName;
    nameInput.addEventListener('input', () => {
      S.myName = nameInput.value.trim().slice(0, 16);
      localStorage.setItem(STORAGE_NAME, S.myName);
    });

    $('hostBtn').addEventListener('click', () => {
      if (!S.myName) { nameInput.focus(); nameInput.placeholder = 'Enter a callsign first'; return; }
      hostGame();
    });
    $('joinBtn').addEventListener('click', () => {
      if (!S.myName) { nameInput.focus(); nameInput.placeholder = 'Enter a callsign first'; return; }
      show('join');
      $('joinCode').value = '';
      $('joinStatus').textContent = '';
      setTimeout(() => $('joinCode').focus(), 50);
    });
    $('soloBtn').addEventListener('click', () => {
      if (!S.myName) S.myName = 'You';
      soloGame();
    });

    $('joinCode').addEventListener('input', (e) => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6);
    });
    $('joinGoBtn').addEventListener('click', () => joinGame($('joinCode').value));
    $('joinCode').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinGame(e.target.value);
    });
    $('joinRetryBtn').addEventListener('click', () => {
      if (S.code) joinGame(S.code); else show('home');
    });

    $('copyCodeBtn').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(S.code || ''); } catch {}
    });
    $('copyLinkBtn').addEventListener('click', async () => {
      try {
        const url = `${location.origin}${location.pathname}?c=${S.code}`;
        await navigator.clipboard.writeText(url);
      } catch {}
    });

    $('startBtn').addEventListener('click', () => {
      if (S.isHost && S.players.filter((p) => p.connected).length >= 2) startMatch();
    });

    $('rematchBtn').addEventListener('click', () => {
      if (S.solo || S.isHost) {
        startMatch();
      } else {
        send('host', { type: 'rematch' });
      }
    });
    $('leaveBtn').addEventListener('click', goHome);

    document.querySelectorAll('[data-back]').forEach((el) => el.addEventListener('click', goHome));

    // deep-link ?c=CODE
    const url = new URL(location.href);
    const joinParam = url.searchParams.get('c');
    if (joinParam) {
      const code = joinParam.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6);
      $('joinCode').value = code;
      if (S.myName && code.length === 6) joinGame(code);
      else setTimeout(() => nameInput.focus(), 200);
    }

    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();
  }

  document.addEventListener('DOMContentLoaded', () => {
    wireUI();
    wireInput();
    requestAnimationFrame(loop);
  });
})();
