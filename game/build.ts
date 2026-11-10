#!/usr/bin/env bun
// Bundles the game into a single self-contained HTML file: game/dist/index.html
import { join } from "node:path";
const dir = import.meta.dir;
const out = await Bun.build({ entrypoints: [join(dir, "src/main.ts")], minify: true, target: "browser" });
if (!out.success) { for (const l of out.logs) console.error(l); process.exit(1); }
const js = (await out.outputs[0]!.text()).replaceAll("</script", "<\\/script");
const css = await Bun.file(join(dir, "src/style.css")).text();
const page = (await Bun.file(join(dir, "page.html")).text()).replace("/*CSS*/", () => css).replace("/*JS*/", () => js);
// fragment (no <html>/<body>) for hosts that wrap the page themselves, plus a standalone document
await Bun.write(join(dir, "dist/fragment.html"), page);
await Bun.write(join(dir, "dist/index.html"),
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body style="margin:0">\n${page}\n</body>\n</html>\n`);
console.log(`Built game/dist/index.html (${(page.length / 1024).toFixed(0)} KB)`);
