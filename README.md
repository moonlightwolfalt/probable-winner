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
