# probable-winner

## BTD tower data fetcher

A Bun script that pulls tower names, upgrade names, tower images and upgrade images
for **Bloons TD 5** and **Bloons TD 6** from public GitHub repositories.

```sh
bun install
bun run fetch              # BTD5 + BTD6, names + images -> ./data
bun run fetch:btd5         # only BTD5
bun run fetch:btd6         # only BTD6
bun run fetch:names        # JSON only, skip images
bun scripts/fetch-btd-data.ts --out some/dir --force --concurrency 16
```

### Output

```
data/
  btd5/towers.json                                   # 17 towers, 136 upgrades (name, path, tier, cost, image)
  btd5/images/towers/<tower>.png
  btd5/images/upgrades/<tower>/<path>-<tier>-<name>.png
  btd6/towers.json                                   # 26 towers, 390 upgrades (id, name, path, tier, crosspath, unlock XP, images)
  btd6/images/towers/<Tower>.png
  btd6/images/upgrades/<Tower>/<path>-<tier>-<name>.png
  btd6/images/portraits/<Tower>/<crosspath>.png      # e.g. 300.png, 050.png
```

Existing images are skipped on re-runs unless `--force` is passed.

### Sources

| Data | Repository |
| --- | --- |
| BTD5 tower + upgrade names, costs | [cnqso/bloonsbench](https://github.com/cnqso/bloonsbench) `harness/env/menu_nav.py` |
| BTD5 tower + upgrade icons | [JamByte/bloonsclicker](https://github.com/JamByte/bloonsclicker) `Assets/Resources/UpgradeIcons` |
| BTD5 icon fallback (sprite sheet, cropped locally) | [tjdwns1314/Winapi-btd-5](https://github.com/tjdwns1314/Winapi-btd-5) `Resource/Sprite/upgrade_icons.*` |
| BTD6 towers, upgrades, names, icons, portraits | [HalfHydra/BTD6-API-Explorer](https://github.com/HalfHydra/BTD6-API-Explorer) `data/`, `assets/` |

## Nestfall (original tower defense game)

An original tower defense game in `game/`. Nesting dolls march along a ribbon; every hit cracks
one open and a smaller, faster doll steps out. All art is drawn in code and all names and designs are
original. It does not use the fetched BTD data or any Ninja Kiwi assets.

```sh
bun run game:build        # writes game/dist/index.html, a single self-contained file
open game/dist/index.html # or just double-click it
```

- 8 towers, each with **3 upgrade paths of 5 tiers** (120 upgrades). A tower can use two paths, and only one may pass tier 2.
- 12 doll types with layers, immunities (sharp / blast / cold), veiled dolls and two boss dolls.
- 3 maps, 40 rounds, then endless play. Speed ×1/×2/×4, auto-start, targeting modes, selling.
- Keys: `1`-`8` pick a tower, `Space` starts or pauses, `Esc` cancels, Shift-click places several.

### Changing the game

Everything is data in `game/data/`:

| File | What it holds |
| --- | --- |
| `towers.json` | Towers, base stats, and every upgrade as `set` / `add` / `mul` changes to those stats |
| `enemies.json` | Doll types: speed, hit points, children, immunities |
| `maps.json` | Track points on an 800×600 floor, theme, and `costScale` (price multiplier per map) |

To use your own art, add `"image": "<url or data URI>"` to a tower or enemy entry and it is drawn
instead of the built-in sprite.
