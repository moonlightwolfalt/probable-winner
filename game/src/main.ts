// Nestfall — an original tower defense. All art is drawn in code; all content lives in ../data/*.json.
import towersData from "../data/towers.json";
import enemiesData from "../data/enemies.json";
import mapsData from "../data/maps.json";

// ───────────────────────── Types ─────────────────────────

type Stats = {
  kind: "shot" | "burst" | "pulse" | "income";
  range: number; cooldown: number; damage: number; pierce: number; projSpeed: number;
  count: number; spread: number; dmgType: string; splash: number; cluster: number;
  slow: number; slowDur: number; dotInterval: number; freeze: number; knockback: number;
  bossDmg: number; projSize: number; income: number; interest: number; lifeGain: number;
  seeVeiled: boolean; homing: boolean; hitscan: boolean; chain: boolean;
  affectHeavy: boolean; freezeHeavy: boolean; pulseColor: string;
};
type Mods = Partial<Record<keyof Stats, any>>;
type Upgrade = { name: string; cost: number; desc: string; set?: Mods; add?: Mods; mul?: Mods };
type TowerDef = {
  id: string; name: string; cost: number; desc: string; sprite: string; image?: string;
  projColor?: string; pulseColor?: string; base: Mods; paths: { name: string; upgrades: Upgrade[] }[];
};
type EnemyDef = {
  name: string; color: string; trim: string; speed: number; hp: number; size: number;
  children: string[]; immune?: string[]; heavy?: boolean; style?: string; image?: string; rbe?: number;
};
type MapDef = { id: string; name: string; difficulty: string; theme: string; costScale?: number; path: number[][] };

type Enemy = {
  id: number; type: string; def: EnemyDef; dist: number; hp: number; maxHp: number; veiled: boolean;
  slow: number; slowT: number; frozenT: number; dotInterval: number; dotT: number; dotOwner: Tower | null;
  x: number; y: number; dead: boolean; wob: number;
};
type Tower = {
  id: number; def: TowerDef; x: number; y: number; tiers: number[]; stats: Stats; cd: number;
  angle: number; target: "first" | "last" | "strong" | "close"; cracks: number; spent: number; anim: number;
};
type Proj = {
  x: number; y: number; vx: number; vy: number; life: number; pierce: number; s: Stats; owner: Tower;
  hit: Set<number>; color: string; size: number; target: Enemy | null; dead: boolean;
};
type Fx = { kind: "ring" | "spark" | "line" | "text"; x: number; y: number; x2?: number; y2?: number; r?: number; life: number; max: number; color: string; text?: string };
type Spawn = { t: number; type: string; veiled: boolean };

const TOWERS = towersData as unknown as TowerDef[];
const ENEMIES = enemiesData as unknown as Record<string, EnemyDef>;
const MAPS = mapsData as unknown as MapDef[];

const W = 800, H = 600, PATH_W = 42, TOWER_R = 17, MAX_TIER = 5, FINAL_ROUND = 40;
const DEFAULTS: Stats = {
  kind: "shot", range: 100, cooldown: 1, damage: 1, pierce: 1, projSpeed: 400, count: 1, spread: 0,
  dmgType: "sharp", splash: 0, cluster: 0, slow: 0, slowDur: 0, dotInterval: 0, freeze: 0, knockback: 0,
  bossDmg: 0, projSize: 4, income: 0, interest: 0, lifeGain: 0, seeVeiled: false, homing: false,
  hitscan: false, chain: false, affectHeavy: false, freezeHeavy: false, pulseColor: "#ffffff",
};

/** Prices scale with the map's difficulty (maps.json "costScale"), rounded to the nearest 5. */
function price(base: number): number { return Math.max(5, Math.round((base * (G.map.costScale ?? 1)) / 5) * 5); }

function rbe(type: string): number {
  const d = ENEMIES[type]!;
  return (d.rbe ??= d.hp + d.children.reduce((n, c) => n + rbe(c), 0));
}
Object.keys(ENEMIES).forEach(rbe);

function computeStats(def: TowerDef, tiers: number[]): Stats {
  const s: any = { ...DEFAULTS, ...def.base };
  if (def.pulseColor) s.pulseColor = def.pulseColor;
  def.paths.forEach((p, i) => {
    for (let t = 0; t < (tiers[i] ?? 0); t++) {
      const u = p.upgrades[t]!;
      for (const [k, v] of Object.entries(u.set ?? {})) s[k] = v;
      for (const [k, v] of Object.entries(u.add ?? {})) s[k] += v;
      for (const [k, v] of Object.entries(u.mul ?? {})) s[k] *= v;
    }
  });
  return s;
}

/** Two paths at most; only one of them may pass tier 2. */
function upgradeBlocked(tiers: number[], path: number): string | null {
  const t = tiers[path]!;
  if (t >= MAX_TIER) return "Fully upgraded";
  const others = tiers.filter((_, i) => i !== path);
  if (t === 0 && others.filter((o) => o > 0).length >= 2) return "Only two paths per tower";
  if (t >= 2 && others.some((o) => o > 2)) return "Another path is already past tier 2";
  return null;
}

// ───────────────────────── Seeded random ─────────────────────────

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────── Rounds ─────────────────────────

const UNLOCK: [string, number][] = [
  ["peg", 1], ["bobbin", 2], ["trinket", 5], ["jester", 9], ["matron", 13],
  ["tin", 16], ["plush", 17], ["frostling", 18], ["harlequin", 22], ["porcelain", 27],
];

function genRound(r: number): Spawn[] {
  const rand = rng(r * 7919 + 13);
  const out: Spawn[] = [];
  const pool = UNLOCK.filter(([, at]) => at <= r).map(([t]) => t);
  const top = pool.slice(-4);
  let budget = 12 + r * 8 + Math.pow(1.17, r) * 5;
  if (r >= 20 && r % 5 === 0) budget *= 0.5; // boss rounds bring fewer ordinary dolls
  const groups = 2 + Math.floor(r / 8);
  let t0 = 0;
  for (let g = 0; g < groups; g++) {
    // weight toward the newest types, but always keep some fodder
    const type = g === 0 && r === UNLOCK.find(([t]) => t === top[top.length - 1])![1]
      ? top[top.length - 1]!
      : top[Math.min(top.length - 1, Math.floor(Math.pow(rand(), 0.7) * top.length))]!;
    const share = budget / (groups - g) * (0.7 + rand() * 0.6);
    const count = Math.max(1, Math.min(70, Math.round(share / rbe(type))));
    budget = Math.max(0, budget - count * rbe(type));
    const gap = Math.max(0.1, (0.75 - r * 0.014) * (0.6 + rand() * 0.8));
    // veiled groups arrive from round 15 on, and are smaller than normal ones
    const veiled = r === 15 ? g === 0 : r > 15 && rand() < 0.22 && type !== "porcelain";
    const n = veiled ? Math.max(1, Math.min(r === 15 ? 6 : 25, Math.ceil(count / 2))) : count;
    for (let i = 0; i < n; i++) out.push({ t: t0 + i * gap, type, veiled });
    t0 += count * gap * (0.4 + rand() * 0.5) + 0.8;
  }
  const bosses: string[] = [];
  if (r === 20) bosses.push("babushka");
  else if (r === 25) bosses.push("babushka", "babushka");
  else if (r === 30) bosses.push("babushka", "babushka", "babushka");
  else if (r === 35) bosses.push(...Array(5).fill("babushka"));
  else if (r === 40) bosses.push("tsarina", "babushka", "babushka");
  else if (r > 40 && r % 2 === 0) {
    bosses.push(...Array(Math.floor((r - 36) / 4)).fill("tsarina"), ...Array(Math.floor((r - 30) / 3)).fill("babushka"));
  }
  bosses.forEach((b, i) => out.push({ t: 2 + i * 3.5, type: b, veiled: false }));
  return out.sort((a, b) => a.t - b.t);
}

// ───────────────────────── Game state ─────────────────────────

const store = {
  get(k: string): any { try { return JSON.parse(localStorage.getItem("nestfall:" + k) ?? "null"); } catch { return null; } },
  set(k: string, v: any) { try { localStorage.setItem("nestfall:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const G = {
  screen: "menu" as "menu" | "play" | "over" | "won",
  map: MAPS[0]!, segs: [] as { x: number; y: number; dx: number; dy: number; len: number; start: number }[], pathLen: 0,
  cash: 650, lives: 100, round: 0, inRound: false, roundT: 0, queue: [] as Spawn[],
  enemies: [] as Enemy[], towers: [] as Tower[], projs: [] as Proj[], fx: [] as Fx[],
  speed: 1, paused: false, auto: false, muted: false, freeplay: false,
  placing: null as TowerDef | null, selected: null as Tower | null,
  mouse: { x: -100, y: -100, on: false }, nextId: 1, time: 0, bg: null as HTMLCanvasElement | null,
};

function setMap(m: MapDef) {
  G.map = m; G.segs = []; let acc = 0;
  for (let i = 0; i < m.path.length - 1; i++) {
    const [x, y] = m.path[i]!, [x2, y2] = m.path[i + 1]!;
    const len = Math.hypot(x2! - x!, y2! - y!);
    G.segs.push({ x: x!, y: y!, dx: (x2! - x!) / len, dy: (y2! - y!) / len, len, start: acc });
    acc += len;
  }
  G.pathLen = acc;
  G.bg = renderBackground(m);
}

function posAt(dist: number): [number, number] {
  for (const s of G.segs) if (dist <= s.start + s.len) return [s.x + s.dx * (dist - s.start), s.y + s.dy * (dist - s.start)];
  const l = G.segs[G.segs.length - 1]!;
  return [l.x + l.dx * l.len, l.y + l.dy * l.len];
}

function distToPath(x: number, y: number): number {
  let best = Infinity;
  for (const s of G.segs) {
    const t = Math.max(0, Math.min(s.len, (x - s.x) * s.dx + (y - s.y) * s.dy));
    best = Math.min(best, Math.hypot(x - (s.x + s.dx * t), y - (s.y + s.dy * t)));
  }
  return best;
}

function canPlace(x: number, y: number): boolean {
  if (x < TOWER_R || y < TOWER_R || x > W - TOWER_R || y > H - TOWER_R) return false;
  if (distToPath(x, y) < PATH_W / 2 + TOWER_R - 2) return false;
  return !G.towers.some((t) => Math.hypot(t.x - x, t.y - y) < TOWER_R * 2);
}

function newGame(m: MapDef) {
  setMap(m);
  Object.assign(G, {
    screen: "play", cash: 650, lives: 100, round: 0, inRound: false, roundT: 0, queue: [], enemies: [], towers: [],
    projs: [], fx: [], paused: false, placing: null, selected: null, freeplay: false, time: 0,
  });
  ui.refresh();
}

function spawnEnemy(type: string, dist: number, veiled: boolean, from?: Enemy): Enemy {
  const def = ENEMIES[type]!;
  const scale = def.heavy && G.round > FINAL_ROUND ? 1 + (G.round - FINAL_ROUND) * 0.08 : 1;
  const hp = Math.round(def.hp * scale);
  const [x, y] = posAt(dist);
  const e: Enemy = {
    id: G.nextId++, type, def, dist, hp, maxHp: hp, veiled, x, y, dead: false, wob: Math.random() * 6.28,
    slow: from?.slow ?? 0, slowT: from?.slowT ?? 0, frozenT: def.heavy ? 0 : from?.frozenT ?? 0,
    dotInterval: from?.dotInterval ?? 0, dotT: from?.dotT ?? 0, dotOwner: from?.dotOwner ?? null,
  };
  if (def.heavy && from && !from.def.heavy) { e.slow = 0; e.slowT = 0; }
  G.enemies.push(e);
  return e;
}

function startRound() {
  if (G.inRound || G.screen !== "play") return;
  G.round++; G.inRound = true; G.roundT = 0; G.queue = genRound(G.round);
  ui.refresh();
}

function endRound() {
  G.inRound = false;
  let gain = 120 + G.round * 3, lives = 0;
  for (const t of G.towers) {
    if (t.stats.kind !== "income") continue;
    const pay = Math.round(t.stats.income + Math.min(3000, G.cash * t.stats.interest));
    gain += pay; lives += t.stats.lifeGain;
    G.fx.push({ kind: "text", x: t.x, y: t.y - 22, life: 1.6, max: 1.6, color: "#ffe27a", text: "+" + pay });
  }
  G.cash += gain; G.lives += lives;
  const best = store.get("best:" + G.map.id) ?? 0;
  if (G.round > best) store.set("best:" + G.map.id, G.round);
  if (G.round === FINAL_ROUND && !G.freeplay) { G.screen = "won"; }
  else if (G.auto) startRound();
  ui.refresh();
}

// ───────────────────────── Combat ─────────────────────────

function crackSound() { audio.pop(); }

function damage(e: Enemy, dmg: number, owner: Tower | null, proj: Proj | null) {
  if (e.dead || dmg <= 0) return;
  e.hp -= dmg;
  if (e.hp > 0) return;
  const overflow = e.def.heavy ? 0 : -e.hp;
  e.dead = true;
  G.cash += 1;
  if (owner) owner.cracks++;
  crackSound();
  G.fx.push({ kind: "ring", x: e.x, y: e.y, r: e.def.size + 4, life: 0.22, max: 0.22, color: e.def.color });
  e.def.children.forEach((c, i) => {
    const child = spawnEnemy(c, Math.max(0, e.dist - i * (e.def.heavy ? 14 : 7)), e.veiled, e);
    proj?.hit.add(child.id);
    if (overflow > 0) damage(child, overflow, owner, proj);
  });
}

/** Applies one hit of a tower's attack to an enemy. Returns false when the enemy shrugged it off. */
function applyHit(e: Enemy, s: Stats, owner: Tower, proj: Proj | null): boolean {
  if (e.def.immune?.includes(s.dmgType)) {
    G.fx.push({ kind: "spark", x: e.x, y: e.y, life: 0.18, max: 0.18, color: "#ffffff" });
    return false;
  }
  const heavy = !!e.def.heavy;
  if (s.slow > 0 && (!heavy || s.affectHeavy)) {
    e.slow = Math.max(e.slow, heavy ? s.slow * 0.5 : s.slow);
    e.slowT = Math.max(e.slowT, s.slowDur);
    if (s.dotInterval > 0) {
      e.dotInterval = e.dotInterval > 0 ? Math.min(e.dotInterval, s.dotInterval) : s.dotInterval;
      e.dotOwner = owner;
      if (e.dotT <= 0) e.dotT = e.dotInterval;
    }
  }
  if (s.freeze > 0 && (!heavy || s.freezeHeavy)) e.frozenT = Math.max(e.frozenT, heavy ? s.freeze * 0.4 : s.freeze);
  if (s.knockback > 0 && !heavy) e.dist = Math.max(0, e.dist - s.knockback);
  damage(e, s.damage + (heavy ? s.bossDmg : 0), owner, proj);
  return true;
}

function explode(x: number, y: number, radius: number, s: Stats, owner: Tower, proj: Proj | null, color: string) {
  G.fx.push({ kind: "ring", x, y, r: radius, life: 0.28, max: 0.28, color });
  let n = 0;
  for (const e of G.enemies.slice()) {
    if (e.dead || (e.veiled && !s.seeVeiled)) continue;
    if (Math.hypot(e.x - x, e.y - y) > radius + e.def.size) continue;
    applyHit(e, s, owner, proj);
    if (++n >= 40) break;
  }
}

function visible(e: Enemy, s: Stats) { return !e.dead && (!e.veiled || s.seeVeiled); }

function pickTarget(t: Tower): Enemy | null {
  const s = t.stats;
  let best: Enemy | null = null, bestV = -Infinity;
  for (const e of G.enemies) {
    if (!visible(e, s)) continue;
    const d = Math.hypot(e.x - t.x, e.y - t.y);
    if (d > s.range + e.def.size) continue;
    let v = t.target === "first" ? e.dist : t.target === "last" ? -e.dist : t.target === "close" ? -d : rbe(e.type) * 1e4 + e.dist;
    if (s.slow > 0 && s.damage === 0 && e.slowT > 0.5) v -= 1e7; // honey prefers dry dolls
    if (v > bestV) { bestV = v; best = e; }
  }
  return best;
}

function fireProj(t: Tower, angle: number, target: Enemy | null) {
  const s = t.stats;
  const life = s.kind === "burst" ? (s.range + 10) / s.projSpeed : Math.min(2.2, (s.range + 80) / s.projSpeed);
  G.projs.push({
    x: t.x + Math.cos(angle) * 14, y: t.y + Math.sin(angle) * 14,
    vx: Math.cos(angle) * s.projSpeed, vy: Math.sin(angle) * s.projSpeed,
    life, pierce: s.pierce, s, owner: t, hit: new Set(), color: t.def.projColor ?? "#fff",
    size: s.projSize, target: s.homing ? target : null, dead: false,
  });
}

function updateTower(t: Tower, dt: number) {
  const s = t.stats;
  t.cd -= dt; t.anim = Math.max(0, t.anim - dt);
  if (s.kind === "income") return;
  const target = pickTarget(t);
  if (target && s.kind === "shot") t.angle = Math.atan2(target.y - t.y, target.x - t.x);
  if (t.cd > 0 || !target) return;
  t.cd = s.cooldown; t.anim = 0.15;
  if (s.kind === "pulse") {
    G.fx.push({ kind: "ring", x: t.x, y: t.y, r: s.range, life: 0.35, max: 0.35, color: s.pulseColor });
    let n = 0;
    for (const e of G.enemies.slice()) {
      if (!visible(e, s) || Math.hypot(e.x - t.x, e.y - t.y) > s.range + e.def.size) continue;
      applyHit(e, s, t, null);
      if (++n >= s.pierce) break;
    }
  } else if (s.kind === "burst") {
    const off = (G.time * 2) % 6.28;
    for (let i = 0; i < s.count; i++) fireProj(t, off + (i / s.count) * Math.PI * 2, null);
    t.angle = off;
  } else if (s.hitscan) {
    G.fx.push({ kind: "line", x: t.x, y: t.y, x2: target.x, y2: target.y, life: 0.12, max: 0.12, color: t.def.projColor ?? "#fff" });
    hitWithShot(target, s, t, null, target.x, target.y);
  } else {
    for (let i = 0; i < s.count; i++) {
      const a = t.angle + (s.count > 1 ? ((i / (s.count - 1)) - 0.5) * (s.spread * Math.PI / 180) : 0);
      fireProj(t, a, target);
    }
  }
}

function hitWithShot(e: Enemy, s: Stats, owner: Tower, proj: Proj | null, x: number, y: number) {
  const color = owner.def.projColor ?? "#fff";
  if (s.splash > 0) {
    explode(x, y, s.splash, s, owner, proj, color);
    for (let i = 0; i < s.cluster; i++) {
      const a = (i / s.cluster) * Math.PI * 2 + G.time;
      explode(x + Math.cos(a) * s.splash * 0.9, y + Math.sin(a) * s.splash * 0.9, s.splash * 0.6, s, owner, proj, color);
    }
  } else applyHit(e, s, owner, proj);
}

function updateProj(p: Proj, dt: number) {
  p.life -= dt;
  if (p.life <= 0) { p.dead = true; return; }
  if (p.target) {
    if (p.target.dead) {
      p.target = null;
      let bd = 160;
      for (const e of G.enemies) {
        if (!visible(e, p.s) || p.hit.has(e.id)) continue;
        const d = Math.hypot(e.x - p.x, e.y - p.y);
        if (d < bd) { bd = d; p.target = e; }
      }
    }
    if (p.target) {
      const sp = Math.hypot(p.vx, p.vy), want = Math.atan2(p.target.y - p.y, p.target.x - p.x);
      let cur = Math.atan2(p.vy, p.vx), diff = ((want - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      cur += Math.max(-8 * dt, Math.min(8 * dt, diff));
      p.vx = Math.cos(cur) * sp; p.vy = Math.sin(cur) * sp;
    }
  }
  p.x += p.vx * dt; p.y += p.vy * dt;
  if (p.x < -40 || p.y < -40 || p.x > W + 40 || p.y > H + 40) { p.dead = true; return; }
  for (const e of G.enemies) {
    if (e.dead || p.hit.has(e.id) || (e.veiled && !p.s.seeVeiled)) continue;
    const r = e.def.size + p.size;
    const dx = e.x - p.x, dy = e.y - p.y;
    if (dx * dx + dy * dy > r * r) continue;
    p.hit.add(e.id);
    hitWithShot(e, p.s, p.owner, p, p.x, p.y);
    if (p.s.splash > 0 || --p.pierce <= 0) { p.dead = true; return; }
    if (p.s.chain) {
      let next: Enemy | null = null, bd = 120;
      for (const o of G.enemies) {
        if (!visible(o, p.s) || p.hit.has(o.id)) continue;
        const d = Math.hypot(o.x - p.x, o.y - p.y);
        if (d < bd) { bd = d; next = o; }
      }
      if (!next) { p.dead = true; return; }
      G.fx.push({ kind: "line", x: p.x, y: p.y, x2: next.x, y2: next.y, life: 0.12, max: 0.12, color: p.color });
      const sp = Math.hypot(p.vx, p.vy), a = Math.atan2(next.y - p.y, next.x - p.x);
      p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp; p.life = Math.max(p.life, 0.4); p.target = next;
    }
    return;
  }
}

function updateEnemy(e: Enemy, dt: number) {
  if (e.frozenT > 0) { e.frozenT -= dt; }
  else {
    const mult = e.slowT > 0 ? 1 - e.slow : 1;
    e.dist += e.def.speed * mult * dt;
  }
  if (e.slowT > 0) {
    e.slowT -= dt;
    if (e.dotInterval > 0) {
      e.dotT -= dt;
      if (e.dotT <= 0) { e.dotT += e.dotInterval; damage(e, 1, e.dotOwner, null); if (e.dead) return; }
    }
    if (e.slowT <= 0) { e.slow = 0; e.dotInterval = 0; }
  }
  [e.x, e.y] = posAt(e.dist);
  if (e.dist >= G.pathLen) {
    e.dead = true;
    G.lives -= Math.max(1, rbe(e.type) - (e.maxHp - e.hp));
    if (G.lives <= 0) { G.lives = 0; G.screen = "over"; ui.refresh(); }
  }
}

function step(dt: number) {
  G.time += dt;
  if (G.inRound) {
    G.roundT += dt;
    while (G.queue.length && G.queue[0]!.t <= G.roundT) {
      const s = G.queue.shift()!;
      spawnEnemy(s.type, 0, s.veiled);
    }
  }
  for (const e of G.enemies.slice()) if (!e.dead) updateEnemy(e, dt);
  for (const t of G.towers) updateTower(t, dt);
  for (const p of G.projs) if (!p.dead) updateProj(p, dt);
  if (G.enemies.some((e) => e.dead)) G.enemies = G.enemies.filter((e) => !e.dead);
  if (G.projs.some((p) => p.dead)) G.projs = G.projs.filter((p) => !p.dead);
  for (const f of G.fx) f.life -= dt;
  if (G.fx.length > 400) G.fx.splice(0, G.fx.length - 400);
  G.fx = G.fx.filter((f) => f.life > 0);
  if (G.inRound && !G.queue.length && !G.enemies.length && G.screen === "play") endRound();
}

// ───────────────────────── Audio ─────────────────────────

const audio = {
  ctx: null as AudioContext | null, last: 0,
  pop() {
    if (G.muted) return;
    const now = performance.now();
    if (now - this.last < 45) return;
    this.last = now;
    try {
      this.ctx ??= new AudioContext();
      const c = this.ctx, o = c.createOscillator(), g = c.createGain();
      o.type = "triangle";
      o.frequency.setValueAtTime(520 + Math.random() * 260, c.currentTime);
      o.frequency.exponentialRampToValueAtTime(140, c.currentTime + 0.07);
      g.gain.setValueAtTime(0.05, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.08);
      o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + 0.09);
    } catch { /* audio not available */ }
  },
};

// ───────────────────────── Drawing ─────────────────────────

const images = new Map<string, HTMLImageElement>();
function customImage(url?: string): HTMLImageElement | null {
  if (!url) return null;
  let img = images.get(url);
  if (!img) { img = new Image(); img.src = url; images.set(url, img); }
  return img.complete && img.naturalWidth ? img : null;
}

function renderBackground(m: MapDef): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const x = c.getContext("2d")!, rand = rng(m.id.length * 97 + 5);
  if (m.theme === "wood") {
    x.fillStyle = "#c9955c"; x.fillRect(0, 0, W, H);
    for (let y = 0; y < H; y += 60) {
      x.fillStyle = `rgba(90,50,20,${0.05 + rand() * 0.1})`; x.fillRect(0, y, W, 60);
      x.fillStyle = "rgba(70,40,15,.35)"; x.fillRect(0, y, W, 2);
      for (let i = 0; i < 14; i++) { x.fillStyle = "rgba(80,45,15,.12)"; x.fillRect(rand() * W, y + 6 + rand() * 48, 40 + rand() * 120, 1.5); }
    }
  } else if (m.theme === "quilt") {
    const cols = ["#d9b8c4", "#b9cfd6", "#e3d5a8", "#c2d6b5", "#d6c1e0"];
    for (let gy = 0; gy < H; gy += 100) for (let gx = 0; gx < W; gx += 100) {
      x.fillStyle = cols[Math.floor(rand() * cols.length)]!; x.fillRect(gx, gy, 100, 100);
      x.strokeStyle = "rgba(255,255,255,.6)"; x.setLineDash([6, 6]); x.lineWidth = 2; x.strokeRect(gx + 6, gy + 6, 88, 88);
    }
    x.setLineDash([]);
  } else {
    x.fillStyle = "#6f5a4a"; x.fillRect(0, 0, W, H);
    for (let gx = 0; gx < W; gx += 80) {
      x.fillStyle = `rgba(30,18,10,${0.08 + rand() * 0.14})`; x.fillRect(gx, 0, 80, H);
      x.fillStyle = "rgba(25,15,8,.5)"; x.fillRect(gx, 0, 2, H);
    }
    const g = x.createRadialGradient(400, 300, 80, 400, 300, 520);
    g.addColorStop(0, "rgba(255,220,150,.22)"); g.addColorStop(1, "rgba(0,0,0,.35)");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
  }
  // decor: scattered buttons
  for (let i = 0; i < 16; i++) {
    const bx = rand() * W, by = rand() * H;
    if (distToPath(bx, by) < PATH_W) continue;
    x.fillStyle = ["#7a3b3b", "#3b5f7a", "#5c7a3b", "#7a6a3b"][i % 4]!; x.globalAlpha = 0.45;
    x.beginPath(); x.arc(bx, by, 7, 0, 7); x.fill();
    x.fillStyle = "#0004"; for (const [ox, oy] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) { x.beginPath(); x.arc(bx + ox!, by + oy!, 1, 0, 7); x.fill(); }
    x.globalAlpha = 1;
  }
  // the track: a felt ribbon with stitched edges
  const trace = () => { x.beginPath(); m.path.forEach(([px, py], i) => (i ? x.lineTo(px!, py!) : x.moveTo(px!, py!))); };
  x.lineJoin = "round"; x.lineCap = "round";
  trace(); x.strokeStyle = "rgba(0,0,0,.28)"; x.lineWidth = PATH_W + 10; x.stroke();
  trace(); x.strokeStyle = "#3e6b62"; x.lineWidth = PATH_W + 4; x.stroke();
  trace(); x.strokeStyle = "#4f8377"; x.lineWidth = PATH_W - 4; x.stroke();
  trace(); x.strokeStyle = "rgba(240,230,200,.5)"; x.lineWidth = 1.6; x.setLineDash([7, 7]); x.stroke(); x.setLineDash([]);
  // toy chest at the end
  const [ex, ey] = m.path[m.path.length - 1]!;
  const cx = Math.max(34, Math.min(W - 34, ex!)), cy = Math.max(30, Math.min(H - 30, ey!));
  x.fillStyle = "#5b3418"; x.fillRect(cx - 30, cy - 20, 60, 42);
  x.fillStyle = "#7c4a24"; x.fillRect(cx - 30, cy - 26, 60, 16);
  x.fillStyle = "#e0b040"; x.fillRect(cx - 5, cy - 16, 10, 12); x.fillRect(cx - 30, cy - 4, 60, 3);
  return c;
}

const spriteCache = new Map<string, HTMLCanvasElement>();
function enemySprite(type: string): HTMLCanvasElement {
  let c = spriteCache.get(type);
  if (c) return c;
  const d = ENEMIES[type]!, s = d.size, pad = 4;
  c = document.createElement("canvas"); c.width = (s * 2 + pad * 2) * 2; c.height = (s * 2.6 + pad * 2) * 2;
  const x = c.getContext("2d")!; x.scale(2, 2); x.translate(s + pad, s * 1.5 + pad);
  const body = () => { x.beginPath(); x.ellipse(0, s * 0.25, s * 0.92, s * 0.85, 0, 0, 7); x.arc(0, -s * 0.62, s * 0.62, 0, 7); };
  x.fillStyle = "rgba(0,0,0,.25)"; x.beginPath(); x.ellipse(1, s * 1.0, s * 0.8, s * 0.22, 0, 0, 7); x.fill();
  body(); x.fillStyle = d.color; x.fill(); x.save(); body(); x.clip();
  if (d.style === "harlequin") {
    x.fillStyle = d.trim;
    for (let i = -3; i < 4; i++) for (let j = -4; j < 4; j++) if ((i + j) & 1) { x.beginPath(); x.moveTo(i * s * 0.5, j * s * 0.5 - s * 0.25); x.lineTo(i * s * 0.5 + s * 0.25, j * s * 0.5); x.lineTo(i * s * 0.5, j * s * 0.5 + s * 0.25); x.lineTo(i * s * 0.5 - s * 0.25, j * s * 0.5); x.fill(); }
  } else {
    x.fillStyle = d.trim; x.fillRect(-s, s * 0.05, s * 2, s * 0.3);
    if (d.style === "tin") { x.fillStyle = "#e7edf2"; for (const px of [-0.6, 0, 0.6]) { x.beginPath(); x.arc(px * s, s * 0.2, 1.6, 0, 7); x.fill(); } x.fillStyle = "rgba(255,255,255,.35)"; x.fillRect(-s * 0.7, -s * 1.3, s * 0.3, s * 2.4); }
    if (d.style === "plush") { x.strokeStyle = "#f3dcbc"; x.setLineDash([3, 3]); x.lineWidth = 1.2; x.beginPath(); x.moveTo(0, -s * 0.1); x.lineTo(0, s * 1.2); x.stroke(); x.setLineDash([]); }
    if (d.style === "frost") { x.strokeStyle = "#fff"; x.lineWidth = 1.4; for (let i = 0; i < 3; i++) { x.beginPath(); const a = i * Math.PI / 3; x.moveTo(-Math.cos(a) * s * 0.4, s * 0.65 - Math.sin(a) * s * 0.4); x.lineTo(Math.cos(a) * s * 0.4, s * 0.65 + Math.sin(a) * s * 0.4); x.stroke(); } }
    if (d.style === "porcelain") { x.fillStyle = d.trim; for (const [px, py] of [[-0.45, 0.7], [0.45, 0.7], [0, 0.8]]) { x.beginPath(); x.arc(px! * s, py! * s, s * 0.14, 0, 7); x.fill(); } }
    if (d.style === "boss") { x.fillStyle = d.trim; for (let i = -2; i <= 2; i++) { x.beginPath(); x.arc(i * s * 0.36, s * 0.7, s * 0.1, 0, 7); x.fill(); } }
  }
  x.restore();
  body(); x.strokeStyle = "rgba(0,0,0,.45)"; x.lineWidth = 1.2; x.stroke();
  // face
  x.fillStyle = "#fbe9d2"; x.beginPath(); x.arc(0, -s * 0.6, s * 0.42, 0, 7); x.fill();
  x.fillStyle = "#2b1d16"; x.beginPath(); x.arc(-s * 0.16, -s * 0.66, Math.max(1, s * 0.07), 0, 7); x.arc(s * 0.16, -s * 0.66, Math.max(1, s * 0.07), 0, 7); x.fill();
  x.fillStyle = "rgba(230,110,110,.7)"; x.beginPath(); x.arc(-s * 0.26, -s * 0.5, s * 0.08, 0, 7); x.arc(s * 0.26, -s * 0.5, s * 0.08, 0, 7); x.fill();
  if (d.style === "boss") { // crown
    x.fillStyle = d.trim; x.beginPath(); x.moveTo(-s * 0.4, -s * 1.15); x.lineTo(-s * 0.4, -s * 1.45); x.lineTo(-s * 0.2, -s * 1.28); x.lineTo(0, -s * 1.5); x.lineTo(s * 0.2, -s * 1.28); x.lineTo(s * 0.4, -s * 1.45); x.lineTo(s * 0.4, -s * 1.15); x.fill();
  }
  spriteCache.set(type, c);
  return c;
}

function drawEnemy(x: CanvasRenderingContext2D, e: Enemy) {
  const d = e.def, img = customImage(d.image), bob = e.frozenT > 0 ? 0 : Math.sin(G.time * 9 + e.wob) * 1.2;
  x.save(); x.translate(e.x, e.y + bob);
  if (e.veiled) x.globalAlpha = 0.42;
  if (img) x.drawImage(img, -d.size * 1.3, -d.size * 1.3, d.size * 2.6, d.size * 2.6);
  else { const sp = enemySprite(e.type); x.drawImage(sp, -sp.width / 4, -sp.height / 4 - d.size * 0.2, sp.width / 2, sp.height / 2); }
  x.globalAlpha = 1;
  if (e.slowT > 0) { x.fillStyle = "rgba(240,168,48,.75)"; x.beginPath(); x.ellipse(0, d.size * 0.85, d.size * 0.8, d.size * 0.25, 0, 0, 7); x.fill(); }
  if (e.frozenT > 0) { x.fillStyle = "rgba(190,235,255,.55)"; x.strokeStyle = "#fff"; x.lineWidth = 1; x.beginPath(); x.ellipse(0, -d.size * 0.2, d.size * 1.05, d.size * 1.45, 0, 0, 7); x.fill(); x.stroke(); }
  if (e.maxHp > 1 && e.hp < e.maxHp) {
    const w = d.size * 2;
    x.fillStyle = "#0008"; x.fillRect(-w / 2, -d.size * 1.9, w, 4);
    x.fillStyle = "#7fe08a"; x.fillRect(-w / 2, -d.size * 1.9, w * Math.max(0, e.hp / e.maxHp), 4);
  }
  x.restore();
}

const SPRITES: Record<string, (x: CanvasRenderingContext2D, t: number) => void> = {
  marble(x) {
    x.fillStyle = "#8a5a33"; x.beginPath(); x.arc(0, 0, 12, 0, 7); x.fill();
    x.fillStyle = "#f1c9a0"; x.beginPath(); x.arc(-1, 0, 8, 0, 7); x.fill();
    x.fillStyle = "#c0392b"; x.beginPath(); x.arc(-3, 0, 8, Math.PI * 0.5, Math.PI * 1.5); x.fill();
    x.strokeStyle = "#5a3a1c"; x.lineWidth = 3; x.beginPath(); x.moveTo(6, 0); x.lineTo(13, 0); x.moveTo(13, 0); x.lineTo(18, -6); x.moveTo(13, 0); x.lineTo(18, 6); x.stroke();
    x.fillStyle = "#7fd1e8"; x.beginPath(); x.arc(14, 0, 3, 0, 7); x.fill();
  },
  jack(x, t) {
    x.rotate(t * 3); x.strokeStyle = "#c8ced6"; x.lineWidth = 4; x.lineCap = "round";
    for (let i = 0; i < 4; i++) { x.rotate(Math.PI / 4); x.beginPath(); x.moveTo(-14, 0); x.lineTo(14, 0); x.stroke(); }
    x.fillStyle = "#e8ecf1"; for (let i = 0; i < 8; i++) { x.rotate(Math.PI / 4); x.beginPath(); x.arc(14, 0, 2.6, 0, 7); x.fill(); }
    x.fillStyle = "#b03a48"; x.beginPath(); x.arc(0, 0, 6, 0, 7); x.fill();
  },
  archer(x) {
    x.fillStyle = "#2f6b46"; x.beginPath(); x.arc(0, 0, 11, 0, 7); x.fill();
    x.fillStyle = "#f1c9a0"; x.beginPath(); x.arc(2, 0, 6, 0, 7); x.fill();
    x.strokeStyle = "#6b4423"; x.lineWidth = 2.5; x.beginPath(); x.arc(6, 0, 12, -1.15, 1.15); x.stroke();
    x.strokeStyle = "#eee"; x.lineWidth = 1; x.beginPath(); x.moveTo(11, -11); x.lineTo(11, 11); x.stroke();
    x.fillStyle = "#c9a227"; x.fillRect(0, -1.5, 20, 3);
  },
  popcorn(x) {
    x.fillStyle = "#5a3a1c"; x.beginPath(); x.arc(-4, -10, 5, 0, 7); x.arc(-4, 10, 5, 0, 7); x.fill();
    for (let i = 0; i < 5; i++) { x.fillStyle = i % 2 ? "#fff6e0" : "#d6423b"; x.fillRect(-10 + i * 6, -9, 6, 18); }
    x.fillStyle = "#3a2a22"; x.fillRect(18, -7, 4, 14);
    x.fillStyle = "#fff3c4"; x.beginPath(); x.arc(-12, 0, 4, 0, 7); x.fill();
  },
  globe(x, t) {
    x.fillStyle = "#6b4a2e"; x.beginPath(); x.arc(0, 0, 15, 0, 7); x.fill();
    const g = x.createRadialGradient(-4, -4, 2, 0, 0, 12); g.addColorStop(0, "#f4fcff"); g.addColorStop(1, "#7fbfe0");
    x.fillStyle = g; x.beginPath(); x.arc(0, 0, 11.5, 0, 7); x.fill();
    x.fillStyle = "#fff"; for (let i = 0; i < 6; i++) { const a = i * 1.05 + t * 1.5; x.beginPath(); x.arc(Math.cos(a) * 6, Math.sin(a * 1.3) * 6, 1.3, 0, 7); x.fill(); }
  },
  honey(x) {
    x.fillStyle = "#b5651d"; x.beginPath(); x.arc(0, 0, 13, 0, 7); x.fill();
    x.fillStyle = "#f0a830"; x.beginPath(); x.arc(0, 0, 9, 0, 7); x.fill();
    x.fillStyle = "#ffd36b"; x.beginPath(); x.arc(-3, -3, 3, 0, 7); x.fill();
    x.fillStyle = "#8a4a12"; x.fillRect(10, -3, 9, 6);
    x.fillStyle = "#f0a830"; x.beginPath(); x.arc(19, 0, 2.5, 0, 7); x.fill();
  },
  music(x, t) {
    x.fillStyle = "#5b3c8c"; x.fillRect(-12, -12, 24, 24);
    x.strokeStyle = "#d9b24a"; x.lineWidth = 2; x.strokeRect(-12, -12, 24, 24);
    x.fillStyle = "#d9b24a"; x.fillRect(-7, -5, 14, 10);
    x.fillStyle = "#5b3c8c"; for (let i = 0; i < 4; i++) x.fillRect(-6 + i * 3.6, -4 + ((i * 3 + Math.floor(t * 4)) % 4) * 2, 2, 2);
    x.fillStyle = "#c9a2ff"; x.beginPath(); x.arc(15, 0, 3.5, 0, 7); x.fill(); x.fillRect(17, -9, 1.6, 9);
  },
  piggy(x) {
    x.fillStyle = "#f29bb5"; x.beginPath(); x.ellipse(0, 0, 14, 11, 0, 0, 7); x.fill();
    x.fillStyle = "#e57f9f"; x.beginPath(); x.arc(-8, -9, 4, 0, 7); x.arc(-8, 9, 4, 0, 7); x.fill();
    x.beginPath(); x.ellipse(13, 0, 4, 5, 0, 0, 7); x.fill();
    x.fillStyle = "#7a3550"; x.fillRect(-4, -1.5, 9, 3); x.beginPath(); x.arc(14, -2, 1, 0, 7); x.arc(14, 2, 1, 0, 7); x.fill();
  },
};

const PATH_COLORS = ["#e9b949", "#4fc3c8", "#e86a92"];

function drawTowerSprite(x: CanvasRenderingContext2D, def: TowerDef, tiers: number[], angle: number, t: number, kick = 0) {
  // base plate with tier pips
  x.fillStyle = "rgba(0,0,0,.28)"; x.beginPath(); x.ellipse(2, 4, 17, 15, 0, 0, 7); x.fill();
  x.fillStyle = "#efe6d3"; x.beginPath(); x.arc(0, 0, TOWER_R, 0, 7); x.fill();
  x.strokeStyle = "#5c4a3c"; x.lineWidth = 1.5; x.stroke();
  tiers.forEach((n, p) => {
    for (let i = 0; i < n; i++) {
      const a = Math.PI / 2 + (p - 1) * 2.09 + (i - (n - 1) / 2) * 0.3;
      x.fillStyle = PATH_COLORS[p]!; x.beginPath(); x.arc(Math.cos(a) * 15, Math.sin(a) * 15, 2.4, 0, 7); x.fill();
      x.strokeStyle = "#0006"; x.lineWidth = 0.6; x.stroke();
    }
  });
  const img = customImage(def.image);
  x.save();
  const rotates = def.sprite !== "piggy" && def.sprite !== "globe" && def.sprite !== "jack" && def.sprite !== "music";
  if (rotates) x.rotate(angle);
  x.translate(-kick * 3, 0); x.scale(0.82, 0.82);
  if (img) x.drawImage(img, -20, -20, 40, 40);
  else (SPRITES[def.sprite] ?? SPRITES.marble!)(x, t);
  x.restore();
}

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

function draw() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(cw * H / W);
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  const x = ctx; x.setTransform(cw / W, 0, 0, cw / W, 0, 0);
  if (G.bg) x.drawImage(G.bg, 0, 0);
  const sel = G.selected;
  if (sel && sel.stats.range > 0 && sel.stats.range < 900) {
    x.fillStyle = "rgba(255,255,255,.16)"; x.strokeStyle = "rgba(255,255,255,.7)"; x.lineWidth = 1.5;
    x.beginPath(); x.arc(sel.x, sel.y, sel.stats.range, 0, 7); x.fill(); x.stroke();
  }
  for (const t of G.towers) {
    x.save(); x.translate(t.x, t.y);
    if (t === sel) { x.strokeStyle = "#fff"; x.lineWidth = 3; x.beginPath(); x.arc(0, 0, TOWER_R + 3, 0, 7); x.stroke(); }
    drawTowerSprite(x, t.def, t.tiers, t.angle, G.time, t.anim / 0.15);
    x.restore();
  }
  const sorted = G.enemies.slice().sort((a, b) => a.y - b.y);
  for (const e of sorted) drawEnemy(x, e);
  for (const p of G.projs) {
    x.fillStyle = p.color; x.strokeStyle = "rgba(0,0,0,.45)"; x.lineWidth = 1;
    x.beginPath(); x.arc(p.x, p.y, p.size, 0, 7); x.fill(); x.stroke();
  }
  for (const f of G.fx) {
    const k = f.life / f.max;
    x.globalAlpha = Math.max(0, k);
    if (f.kind === "ring") { x.strokeStyle = f.color; x.lineWidth = 3; x.beginPath(); x.arc(f.x, f.y, f.r! * (1 - k * 0.5), 0, 7); x.stroke(); x.fillStyle = f.color; x.globalAlpha = k * 0.18; x.fill(); }
    else if (f.kind === "spark") { x.strokeStyle = f.color; x.lineWidth = 2; for (let i = 0; i < 4; i++) { const a = i * 1.57 + 0.6; x.beginPath(); x.moveTo(f.x + Math.cos(a) * 4, f.y + Math.sin(a) * 4); x.lineTo(f.x + Math.cos(a) * 10, f.y + Math.sin(a) * 10); x.stroke(); } }
    else if (f.kind === "line") { x.strokeStyle = f.color; x.lineWidth = 2.5; x.beginPath(); x.moveTo(f.x, f.y); x.lineTo(f.x2!, f.y2!); x.stroke(); }
    else { x.fillStyle = f.color; x.font = "700 15px Fredoka, sans-serif"; x.textAlign = "center"; x.strokeStyle = "#0009"; x.lineWidth = 3; x.strokeText(f.text!, f.x, f.y - (1 - k) * 18); x.fillText(f.text!, f.x, f.y - (1 - k) * 18); }
    x.globalAlpha = 1;
  }
  if (G.placing && G.mouse.on) {
    const ok = canPlace(G.mouse.x, G.mouse.y) && G.cash >= price(G.placing.cost);
    const s = computeStats(G.placing, [0, 0, 0]);
    if (s.range > 0 && s.range < 900) {
      x.fillStyle = ok ? "rgba(255,255,255,.2)" : "rgba(230,60,60,.28)"; x.strokeStyle = ok ? "#fff" : "#e04040"; x.lineWidth = 1.5;
      x.beginPath(); x.arc(G.mouse.x, G.mouse.y, s.range, 0, 7); x.fill(); x.stroke();
    }
    x.save(); x.translate(G.mouse.x, G.mouse.y); x.globalAlpha = ok ? 0.9 : 0.5;
    drawTowerSprite(x, G.placing, [0, 0, 0], 0, G.time); x.restore();
  }
}

// ───────────────────────── UI ─────────────────────────

const $ = (id: string) => document.getElementById(id)!;
const fmt = (n: number) => Math.floor(n).toLocaleString("en-US");

const ui = {
  shopBtns: [] as { def: TowerDef; el: HTMLButtonElement }[],
  init() {
    const shop = $("shop");
    TOWERS.forEach((def, i) => {
      const b = document.createElement("button");
      b.className = "shop-item"; b.type = "button"; b.id = "shop-" + def.id; b.title = def.desc;
      const c = document.createElement("canvas"); c.width = 88; c.height = 88;
      const x = c.getContext("2d")!; x.scale(2, 2); x.translate(22, 22); drawTowerSprite(x, def, [0, 0, 0], -0.5, 0.4);
      b.append(c);
      const n = document.createElement("span"); n.className = "nm"; n.textContent = def.name;
      const p = document.createElement("span"); p.className = "cost"; p.textContent = fmt(def.cost);
      b.append(n, p);
      b.addEventListener("click", () => { G.placing = G.placing === def ? null : def; G.selected = null; ui.refresh(); });
      shop.append(b); ui.shopBtns.push({ def, el: b });
      void i;
    });
    $("btn-start").addEventListener("click", () => { if (G.inRound) { G.paused = !G.paused; } else startRound(); ui.refresh(); });
    $("btn-speed").addEventListener("click", () => { G.speed = G.speed === 1 ? 2 : G.speed === 2 ? 4 : 1; ui.refresh(); });
    $("btn-auto").addEventListener("click", () => { G.auto = !G.auto; ui.refresh(); });
    $("btn-mute").addEventListener("click", () => { G.muted = !G.muted; ui.refresh(); });
    $("btn-menu").addEventListener("click", () => { G.screen = "menu"; ui.refresh(); });
    $("btn-sell").addEventListener("click", () => {
      const t = G.selected; if (!t) return;
      G.cash += Math.floor(t.spent * 0.8); G.towers = G.towers.filter((o) => o !== t); G.selected = null; ui.refresh();
    });
    $("btn-target").addEventListener("click", () => {
      const t = G.selected; if (!t) return;
      const order = ["first", "last", "strong", "close"] as const;
      t.target = order[(order.indexOf(t.target) + 1) % 4]!; ui.refresh();
    });
    $("btn-retry").addEventListener("click", () => newGame(G.map));
    $("btn-over-menu").addEventListener("click", () => { G.screen = "menu"; ui.refresh(); });
    $("btn-freeplay").addEventListener("click", () => { G.freeplay = true; G.screen = "play"; ui.refresh(); });
    $("btn-won-menu").addEventListener("click", () => { G.screen = "menu"; ui.refresh(); });

    const toGame = (ev: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      G.mouse.x = (ev.clientX - r.left) * W / r.width; G.mouse.y = (ev.clientY - r.top) * H / r.height; G.mouse.on = true;
    };
    canvas.addEventListener("pointermove", toGame);
    canvas.addEventListener("pointerleave", () => (G.mouse.on = false));
    canvas.addEventListener("contextmenu", (e) => { e.preventDefault(); G.placing = null; ui.refresh(); });
    canvas.addEventListener("pointerdown", (ev) => {
      if (G.screen !== "play" || ev.button === 2) return;
      toGame(ev);
      const { x, y } = G.mouse;
      if (G.placing) {
        if (canPlace(x, y) && G.cash >= price(G.placing.cost)) {
          const def = G.placing;
          const t: Tower = { id: G.nextId++, def, x, y, tiers: def.paths.map(() => 0), stats: computeStats(def, []), cd: 0, angle: -Math.PI / 2, target: "first", cracks: 0, spent: price(def.cost), anim: 0 };
          G.cash -= price(def.cost); G.towers.push(t);
          if (!ev.shiftKey) { G.placing = null; G.selected = t; }
        }
      } else {
        G.selected = G.towers.find((t) => Math.hypot(t.x - x, t.y - y) <= TOWER_R + 4) ?? null;
      }
      ui.refresh();
    });
    window.addEventListener("keydown", (e) => {
      if (G.screen !== "play") return;
      if (e.key === "Escape") { G.placing = null; G.selected = null; }
      else if (e.key === " ") { e.preventDefault(); $("btn-start").click(); return; }
      else if (/^[1-8]$/.test(e.key)) { const d = TOWERS[+e.key - 1]; if (d) { G.placing = d; G.selected = null; } }
      else return;
      ui.refresh();
    });

    // map cards
    const list = $("maps");
    MAPS.forEach((m) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "map-card"; b.id = "map-" + m.id;
      const c = document.createElement("canvas"); c.width = 240; c.height = 180;
      const prev = G.segs, prevLen = G.pathLen, prevMap = G.map, prevBg = G.bg;
      setMap(m); c.getContext("2d")!.drawImage(G.bg!, 0, 0, 240, 180);
      G.segs = prev; G.pathLen = prevLen; G.map = prevMap; G.bg = prevBg;
      const n = document.createElement("strong"); n.textContent = m.name;
      const d = document.createElement("span"); d.className = "meta"; d.dataset.map = m.id; d.dataset.diff = m.difficulty;
      b.append(c, n, d);
      b.addEventListener("click", () => newGame(m));
      list.append(b);
    });
  },
  upgrade(path: number) {
    const t = G.selected; if (!t) return;
    if (upgradeBlocked(t.tiers, path)) return;
    const u = t.def.paths[path]!.upgrades[t.tiers[path]!]!;
    const c = price(u.cost);
    if (G.cash < c) return;
    G.cash -= c; t.spent += c; t.tiers[path]!++; t.stats = computeStats(t.def, t.tiers);
    ui.refresh();
  },
  lastCash: -1, pathSig: "",
  refresh() {
    $("menu").hidden = G.screen !== "menu";
    $("over").hidden = G.screen !== "over";
    $("won").hidden = G.screen !== "won";
    if (G.screen === "over") $("over-text").textContent = `The dolls reached the toy chest on round ${G.round}.`;
    document.querySelectorAll<HTMLElement>(".map-card .meta").forEach((el) => {
      const best = store.get("best:" + el.dataset.map) ?? 0;
      el.textContent = el.dataset.diff + (best ? ` · best round ${best}` : "");
    });
    $("stat-lives").textContent = fmt(G.lives);
    $("stat-cash").textContent = fmt(G.cash);
    $("stat-round").textContent = G.round ? `${G.round}${G.freeplay || G.round > FINAL_ROUND ? "" : " / " + FINAL_ROUND}` : "—";
    $("btn-start").textContent = G.inRound ? (G.paused ? "Resume" : "Pause") : `Start round ${G.round + 1}`;
    $("btn-speed").textContent = `Speed ×${G.speed}`;
    $("btn-auto").textContent = G.auto ? "Auto-start: on" : "Auto-start: off";
    $("btn-mute").textContent = G.muted ? "Sound: off" : "Sound: on";
    for (const { def, el } of ui.shopBtns) {
      el.classList.toggle("active", G.placing === def);
      el.classList.toggle("poor", G.cash < price(def.cost));
      el.querySelector(".cost")!.textContent = fmt(price(def.cost));
    }
    const t = G.selected, panel = $("panel"), hint = $("hint");
    panel.hidden = !t; hint.hidden = !!t;
    if (G.placing) hint.textContent = `Placing ${G.placing.name}. Click the workshop floor to set it down. ${G.placing.desc}`;
    else hint.textContent = "Pick a toy from the shop, then click the floor to place it. Click a placed toy to upgrade it.";
    if (!t) return;
    $("sel-name").textContent = t.def.name;
    $("sel-info").textContent = t.stats.kind === "income" ? `Pays ${fmt(t.stats.income)} per round` : `${fmt(t.cracks)} layers cracked`;
    $("btn-target").textContent = `Target: ${t.target}`;
    ($("btn-target") as HTMLButtonElement).hidden = t.stats.kind !== "shot";
    $("btn-sell").textContent = `Sell for ${fmt(t.spent * 0.8)}`;
    const sig = G.map.id + t.id + ":" + t.tiers.join("") + ":" + t.def.paths.map((p, i) => { const u = p.upgrades[t.tiers[i]!]; return u && G.cash >= price(u.cost) ? 1 : 0; }).join("");
    if (sig === ui.pathSig) return;
    ui.pathSig = sig;
    const box = $("paths"); box.textContent = "";
    t.def.paths.forEach((p, i) => {
      const tier = t.tiers[i]!, blocked = upgradeBlocked(t.tiers, i), u = p.upgrades[tier];
      const b = document.createElement("button"); b.type = "button"; b.className = "upg"; b.id = "upg-" + i;
      b.style.setProperty("--path", PATH_COLORS[i]!);
      const pips = Array.from({ length: MAX_TIER }, (_, k) => `<i class="${k < tier ? "on" : ""}"></i>`).join("");
      const head = document.createElement("span"); head.className = "upg-head";
      head.innerHTML = `<span class="pname"></span><span class="pips">${pips}</span>`;
      head.querySelector(".pname")!.textContent = p.name;
      const title = document.createElement("strong"), desc = document.createElement("span"); desc.className = "desc";
      if (blocked || !u) { title.textContent = tier >= MAX_TIER ? p.upgrades[MAX_TIER - 1]!.name : "Locked"; desc.textContent = blocked ?? ""; b.disabled = true; }
      else { title.textContent = `${u.name} · ${fmt(price(u.cost))}`; desc.textContent = u.desc; b.classList.toggle("poor", G.cash < price(u.cost)); }
      b.append(head, title, desc);
      b.addEventListener("click", () => ui.upgrade(i));
      box.append(b);
    });
  },
};

// ───────────────────────── Loop ─────────────────────────

let last = performance.now(), acc = 0;
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (G.screen === "play" && !G.paused) {
    acc += dt * G.speed;
    let n = 0;
    while (acc >= 1 / 60 && n++ < 12) { step(1 / 60); acc -= 1 / 60; if (G.screen !== "play") break; }
    if (n >= 12) acc = 0;
  }
  if (Math.floor(G.cash) !== ui.lastCash || G.selected) {
    if (Math.floor(G.cash) !== ui.lastCash) { ui.lastCash = Math.floor(G.cash); ui.refresh(); }
    else if (G.selected) $("sel-info").textContent = G.selected.stats.kind === "income" ? `Pays ${fmt(G.selected.stats.income)} per round` : `${fmt(G.selected.cracks)} layers cracked`;
  }
  $("stat-lives").textContent = fmt(G.lives);
  draw();
  requestAnimationFrame(frame);
}

setMap(MAPS[0]!);
ui.init();
ui.refresh();
requestAnimationFrame(frame);
// Exposed for debugging and automated tests.
(window as any).nestfall = { G, step, startRound, genRound, TOWERS, ENEMIES, computeStats, canPlace, ui, newGame, MAPS, rbe, price };
