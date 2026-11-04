#!/usr/bin/env node
/*
 * Builds saved ground elevations for Flood Risk & Tax Base.
 *
 * For each Connecticut town it downloads parcel boundaries from the CT CAMA and Parcel Layer,
 * finds the same point inside each parcel that the app uses (geo.js pointOn), samples USGS 3DEP
 * lidar elevation there, and writes data/elev/<town-slug>.json plus data/elev/index.json.
 * The app loads these files first and only asks USGS for points that are missing.
 *
 * Environment:
 *   TOWNS        comma-separated town names as they appear in the parcel layer (default: all)
 *   FORCE        "true" to rebuild towns that already have a file (default: false)
 *   MAX_MINUTES  stop starting new towns after this many minutes (default: 300)
 *   GIT_COMMIT   "true" to commit and push progress every few towns (used by the GitHub Action)
 */
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { pointOn, ptKey, townSlug } = require(path.join(ROOT, "geo.js"));

const PARCELS = "https://services3.arcgis.com/3FL1kr7L4LvwA2Kb/ArcGIS/rest/services/Connecticut_CAMA_and_Parcel_Layer/FeatureServer/0/query";
const ELEV = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples";
const OUT = path.join(ROOT, "data", "elev");
const FT = 3.28084;
const BATCH = 500;
const FORCE = process.env.FORCE === "true";
const MAX_MS = (Number(process.env.MAX_MINUTES) || 300) * 60000;
const GIT = process.env.GIT_COMMIT === "true";
const T0 = Date.now();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function getJSON(url, opts = {}, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (j && j.error) throw new Error(j.error.message || "service error");
      return j;
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(2000 * 2 ** i);
    }
  }
}
async function pool(items, n, fn) {
  let i = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}
const where = (town) => encodeURIComponent(`Town_Name='${town.replace(/'/g, "''")}'`);

async function towns() {
  if (process.env.TOWNS) return process.env.TOWNS.split(",").map((s) => s.trim()).filter(Boolean);
  const j = await getJSON(PARCELS + "?where=1%3D1&outFields=Town_Name&returnDistinctValues=true&returnGeometry=false&orderByFields=Town_Name&f=json");
  return j.features.map((f) => f.attributes.Town_Name).filter(Boolean);
}

/* Same request shape as the app, so geometry (and therefore pointOn) is identical. */
async function parcelPoints(town) {
  const cnt = (await getJSON(`${PARCELS}?where=${where(town)}&returnCountOnly=true&f=json`)).count;
  const pages = [];
  for (let o = 0; o < cnt; o += 2000) pages.push(o);
  const keys = new Map();
  await pool(pages, 4, async (off) => {
    const j = await getJSON(`${PARCELS}?where=${where(town)}&outFields=OBJECTID&orderByFields=OBJECTID&resultOffset=${off}&resultRecordCount=2000&outSR=4326&geometryPrecision=6&f=geojson`);
    for (const f of j.features || []) {
      if (!f.geometry) continue;
      const pt = pointOn(f.geometry);
      if (pt) keys.set(ptKey(pt), pt);
    }
  });
  return { count: cnt, points: [...keys.values()] };
}

async function sample(points) {
  const z = new Array(points.length).fill(null);
  const starts = [];
  for (let i = 0; i < points.length; i += BATCH) starts.push(i);
  let failed = 0;
  await pool(starts, 4, async (s) => {
    const chunk = points.slice(s, s + BATCH).map((q) => [+q[0].toFixed(6), +q[1].toFixed(6)]);
    const body = "geometry=" + encodeURIComponent(JSON.stringify({ points: chunk, spatialReference: { wkid: 4326 } })) +
      "&geometryType=esriGeometryMultipoint&returnFirstValueOnly=true&interpolation=RSP_BilinearInterpolation&f=json";
    try {
      const j = await getJSON(ELEV, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      for (const smp of j.samples || []) {
        const v = parseFloat(smp.value);
        if (isFinite(v) && v > -50) z[s + smp.locationId] = Math.round(v * FT * 10); // tenths of a foot, NAVD88
      }
    } catch (e) { failed++; }
  });
  return { z, failed };
}

/* Delta-encode sorted integer coordinates to keep files small. */
function encode(points, z) {
  const rows = [];
  points.forEach((p, i) => { if (z[i] !== null) rows.push([Math.round(p[0] * 1e6), Math.round(p[1] * 1e6), z[i]]); });
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lon = [], lat = [], el = [];
  let px = 0, py = 0;
  for (const [x, y, v] of rows) { lon.push(x - px); lat.push(y - py); el.push(v); px = x; py = y; }
  return { n: rows.length, lon, lat, z: el };
}

function commit(msg) {
  if (!GIT) return;
  try {
    execSync("git add data/elev", { cwd: ROOT, stdio: "inherit" });
    execSync(`git diff --cached --quiet || git commit -q -m "${msg}"`, { cwd: ROOT, stdio: "inherit", shell: "/bin/bash" });
    execSync("git pull -q --rebase && git push -q", { cwd: ROOT, stdio: "inherit", shell: "/bin/bash" });
  } catch (e) { log("commit/push failed:", e.message); }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const idxPath = path.join(OUT, "index.json");
  const index = existsSync(idxPath) ? JSON.parse(await readFile(idxPath, "utf8")) : { source: "", towns: {} };
  index.source = "USGS 3DEP 1 m lidar (ImageServer getSamples, bilinear), feet NAVD88 x10, at the geo.js pointOn point of each parcel in the CT CAMA and Parcel Layer";
  const list = await towns();
  log(`${list.length} towns; force=${FORCE}`);
  let built = 0, sinceCommit = 0;
  for (const town of list) {
    if (Date.now() - T0 > MAX_MS) { log("time budget reached; stopping"); break; }
    const slug = townSlug(town);
    const file = path.join(OUT, slug + ".json");
    if (!FORCE && existsSync(file)) continue;
    try {
      const t = Date.now();
      const { count, points } = await parcelPoints(town);
      const { z, failed } = await sample(points);
      if (failed) log(`${town}: ${failed} elevation batch(es) failed; those points will be fetched live by the app`);
      const enc = encode(points, z);
      const built_on = new Date().toISOString().slice(0, 10);
      await writeFile(file, JSON.stringify({ town, slug, built: built_on, parcels: count, ...enc }));
      index.towns[slug] = { town, built: built_on, parcels: count, points: enc.n };
      await writeFile(idxPath, JSON.stringify(index, null, 1));
      built++; sinceCommit++;
      log(`${town}: ${enc.n}/${count} points in ${((Date.now() - t) / 1000).toFixed(0)} s`);
      if (sinceCommit >= 10) { commit(`Saved elevations: ${built} towns so far`); sinceCommit = 0; }
    } catch (e) {
      log(`${town}: FAILED (${e.message}); will retry on the next run`);
    }
  }
  if (sinceCommit) commit(`Saved elevations: ${built} towns`);
  log(`done: ${built} towns built in ${((Date.now() - T0) / 60000).toFixed(1)} min`);
}
main().catch((e) => { console.error(e); process.exit(1); });
