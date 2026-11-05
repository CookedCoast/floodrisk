#!/usr/bin/env node
/*
 * Builds flood elevation tiles for Flood Risk & Tax Base.
 *
 * For each town (SECOG towns first) it finds the FEMA flood zones and the coastal reach around
 * VE zones, marks the zoom-15 Web Mercator tiles they touch, downloads USGS 3DEP 1 m elevation
 * for those tiles in 2048 x 2048 px blocks (8 x 8 tiles per request), and writes
 * data/dem/15/<x>/<y>.png. Parent tiles for zooms 14-12 are averaged from their children.
 * The app reads these tiles instead of asking USGS for every map view.
 *
 * Tile encoding: RGBA PNG, value = round((elevation_m + 100) * 20) in R (high byte) and G (low byte),
 * i.e. 5 cm steps from -100 m; alpha 0 = no data.
 *
 * Environment: TOWNS (comma list), FORCE ("true" rebuilds towns already listed), MAX_MINUTES, GIT_COMMIT.
 * Needs: npm install geotiff pngjs
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fromArrayBuffer } from "geotiff";
import { PNG } from "pngjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PARCELS = "https://services3.arcgis.com/3FL1kr7L4LvwA2Kb/ArcGIS/rest/services/Connecticut_CAMA_and_Parcel_Layer/FeatureServer/0/query";
const FEMA = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query";
const ELEV = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage";
const OUT = path.join(ROOT, "data", "dem");
const Z = 15, BLOCK = 8, ZMIN = 12;
const R = 6378137, O = Math.PI * R, TS = (2 * O) / 2 ** Z;
const REACH_M = 1500;
const FORCE = process.env.FORCE === "true";
const MAX_MS = (Number(process.env.MAX_MINUTES) || 300) * 60000;
const GIT = process.env.GIT_COMMIT === "true";
const T0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function get(url, opts = {}, tries = 5, as = "json") {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(180000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      if (as === "buf") return await r.arrayBuffer();
      const j = await r.json();
      if (j && j.error) throw new Error(j.error.message || "service error");
      return j;
    } catch (e) { if (i >= tries - 1) throw e; await sleep(3000 * 2 ** i); }
  }
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}
const merc = (lon, lat) => [R * lon * Math.PI / 180, R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
const tileOf = (mx, my) => [Math.floor((mx + O) / TS), Math.floor((O - my) / TS)];
const polysOf = (g) => !g ? [] : g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
function inRing(x, y, r) { let ins = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) ins = !ins; } return ins; }

async function townList() {
  const j = await get(PARCELS + "?where=1%3D1&outFields=COG,Town_Name&returnDistinctValues=true&returnGeometry=false&f=json");
  const rows = j.features.map((f) => f.attributes).filter((a) => a.Town_Name);
  rows.sort((a, b) => (b.COG === "Southeastern CT") - (a.COG === "Southeastern CT") || a.Town_Name.localeCompare(b.Town_Name));
  const seen = new Set(), out = [];
  for (const r of rows) if (!seen.has(r.Town_Name)) { seen.add(r.Town_Name); out.push(r.Town_Name); }
  if (process.env.TOWNS) { const want = new Set(process.env.TOWNS.split(",").map((s) => s.trim())); return out.filter((t) => want.has(t)); }
  return out;
}
async function townExtent(town) {
  const w = encodeURIComponent(`Town_Name='${town.replace(/'/g, "''")}'`);
  const j = await get(`${PARCELS}?where=${w}&returnExtentOnly=true&outSR=4326&f=json`);
  const e = j.extent; return [e.xmin, e.ymin, e.xmax, e.ymax];
}
async function zonesIn(bb) {
  const where = encodeURIComponent("SFHA_TF='T' OR ZONE_SUBTY LIKE '%0.2 PCT%'");
  const out = new Map();
  async function q(t, depth) {
    const url = `${FEMA}?where=${where}&geometry=${t.map((v) => v.toFixed(5)).join(",")}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=OBJECTID,FLD_ZONE,STATIC_BFE&returnGeometry=true&outSR=4326&geometryPrecision=5&maxAllowableOffset=0.00005&f=geojson`;
    const j = await get(url);
    if ((j.exceededTransferLimit || (j.properties && j.properties.exceededTransferLimit)) && depth < 4) {
      const mx = (t[0] + t[2]) / 2, my = (t[1] + t[3]) / 2;
      for (const s of [[t[0], t[1], mx, my], [mx, t[1], t[2], my], [t[0], my, mx, t[3]], [mx, my, t[2], t[3]]]) await q(s, depth + 1);
    }
    for (const f of j.features || []) { const id = (f.properties || {}).OBJECTID ?? f.id; if (f.geometry && !out.has(id)) { const p = f.properties || {}; const bfe = p.STATIC_BFE > -9000 ? +p.STATIC_BFE : null;
      out.set(id, { v: /^V/.test(String(p.FLD_ZONE || "")) || (bfe != null && bfe <= 15), g: f.geometry }); } }
  }
  const tiles = [];
  for (let x = bb[0]; x < bb[2]; x += 0.04) for (let y = bb[1]; y < bb[3]; y += 0.04) tiles.push([x, y, Math.min(x + 0.04, bb[2]), Math.min(y + 0.04, bb[3])]);
  await pool(tiles, 3, (t) => q(t, 0));
  return [...out.values()];
}
/* Mark z15 tiles touched by flood zones (densified edges + interior centers) and within reach of VE zones. */
function markTiles(zones) {
  const set = new Set(), add = (x, y) => set.add(x + "," + y);
  const reachT = Math.ceil(REACH_M / (TS * Math.cos(41.5 * Math.PI / 180)));
  for (const z of zones) for (const poly of polysOf(z.g)) {
    const ring = poly[0].map(([lon, lat]) => merc(lon, lat));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (TS / 3)));
      for (let s = 0; s < steps; s++) {
        const [tx, ty] = tileOf(ax + (bx - ax) * s / steps, ay + (by - ay) * s / steps);
        if (z.v) { for (let dx = -reachT; dx <= reachT; dx++) for (let dy = -reachT; dy <= reachT; dy++) add(tx + dx, ty + dy); } else add(tx, ty);
      }
      if (ax < x0) x0 = ax; if (ax > x1) x1 = ax; if (ay < y0) y0 = ay; if (ay > y1) y1 = ay;
    }
    const [tx0, ty1] = tileOf(x0, y0), [tx1, ty0] = tileOf(x1, y1);
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 40000) continue;
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
      const cx = -O + (tx + 0.5) * TS, cy = O - (ty + 0.5) * TS;
      if (inRing(cx, cy, ring)) add(tx, ty);
    }
  }
  return set;
}
const tilePath = (z, x, y) => path.join(OUT, String(z), String(x), y + ".png");
function encode(vals, w, h) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const e = vals[i], j = 4 * i;
    if (!(e > -100 && e < 3000)) { png.data[j + 3] = 0; continue; }
    const v = Math.max(0, Math.min(65535, Math.round((e + 100) * 20)));
    png.data[j] = v >> 8; png.data[j + 1] = v & 255; png.data[j + 2] = 0; png.data[j + 3] = 255;
  }
  return PNG.sync.write(png, { colorType: 6 });
}
function decode(buf) {
  const png = PNG.sync.read(buf), out = new Float32Array(256 * 256).fill(NaN);
  for (let i = 0; i < 65536; i++) { const j = 4 * i; if (png.data[j + 3] > 0) out[i] = ((png.data[j] << 8) | png.data[j + 1]) / 20 - 100; }
  return out;
}
async function writeTile(z, x, y, buf) { const p = tilePath(z, x, y); await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, buf); }

/* Download one 8 x 8 block of z15 tiles and save the marked ones. */
/* Download an n x n group of z15 tiles (n = 8, 4, 2, 1) and save the wanted ones.
   USGS often times out (HTTP 502/504) on large requests, so a failed group is split into quadrants and retried. */
async function tileGroup(x0, y0, n, want) {
  const px = n * 256, xmin = -O + x0 * TS, ymax = O - y0 * TS, xmax = xmin + n * TS, ymin = ymax - n * TS;
  const url = `${ELEV}?bbox=${[xmin, ymin, xmax, ymax].map((v) => v.toFixed(3)).join(",")}&bboxSR=3857&imageSR=3857&size=${px},${px}&format=tiff&pixelType=F32&noData=-9999&interpolation=RSP_BilinearInterpolation&f=image`;
  let ras, w;
  try {
    const buf = await get(url, {}, n > 1 ? 2 : 5, "buf");
    const img = await (await fromArrayBuffer(buf)).getImage();
    [ras] = await img.readRasters(); w = img.getWidth();
  } catch (e) {
    if (n === 1) throw e;
    const h = n / 2; let saved = 0;
    for (const [qx, qy] of [[0, 0], [h, 0], [0, h], [h, h]]) {
      const sub = want.filter(([tx, ty]) => tx >= x0 + qx && tx < x0 + qx + h && ty >= y0 + qy && ty < y0 + qy + h);
      if (sub.length) saved += await tileGroup(x0 + qx, y0 + qy, h, sub);
    }
    return saved;
  }
  let saved = 0;
  for (const [tx, ty] of want) {
    const ox = (tx - x0) * 256, oy = (ty - y0) * 256, vals = new Float32Array(65536);
    for (let r = 0; r < 256; r++) for (let c = 0; c < 256; c++) vals[r * 256 + c] = ras[(oy + r) * w + ox + c];
    await writeTile(Z, tx, ty, encode(vals, 256, 256)); saved++;
  }
  return saved;
}
const block = (bx, by, want) => tileGroup(bx * BLOCK, by * BLOCK, BLOCK, want);
/* Average 2 x 2 children into each parent tile, for zooms 14 down to 12. */
async function pyramid(tiles15) {
  let level = new Set([...tiles15]);
  for (let z = Z - 1; z >= ZMIN; z--) {
    const parents = new Set([...level].map((k) => { const [x, y] = k.split(",").map(Number); return (x >> 1) + "," + (y >> 1); }));
    await pool([...parents], 8, async (k) => {
      const [px, py] = k.split(",").map(Number), out = new Float32Array(65536).fill(NaN);
      for (let q = 0; q < 4; q++) {
        const cx = px * 2 + (q & 1), cy = py * 2 + (q >> 1), p = tilePath(z + 1, cx, cy);
        if (!existsSync(p)) continue;
        const v = decode(await readFile(p)), offX = (q & 1) * 128, offY = (q >> 1) * 128;
        for (let r = 0; r < 128; r++) for (let c = 0; c < 128; c++) {
          let s = 0, m = 0;
          for (const [dr, dc] of [[0, 0], [0, 1], [1, 0], [1, 1]]) { const e = v[(2 * r + dr) * 256 + 2 * c + dc]; if (e === e) { s += e; m++; } }
          if (m) out[(offY + r) * 256 + offX + c] = s / m;
        }
      }
      if (out.some((e) => e === e)) await writeTile(z, px, py, encode(out, 256, 256));
    });
    level = parents;
  }
}
/* Commit and push, merging data/dem/towns.json with whatever other runs pushed meanwhile. */
function commit(msg, index, idxPath) {
  if (!GIT) return;
  const sh = (c) => execSync(c, { cwd: ROOT, stdio: "pipe", shell: "/bin/bash" }).toString();
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      try { sh("git rebase --abort"); } catch (e) {}
      sh("git fetch -q origin main");
      let remote = {};
      try { remote = JSON.parse(sh("git show origin/main:data/dem/towns.json")).towns || {}; } catch (e) {}
      index.towns = { ...remote, ...index.towns };
      execSync(`cat > ${JSON.stringify(idxPath)}`, { input: JSON.stringify(index, null, 1), cwd: ROOT, shell: "/bin/bash" });
      sh("git add data/dem");
      try { sh(`git diff --cached --quiet || git commit -q -m ${JSON.stringify(msg)}`); } catch (e) {}
      sh("git pull -q --rebase -X theirs origin main");
      sh("git push -q origin HEAD:main");
      return;
    } catch (e) { log(`commit/push attempt ${attempt} failed: ${String(e.stderr || e.message).split("\n")[0]}`); execSync("sleep " + 5 * attempt); }
  }
}
async function main() {
  await mkdir(OUT, { recursive: true });
  const idxPath = path.join(OUT, "towns.json");
  const index = existsSync(idxPath) ? JSON.parse(await readFile(idxPath, "utf8")) : { zoom: Z, minZoom: ZMIN, encoding: "RG = (m + 100) * 20, alpha 0 = no data", towns: {} };
  const towns = await townList();
  log(`${towns.length} towns`);
  let done = 0;
  for (const town of towns) {
    if (Date.now() - T0 > MAX_MS) { log("time budget reached; stopping"); break; }
    const slug = town.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!FORCE && index.towns[slug]) continue;
    try {
      const t = Date.now();
      const bb = await townExtent(town);
      const zones = await zonesIn(bb);
      const marked = markTiles(zones);
      const todo = [...marked].filter((k) => { const [x, y] = k.split(",").map(Number); return FORCE || !existsSync(tilePath(Z, x, y)); });
      const blocks = new Map();
      for (const k of todo) { const [x, y] = k.split(",").map(Number); const bk = (x >> 3) + "," + (y >> 3); if (!blocks.has(bk)) blocks.set(bk, []); blocks.get(bk).push([x, y]); }
      let saved = 0, failed = 0;
      await pool([...blocks.entries()], 4, async ([bk, want]) => {
        const [bx, by] = bk.split(",").map(Number);
        try { const n = await block(bx, by, want); saved += n; } catch (e) { failed++; log(`${town}: block ${bk} failed (${e.message})`); }
      });
      await pyramid(marked);
      if (failed === 0) {
        index.towns[slug] = { town, built: new Date().toISOString().slice(0, 10), tiles: marked.size };
        await writeFile(idxPath, JSON.stringify(index, null, 1));
        done++;
      }
      log(`${town}: ${zones.length} zones, ${marked.size} tiles (${saved} new, ${blocks.size} blocks, ${failed} failed${failed ? "; will finish on the next run" : ""}) in ${((Date.now() - t) / 1000).toFixed(0)} s`);
      commit(`Flood elevation tiles: ${town}`, index, idxPath);
    } catch (e) { log(`${town}: FAILED (${e.message}); will retry on the next run`); }
  }
  log(`done: ${done} towns in ${((Date.now() - T0) / 60000).toFixed(1)} min`);
}
main().catch((e) => { console.error(e); process.exit(1); });
