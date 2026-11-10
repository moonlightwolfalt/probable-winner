#!/usr/bin/env bun
/**
 * Fetches Bloons TD tower + upgrade data from public GitHub repositories.
 *
 * BTD5
 *   - tower names, upgrade names, upgrade costs  -> cnqso/bloonsbench (harness/env/menu_nav.py)
 *   - tower images, upgrade images               -> JamByte/bloonsclicker (Assets/Resources/UpgradeIcons, extracted BTD5 icons)
 *   - fallback upgrade images                    -> tjdwns1314/Winapi-btd-5 (original BTD5 upgrade_icons sprite sheet, cropped locally)
 *
 * BTD6
 *   - towers, upgrade ids, paths, unlock XP       -> HalfHydra/BTD6-API-Explorer (data/Constants.json)
 *   - display names                               -> HalfHydra/BTD6-API-Explorer (data/English.json)
 *   - tower images, upgrade images                -> HalfHydra/BTD6-API-Explorer (assets/TowerIcon, assets/UpgradeIcon)
 *
 * Usage:
 *   bun scripts/fetch-btd-data.ts [--game btd5|btd6|all] [--out data] [--no-images] [--force] [--concurrency 8]
 */
import { mkdir, writeFile, exists } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { PNG } from "pngjs";

// ───────────────────────────── CLI ─────────────────────────────

const { values: args } = parseArgs({
  options: {
    game: { type: "string", default: "all" },
    out: { type: "string", default: "data" },
    "no-images": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    concurrency: { type: "string", default: "8" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (args.help) {
  console.log(
    "Usage: bun scripts/fetch-btd-data.ts [--game btd5|btd6|all] [--out data] [--no-images] [--force] [--concurrency 8]",
  );
  process.exit(0);
}

const GAME = args.game!.toLowerCase();
if (!["btd5", "btd6", "all"].includes(GAME)) {
  console.error(`Unknown --game "${args.game}" (expected btd5, btd6 or all)`);
  process.exit(1);
}
const OUT = args.out!;
const WANT_IMAGES = !args["no-images"];
const FORCE = args.force!;
const CONCURRENCY = Math.max(1, Number(args.concurrency) || 8);

// ─────────────────────────── Sources ───────────────────────────

type Repo = { owner: string; repo: string; ref: string };

const SOURCES = {
  btd5Names: { owner: "cnqso", repo: "bloonsbench", ref: "main" },
  btd5Icons: { owner: "JamByte", repo: "bloonsclicker", ref: "master" },
  btd5Sheet: { owner: "tjdwns1314", repo: "Winapi-btd-5", ref: "main" },
  btd6: { owner: "HalfHydra", repo: "BTD6-API-Explorer", ref: "main" },
} satisfies Record<string, Repo>;

const raw = (r: Repo, path: string) =>
  `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${r.ref}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

const repoUrl = (r: Repo) => `https://github.com/${r.owner}/${r.repo}/tree/${r.ref}`;

// ─────────────────────────── Helpers ───────────────────────────

async function fetchWithRetry(url: string, tries = 4): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "btd-data-fetcher" } });
      if (res.status === 404) return res; // definitive, don't retry
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      lastErr = err;
    }
    await Bun.sleep(500 * 2 ** i);
  }
  throw lastErr;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchText(url)) as T;
}

/** Returns the bytes, or null on 404. */
async function fetchBytes(url: string): Promise<Uint8Array | null> {
  const res = await fetchWithRetry(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function writeOut(path: string, data: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/['’]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

const titleCase = (snake: string) =>
  snake
    .split("_")
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");

/** Run async tasks with a concurrency limit. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  });
  await Promise.all(workers);
}

/** An image to download: tries each candidate URL in order, or crops from a sprite sheet. */
type ImageJob = {
  dest: string; // relative to OUT
  urls: string[];
  sheetCell?: string; // BTD5 sprite-sheet fallback
  onDone: (result: { path: string; source: string } | null) => void;
};

const stats = { downloaded: 0, cached: 0, cropped: 0, missing: [] as string[] };

async function runImageJobs(jobs: ImageJob[], sheet?: () => Promise<SpriteSheet>) {
  let done = 0;
  await pool(jobs, CONCURRENCY, async (job) => {
    const abs = join(OUT, job.dest);
    if (!FORCE && (await exists(abs))) {
      stats.cached++;
      job.onDone({ path: job.dest, source: job.urls[0] ?? "cache" });
    } else {
      let ok = false;
      for (const url of job.urls) {
        const bytes = await fetchBytes(url);
        if (bytes) {
          await writeOut(abs, bytes);
          stats.downloaded++;
          job.onDone({ path: job.dest, source: url });
          ok = true;
          break;
        }
      }
      if (!ok && job.sheetCell && sheet) {
        const s = await sheet();
        const png = s.crop(job.sheetCell);
        if (png) {
          await writeOut(abs, png);
          stats.cropped++;
          job.onDone({ path: job.dest, source: `${s.url}#${job.sheetCell}` });
          ok = true;
        }
      }
      if (!ok) {
        stats.missing.push(job.dest);
        job.onDone(null);
      }
    }
    done++;
    if (done % 25 === 0 || done === jobs.length) {
      process.stdout.write(`\r    images: ${done}/${jobs.length}`);
      if (done === jobs.length) process.stdout.write("\n");
    }
  });
}

// ─────────────────────── BTD5 sprite sheet ───────────────────────

type SpriteSheet = { url: string; crop: (cell: string) => Uint8Array | null };

let sheetPromise: Promise<SpriteSheet> | undefined;
function loadBtd5Sheet(): Promise<SpriteSheet> {
  return (sheetPromise ??= (async () => {
    const xmlUrl = raw(SOURCES.btd5Sheet, "Resource/Sprite/upgrade_icons.xml");
    const pngUrl = raw(SOURCES.btd5Sheet, "Resource/Sprite/upgrade_icons.png");
    const [xml, pngBytes] = await Promise.all([fetchText(xmlUrl), fetchBytes(pngUrl)]);
    if (!pngBytes) throw new Error(`Sprite sheet missing: ${pngUrl}`);
    const img = PNG.sync.read(Buffer.from(pngBytes));
    const cells = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const m of xml.matchAll(/<Cell\s+([^>]*?)\/>/g)) {
      const attr = Object.fromEntries([...m[1]!.matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
      cells.set(attr.name!, { x: +attr.x!, y: +attr.y!, w: +attr.w!, h: +attr.h! });
    }
    return {
      url: pngUrl,
      crop(cell) {
        const c = cells.get(cell);
        if (!c) return null;
        const out = new PNG({ width: c.w, height: c.h });
        PNG.bitblt(img, out, c.x, c.y, c.w, c.h, 0, 0);
        return new Uint8Array(PNG.sync.write(out));
      },
    };
  })());
}

// ───────────────────────────── BTD5 ─────────────────────────────

/**
 * BTD5 icon keys (file names in the extracted game assets, minus "_icon.png"),
 * keyed by bloonsbench tower id, then by upgrade name.
 */
const BTD5_ICONS: Record<string, { tower: string; upgrades: Record<string, string> }> = {
  dart_monkey: {
    tower: "dart_monkey",
    upgrades: {
      "Long Range Darts": "dart_monkey_longer_range",
      "Enhanced Eyesight": "dart_monkey_enhanced_eyesight",
      "Spike-O-Pult": "dart_monkey_spikeopult",
      Juggernaut: "dart_monkey_juggernaut",
      "Sharp Shots": "dart_monkey_sharp_shots",
      "Razor Sharp Shots": "dart_monkey_razor",
      "Triple Darts": "dart_monkey_triple",
      "Super Monkey Fan Club": "dart_monkey_fanclub",
    },
  },
  tack_shooter: {
    tower: "tack_shooter",
    upgrades: {
      "Faster Shooting": "tack_shooter_faster_firing",
      "Even Faster Shooting": "tack_shooter_even_faster_firing",
      "Tack Sprayer": "tack_shooter_sprayer",
      "Ring of Fire": "tack_shooter_rof",
      "Extra Range Tacks": "tack_shooter_extra_range",
      "Super Range Tacks": "tack_shooter_super_range",
      "Blade Shooter": "tack_shooter_blade",
      "Blade Maelstrom": "tack_shooter_maelstrom",
    },
  },
  sniper_monkey: {
    tower: "sniper",
    upgrades: {
      "Full Metal Jacket": "sniper_full_metal",
      "Point Five Oh": "sniper_point_50",
      "Deadly Precision": "sniper_deadly_precision",
      "Cripple MOAB": "sniper_cripple_moab",
      "Faster Firing": "sniper_faster_firing",
      "Night Vision Goggles": "sniper_nvg",
      "Semi-Automatic Rifle": "sniper_semi_auto",
      "Supply Drop": "sniper_supply_drop",
    },
  },
  boomerang_thrower: {
    tower: "boomerang",
    upgrades: {
      "Multi-Target": "boomerang_multi_target",
      "Glaive Thrower": "boomerang_glaive_thrower",
      "Glaive Riccochet": "boomerang_glaive_riccochet",
      "Glaive Lord": "boomerang_glaive_lord",
      "Sonic Boom": "boomerang_sonic_boom",
      "Red Hot 'Rangs": "boomerang_red_hot",
      "Bionic Boomer": "boomerang_bionic_boomer",
      "Turbo Charge": "boomerang_turbo_charge",
    },
  },
  ninja_monkey: {
    tower: "ninja",
    upgrades: {
      "Ninja Discipline": "ninja_discipline",
      "Sharp Shurikens": "ninja_sharp_shurikens",
      "Double Shot": "ninja_double_shot",
      Bloonjitsu: "ninja_bloonjitsu",
      "Seeking Shuriken": "ninja_seeking_shuriken",
      Distraction: "ninja_distraction",
      "Flash Bomb": "ninja_flash_bomb",
      "Sabotage Supply Lines": "ninja_sabotage",
    },
  },
  bomb_tower: {
    tower: "bomb",
    upgrades: {
      "Longer Range": "bomb_extra_range",
      "Frag Bombs": "bomb_frag",
      "Cluster Bombs": "bomb_cluster",
      "Bloon Impact": "bomb_impact",
      "Bigger Bombs": "bomb_bigger",
      "Missile Launcher": "bomb_missile",
      "MOAB Mauler": "bomb_mauler",
      "MOAB Assassin": "bomb_assassin",
    },
  },
  ice_tower: {
    tower: "ice",
    upgrades: {
      "Enhanced Freeze": "ice_enhanced_freeze",
      "Snap Freeze": "ice_snap_freeze",
      "Arctic Wind": "ice_arctic_wind",
      "Viral Frost": "ice_viral_frost",
      Permafrost: "ice_permafrost",
      "Deep Freeze": "ice_deep_freeze",
      "Ice Shards": "ice_shards",
      "Absolute Zero": "ice_absolute_zero",
    },
  },
  glue_gunner: {
    tower: "glue_gunner",
    upgrades: {
      "Glue Soak": "glue_soak",
      "Corrosive Glue": "glue_corrosive",
      "Bloon Dissolver": "glue_dissolver",
      "Bloon Liquefier": "glue_liquefier",
      "Stickier Glue": "glue_stickier_glue",
      "Glue Splatter": "glue_splatter",
      "Glue Hose": "glue_hose",
      "Glue Striker": "glue_striker",
    },
  },
  monkey_buccaneer: {
    tower: "buccaneer",
    upgrades: {
      "Faster Shooting": "buccaneer_faster_shooting",
      "Longer Cannons": "buccaneer_longer_cannons",
      Destroyer: "buccaneer_destroyer",
      "Aircraft Carrier": "buccaneer_aircraft_carrier",
      "Grape Shot": "buccaneer_grape",
      "Crow's Nest": "buccaneer_crows_nest",
      "Cannon Ship": "buccaneer_cannon_ship",
      "Monkey Pirates": "buccaneer_pirates",
    },
  },
  monkey_ace: {
    tower: "monkey_ace",
    upgrades: {
      "Rapid Fire": "monkey_ace_rapid_fire",
      "Sharper Darts": "monkey_ace_sharper_darts",
      "Neva-Miss Targeting": "monkey_ace_targeting",
      Spectre: "monkey_ace_spectre",
      "Pineapple Express": "monkey_ace_pineapple",
      "Spy Plane": "monkey_ace_spyplane",
      "Operation: Dart Storm": "monkey_ace_ods",
      "Ground Zero": "monkey_ace_ground_zero",
    },
  },
  super_monkey: {
    tower: "supermonkey",
    upgrades: {
      "Laser Blasts": "supermonkey_laser_vision",
      "Plasma Blasts": "supermonkey_plasma_vision",
      "Sun God": "supermonkey_sun_god",
      "Temple of the Monkey God": "supermonkey_temple",
      "Super Range": "supermonkey_super_range",
      "Epic Range": "supermonkey_epic_range",
      "Robo Monkey": "supermonkey_robomonkey",
      "Technological Terror": "supermonkey_tech_terror",
    },
  },
  monkey_apprentice: {
    tower: "apprentice",
    upgrades: {
      "Intense Magic": "apprentice_intense_magic",
      "Lightning Bolt": "apprentice_lightning",
      "Summon Whirlwind": "apprentice_whirlwind",
      "Tempest Tornado": "apprentice_tornado",
      Fireball: "apprentice_fireball",
      "Monkey Sense": "apprentice_monkey_sense",
      "Dragon's Breath": "apprentice_dragon_breath",
      "Summon Phoenix": "apprentice_phoenix",
    },
  },
  monkey_village: {
    tower: "village",
    upgrades: {
      "Monkey Beacon": "village_beacon",
      "Jungle Drums": "village_jungle_drums",
      "Monkey Town": "village_monkey_town",
      "High Energy Beacon": "village_high_energy_beacon",
      "Monkey Fort": "village_fort",
      "Radar Scanner": "village_radar",
      "Monkey Intelligence Bureau": "village_mib",
      "MIB Call to Arms": "village_call_to_arms",
    },
  },
  banana_farm: {
    tower: "banana_farm",
    upgrades: {
      "More Bananas": "banana_farm_more_bananas",
      "Banana Plantation": "banana_farm_plantation",
      "Banana Republic": "banana_farm_republic",
      "Banana Research Facility": "banana_farm_brf",
      "Long Life Bananas": "banana_farm_long_life",
      "Valuable Bananas": "banana_farm_valuable",
      "Monkey Bank": "banana_farm_bank",
      "Banana Investments Advisory": "banana_farm_investments",
    },
  },
  mortar_tower: {
    tower: "mortar",
    upgrades: {
      "Increased Accuracy": "mortar_accuracy",
      "Bigger Blast": "mortar_bigger_bombs",
      "Bloon Buster": "mortar_bloon_buster",
      "The Big One": "mortar_big_one",
      "Rapid Reload": "mortar_rapid_reload",
      "Burny Stuff": "mortar_burny",
      "Signal Flare": "mortar_signal_flare",
      "Artillery Battery": "mortar_artillery",
    },
  },
  dartling_gun: {
    tower: "dartling_gun",
    upgrades: {
      "Focused Firing": "dartling_gun_focused",
      "Faster Barrel Spin": "dartling_gun_faster_barrel",
      "Laser Cannon": "dartling_gun_laser",
      "Ray of Doom": "dartling_gun_ray_of_doom",
      "Powerful Darts": "dartling_gun_powerful_darts",
      "Depleted Bloontonium Darts": "dartling_gun_bloontonium",
      "Hydra Rocket Pods": "dartling_gun_hydra",
      "Bloon Area Denial System": "dartling_gun_bads",
    },
  },
  spike_factory: {
    tower: "spike_factory",
    upgrades: {
      "Bigger Stacks": "spike_factory_bigger_stacks",
      "White Hot Spikes": "spike_factory_white_hot",
      "Spiked Ball Factory": "spike_factory_spiked_balls",
      "Spiked Mines": "spike_factory_spiked_mines",
      "Faster Production": "spike_factory_faster_production",
      "Even Faster Production": "spike_factory_even_faster_production",
      "MOAB-SHREDR Spikes": "spike_factory_moab_shredr",
      "Spike Storm": "spike_factory_spike_storm",
    },
  },
};

type Image = { path: string; source: string } | null;

type Btd5Upgrade = {
  path: number;
  tier: number;
  name: string;
  cost: number;
  iconKey: string | null;
  image: Image;
};
type Btd5Tower = {
  id: string;
  name: string;
  cost: number;
  iconKey: string | null;
  image: Image;
  upgrades: Btd5Upgrade[];
};

/** Parses the TOWERS dict in bloonsbench's harness/env/menu_nav.py. */
function parseBloonsbenchTowers(py: string) {
  const starts = [...py.matchAll(/^\s*"(\w+)":\s*TowerDef\(/gm)];
  if (!starts.length) throw new Error("Could not find any TowerDef entries in menu_nav.py");
  return starts.map((m, i) => {
    const block = py.slice(m.index!, starts[i + 1]?.index ?? py.indexOf("\n}", m.index!));
    const cost = Number(/cost\s*=\s*(\d+)/.exec(block)?.[1] ?? NaN);
    const p1 = block.slice(block.indexOf("path1="), block.indexOf("path2="));
    const p2 = block.slice(block.indexOf("path2="));
    const ups = (s: string) =>
      [...s.matchAll(/_U\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*(\d+)\s*\)/g)].map((u) => ({
        name: u[1]!,
        cost: Number(u[2]),
      }));
    return { id: m[1]!, cost, paths: [ups(p1), ups(p2)] };
  });
}

async function fetchBtd5() {
  console.log("BTD5");
  const namesUrl = raw(SOURCES.btd5Names, "harness/env/menu_nav.py");
  console.log(`  names  <- ${namesUrl}`);
  const parsed = parseBloonsbenchTowers(await fetchText(namesUrl));

  const iconBase = "Assets/Resources/UpgradeIcons";
  const jobs: ImageJob[] = [];
  const towers: Btd5Tower[] = parsed.map((t) => {
    const icons = BTD5_ICONS[t.id];
    if (!icons) console.warn(`  ! no icon mapping for BTD5 tower "${t.id}"`);
    const tower: Btd5Tower = {
      id: t.id,
      name: titleCase(t.id),
      cost: t.cost,
      iconKey: icons ? `${icons.tower}_icon` : null,
      image: null,
      upgrades: [],
    };
    if (icons && WANT_IMAGES) {
      jobs.push({
        dest: `btd5/images/towers/${t.id}.png`,
        urls: [raw(SOURCES.btd5Icons, `${iconBase}/${icons.tower}_icon.png`)],
        onDone: (img) => (tower.image = img),
      });
    }
    t.paths.forEach((path, p) =>
      path.forEach((u, tier) => {
        const key = icons?.upgrades[u.name];
        if (icons && !key) console.warn(`  ! no icon mapping for BTD5 upgrade "${t.id} / ${u.name}"`);
        const up: Btd5Upgrade = {
          path: p + 1,
          tier: tier + 1,
          name: u.name,
          cost: u.cost,
          iconKey: key ? `${key}_icon` : null,
          image: null,
        };
        tower.upgrades.push(up);
        if (key && WANT_IMAGES) {
          jobs.push({
            dest: `btd5/images/upgrades/${t.id}/${p + 1}-${tier + 1}-${slug(u.name)}.png`,
            urls: [raw(SOURCES.btd5Icons, `${iconBase}/${key}_icon.png`)],
            sheetCell: `${key}_icon`,
            onDone: (img) => (up.image = img),
          });
        }
      }),
    );
    return tower;
  });

  if (jobs.length) {
    console.log(`  images <- ${repoUrl(SOURCES.btd5Icons)}/${iconBase}`);
    await runImageJobs(jobs, loadBtd5Sheet);
  }

  const out = {
    game: "Bloons TD 5",
    generatedAt: new Date().toISOString(),
    sources: {
      names: namesUrl,
      images: `${repoUrl(SOURCES.btd5Icons)}/${iconBase}`,
      imageFallback: raw(SOURCES.btd5Sheet, "Resource/Sprite/upgrade_icons.png"),
    },
    towers,
  };
  await writeOut(join(OUT, "btd5/towers.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(
    `  wrote ${join(OUT, "btd5/towers.json")} (${towers.length} towers, ${towers.reduce((n, t) => n + t.upgrades.length, 0)} upgrades)`,
  );
}

// ───────────────────────────── BTD6 ─────────────────────────────

type Btd6Constants = {
  projectContentVersion?: number;
  towersInOrder: Record<
    string,
    {
      category: string;
      path1: Record<string, number>;
      path2: Record<string, number>;
      path3: Record<string, number>;
    }
  >;
  paragonsAvailable?: Record<string, number>;
};

type Btd6Upgrade = {
  id: string;
  name: string;
  path: number;
  tier: number;
  crosspath: string; // e.g. "300"
  unlockXp: number;
  icon: Image;
  portrait: Image;
};
type Btd6Tower = {
  id: string;
  name: string;
  category: string;
  image: Image;
  upgrades: Btd6Upgrade[];
};

/** Parses `const upgradeNameFixMap = {...}` out of the explorer's src/asset.js. */
function parseUpgradeFixMap(js: string): Record<string, string> {
  const m = /upgradeNameFixMap\s*=\s*(\{[\s\S]*?\n\})/.exec(js);
  if (!m) return {};
  try {
    return JSON.parse(m[1]!.replace(/,\s*\}$/, "}"));
  } catch {
    return {};
  }
}

async function fetchBtd6() {
  console.log("BTD6");
  const repo = SOURCES.btd6;
  const constantsUrl = raw(repo, "data/Constants.json");
  const englishUrl = raw(repo, "data/English.json");
  const assetJsUrl = raw(repo, "src/asset.js");
  console.log(`  data   <- ${repoUrl(repo)}/data`);
  const [constants, english, assetJs] = await Promise.all([
    fetchJson<Btd6Constants>(constantsUrl),
    fetchJson<Record<string, string>>(englishUrl),
    fetchText(assetJsUrl).catch(() => ""),
  ]);
  // Repo file names that don't follow the "<Name>UpgradeIcon.png" convention and aren't in the explorer's own fix map.
  const fixMap = { AbsoluteZero: "ABsoluteZero", ...parseUpgradeFixMap(assetJs) };
  const loc = (key: string) => english[key] ?? key;
  const assetTowerId = (id: string) => (id === "WizardMonkey" ? "Wizard" : id);

  const jobs: ImageJob[] = [];
  const towers: Btd6Tower[] = Object.entries(constants.towersInOrder).map(([id, t]) => {
    const tower: Btd6Tower = { id, name: loc(id), category: t.category, image: null, upgrades: [] };
    if (WANT_IMAGES) {
      jobs.push({
        dest: `btd6/images/towers/${id}.png`,
        urls: [raw(repo, `assets/TowerIcon/000-${assetTowerId(id)}.png`)],
        onDone: (img) => (tower.image = img),
      });
    }
    ([t.path1, t.path2, t.path3] as const).forEach((path, p) =>
      Object.entries(path ?? {}).forEach(([upId, xp], tier) => {
        const crosspath = [0, 0, 0].map((_, i) => (i === p ? tier + 1 : 0)).join("");
        const up: Btd6Upgrade = {
          id: upId,
          name: loc(upId),
          path: p + 1,
          tier: tier + 1,
          crosspath,
          unlockXp: xp,
          icon: null,
          portrait: null,
        };
        tower.upgrades.push(up);
        if (!WANT_IMAGES) return;
        const stripped = upId.replace(/[^a-zA-Z0-9]/g, "");
        const fixed = fixMap[stripped] ?? stripped;
        const base = `${id}/${p + 1}-${tier + 1}-${slug(up.name)}`;
        jobs.push({
          dest: `btd6/images/upgrades/${base}.png`,
          urls: [
            raw(repo, `assets/UpgradeIcon/${fixed}UpgradeIcon.png`),
            raw(repo, `assets/UpgradeIcon/${stripped}UpgradeIcon.png`),
            raw(repo, `assets/UpgradeIcon/${fixed}.png`),
          ].filter((u, i, a) => a.indexOf(u) === i),
          onDone: (img) => (up.icon = img),
        });
        jobs.push({
          dest: `btd6/images/portraits/${id}/${crosspath}.png`,
          urls: [raw(repo, `assets/TowerIcon/${crosspath}-${assetTowerId(id)}.png`)],
          onDone: (img) => (up.portrait = img),
        });
      }),
    );
    return tower;
  });

  if (jobs.length) {
    console.log(`  images <- ${repoUrl(repo)}/assets`);
    await runImageJobs(jobs);
  }

  const out = {
    game: "Bloons TD 6",
    contentVersion: constants.projectContentVersion ?? null,
    generatedAt: new Date().toISOString(),
    sources: { constants: constantsUrl, names: englishUrl, images: `${repoUrl(repo)}/assets` },
    towers,
  };
  await writeOut(join(OUT, "btd6/towers.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(
    `  wrote ${join(OUT, "btd6/towers.json")} (${towers.length} towers, ${towers.reduce((n, t) => n + t.upgrades.length, 0)} upgrades)`,
  );
}

// ───────────────────────────── Main ─────────────────────────────

const started = performance.now();
if (GAME === "btd5" || GAME === "all") await fetchBtd5();
if (GAME === "btd6" || GAME === "all") await fetchBtd6();

if (WANT_IMAGES) {
  console.log(
    `\nImages: ${stats.downloaded} downloaded, ${stats.cropped} cropped from sprite sheet, ${stats.cached} already present, ${stats.missing.length} missing`,
  );
  if (stats.missing.length) {
    console.log("Missing:");
    for (const m of stats.missing) console.log(`  - ${m}`);
  }
}
console.log(`Done in ${((performance.now() - started) / 1000).toFixed(1)}s -> ${OUT}/`);
