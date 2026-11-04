#!/usr/bin/env node
/*
 * Regional comparison for Flood Risk & Tax Base.
 *
 * Runs the app's analysis (geo.js + model.js, same data sources and default assumptions) for every
 * town in a planning region and writes data/region/<region-slug>.json with, for each town, scenario
 * and decade, the assessed value at risk (tax at risk before applying a mill rate), the newly exposed
 * parcel count and the taxable grand list. The app multiplies by each town's mill rate.
 *
 * Environment: REGION (planning region as in the parcel layer's COG field, default "Southeastern CT").
 */
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const G = require(path.join(ROOT, "geo.js"));
const M = require(path.join(ROOT, "model.js"));
const { pointOn, bboxOf, inGeom, polysOf, compact, inCompact, merc, metersBetween, ptKey, townSlug } = G;

const REGION = process.env.REGION || "Southeastern CT";
const PARCELS = "https://services3.arcgis.com/3FL1kr7L4LvwA2Kb/ArcGIS/rest/services/Connecticut_CAMA_and_Parcel_Layer/FeatureServer/0/query";
const FEMA = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query";
const ELEV = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples";
const BLDG = "https://services3.arcgis.com/3FL1kr7L4LvwA2Kb/arcgis/rest/services/2D_Building_Footprints/FeatureServer/0/query";
const SLRAPI = "https://api.tidesandcurrents.noaa.gov/dpapi/prod/webapi/product/slr_projections.json?station=";
const FIELDS = "OBJECTID,Parcel_ID,Location,Town_Name,Assessed_Total,Assessed_Land,Assessed_Building,Appraised_Building,Appraised_Outbuilding,State_Use,State_Use_Description";
const FT = 3.28084, BUFFER = 1500;
const YEARS = [2020, 2030, 2040, 2050, 2060, 2070, 2080, 2090, 2100];
// App defaults; mill 1000 makes "tax" equal to assessed value at risk.
const PR = { mill: 1000, ratio: 0.7, disc: 0.07, ffh: 1, aep: 0.01, cbfe: null, mhhw: null, up: 1, adepth: 2, x02: 1, npv: 0.03, exempt: true };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function getJSON(url, opts = {}, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json(); if (j && j.error) throw new Error(j.error.message || "service error"); return j;
    } catch (e) { if (i >= tries - 1) throw e; await sleep(2000 * 2 ** i); }
  }
}
async function pool(items, n, fn) {
  let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
async function readJSON(p) { try { return existsSync(p) ? JSON.parse(await readFile(p, "utf8")) : null; } catch (e) { return null; } }
const titleCase = (s) => String(s || "").toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());

async function regionTowns() {
  const j = await getJSON(`${PARCELS}?where=${encodeURIComponent(`COG='${REGION}'`)}&outFields=Town_Name&returnDistinctValues=true&returnGeometry=false&f=json`);
  return j.features.map((f) => f.attributes.Town_Name).filter(Boolean).sort();
}
async function loadFema(bb) {
  const out = new Map(); const where = encodeURIComponent("SFHA_TF='T' OR ZONE_SUBTY LIKE '%0.2 PCT%'");
  const tiles = []; for (let x = bb[0]; x < bb[2]; x += 0.04) for (let y = bb[1]; y < bb[3]; y += 0.04) tiles.push([x, y, Math.min(x + 0.04, bb[2]), Math.min(y + 0.04, bb[3])]);
  async function q(t, depth) {
    const url = `${FEMA}?where=${where}&geometry=${t.map((v) => v.toFixed(5)).join(",")}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=OBJECTID,FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DEPTH&returnGeometry=true&outSR=4326&geometryPrecision=6&maxAllowableOffset=0.00002&f=geojson`;
    const j = await getJSON(url);
    if ((j.exceededTransferLimit || (j.properties && j.properties.exceededTransferLimit)) && depth < 4) {
      const mx = (t[0] + t[2]) / 2, my = (t[1] + t[3]) / 2;
      for (const s of [[t[0], t[1], mx, my], [mx, t[1], t[2], my], [t[0], my, mx, t[3]], [mx, my, t[2], t[3]]]) await q(s, depth + 1);
    }
    for (const f of j.features || []) {
      const p = f.properties || {}; const id = p.OBJECTID ?? f.id; if (!f.geometry || out.has(id)) continue;
      const zn = String(p.FLD_ZONE || ""); const kind = /^V/.test(zn) ? "V" : (p.SFHA_TF === "T" ? "A" : "X02");
      out.set(id, { id, g: f.geometry, bbox: bboxOf(f.geometry), zone: zn, kind, bfe: (p.STATIC_BFE > -9000 ? +p.STATIC_BFE : null), depth: (p.DEPTH > -9000 ? +p.DEPTH : null) });
    }
  }
  await pool(tiles, 3, (t) => q(t, 0));
  const zs = [...out.values()], vs = zs.filter((z) => z.kind === "V");
  for (const z of zs) if (z.kind === "A") z.nearV = vs.some((v) => !(z.bbox[2] < v.bbox[0] - 0.003 || z.bbox[0] > v.bbox[2] + 0.003 || z.bbox[3] < v.bbox[1] - 0.003 || z.bbox[1] > v.bbox[3] + 0.003));
  return zs;
}
async function loadSLR(st) {
  const fb = M.SLR_FALLBACK[st];
  try {
    const j = await getJSON(SLRAPI + st, {}, 2); const s = {};
    for (const x of j.SlrProjections || []) { const i = M.SLR_YEARS.indexOf(x.projectionYear); if (i < 0) continue; (s[x.scenario] = s[x.scenario] || new Array(M.SLR_YEARS.length).fill(null))[i] = x.projectionRsl; }
    if (M.SCEN.every((k) => s[k] && s[k].every((v) => v !== null))) return { s, live: true };
  } catch (e) {}
  return { s: fb.s, live: false };
}
async function sampleLive(points) {
  const z = new Array(points.length).fill(null); const starts = []; for (let i = 0; i < points.length; i += 500) starts.push(i);
  await pool(starts, 5, async (s) => {
    const body = "geometry=" + encodeURIComponent(JSON.stringify({ points: points.slice(s, s + 500).map((q) => [+q[0].toFixed(6), +q[1].toFixed(6)]), spatialReference: { wkid: 4326 } })) + "&geometryType=esriGeometryMultipoint&returnFirstValueOnly=true&interpolation=RSP_BilinearInterpolation&f=json";
    try { const j = await getJSON(ELEV, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }); for (const smp of j.samples || []) { const v = parseFloat(smp.value); if (isFinite(v) && v > -50) z[s + smp.locationId] = v * FT; } } catch (e) {}
  });
  return z;
}

async function analyzeTown(town) {
  const where = encodeURIComponent(`Town_Name='${town.replace(/'/g, "''")}'`);
  const cnt = (await getJSON(`${PARCELS}?where=${where}&returnCountOnly=true&f=json`)).count;
  const pages = []; for (let o = 0; o < cnt; o += 2000) pages.push(o);
  const chunks = await pool(pages, 4, async (off) => (await getJSON(`${PARCELS}?where=${where}&outFields=${FIELDS}&orderByFields=OBJECTID&resultOffset=${off}&resultRecordCount=2000&outSR=4326&geometryPrecision=6&f=geojson`)).features || []);
  const parcels = []; let O = null;
  for (const f of chunks.flat()) {
    if (!f.geometry) continue; const g = f.geometry, pt = pointOn(g); if (!pt) continue; const a = f.properties;
    if (!O) O = merc(pt[0], pt[1]);
    const assessed = +a.Assessed_Total || 0, aLand = +a.Assessed_Land || 0, aBldg = a.Assessed_Building != null ? +a.Assessed_Building : Math.max(0, assessed - aLand);
    const bldgAppr = (+a.Appraised_Building || 0) + (+a.Appraised_Outbuilding || 0) || aBldg / 0.7, use = String(a.State_Use || "");
    const p = { pt, bbox: bboxOf(g), a, assessed, aLand: Math.min(aLand, assessed), aBldg: Math.max(0, assessed - Math.min(aLand, assessed)), bldgAppr, use,
      useDesc: titleCase((a.State_Use_Description || "").replace(/\s+MDL-\d+$/, "").trim()) || "Unknown", exempt: /^9/.test(use) || assessed <= 0, zone: null, elev: null, elevs: null, coastal: false };
    Object.assign(p, compact(g, O)); parcels.push(p);
  }
  let bb = [180, 90, -180, -90]; for (const p of parcels) bb = [Math.min(bb[0], p.bbox[0]), Math.min(bb[1], p.bbox[1]), Math.max(bb[2], p.bbox[2]), Math.max(bb[3], p.bbox[3])];
  const zones = await loadFema(bb); const coastal = zones.some((z) => z.kind === "V");
  // zone assignment
  const C = 0.01, key = (i, j) => i + ":" + j, grid = new Map(), rank = { V: 4, A: 3, X02: 1 };
  zones.forEach((z, zi) => { for (let i = Math.floor(z.bbox[0] / C); i <= Math.floor(z.bbox[2] / C); i++) for (let j = Math.floor(z.bbox[1] / C); j <= Math.floor(z.bbox[3] / C); j++) { const k = key(i, j); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(zi); } });
  for (const p of parcels) { const c = grid.get(key(Math.floor(p.pt[0] / C), Math.floor(p.pt[1] / C))); if (!c) continue; let best = null;
    for (const zi of c) { const z = zones[zi]; if (p.pt[0] < z.bbox[0] || p.pt[0] > z.bbox[2] || p.pt[1] < z.bbox[1] || p.pt[1] > z.bbox[3]) continue;
      if (inGeom(p.pt[0], p.pt[1], z.g) && (!best || rank[z.kind] > rank[best.kind] || (rank[z.kind] === rank[best.kind] && (z.bfe || 0) > (best.bfe || 0)))) best = z; }
    p.zone = best; }
  let coastBFE = null;
  if (coastal) {
    const vg = new Map(); for (const z of zones) { if (z.kind !== "V") continue; for (const poly of polysOf(z.g)) for (const r of poly) for (let k = 0; k < r.length; k += 2) { const v = r[k]; const kk = key(Math.floor(v[0] / C), Math.floor(v[1] / C)); if (!vg.has(kk)) vg.set(kk, []); vg.get(kk).push(v); } }
    const Rr = Math.ceil(BUFFER / 800);
    for (const p of parcels) { const ci = Math.floor(p.pt[0] / C), cj = Math.floor(p.pt[1] / C); let hit = false;
      for (let i = ci - Rr; i <= ci + Rr && !hit; i++) for (let j = cj - Rr; j <= cj + Rr && !hit; j++) { const vs = vg.get(key(i, j)); if (!vs) continue; for (const v of vs) if (metersBetween(p.pt, v) <= BUFFER) { hit = true; break; } }
      p.coastal = hit; }
    const cAE = zones.filter((z) => z.kind === "A" && z.bfe && z.bfe >= 7 && z.bfe <= 18 && z.nearV).map((z) => z.bfe).sort((a, b) => a - b);
    const vBFE = zones.filter((z) => z.kind === "V" && z.bfe).map((z) => z.bfe).sort((a, b) => a - b);
    coastBFE = cAE.length ? cAE[Math.floor(cAE.length / 2)] : (vBFE.length ? vBFE[Math.floor(vBFE.length / 2)] - 2 : 11);
    for (const p of parcels) if (p.zone && p.zone.kind === "A" && p.coastal && p.zone.bfe && p.zone.bfe >= 7 && p.zone.bfe <= 18 && p.zone.nearV) { const z = p.zone; p.zone = { zone: z.zone, kind: z.kind, bfe: z.bfe, depth: z.depth, nearV: z.nearV, coastalAE: true }; }
  }
  const cx = (bb[0] + bb[2]) / 2, st = Math.abs(cx - M.SLR_FALLBACK["8467150"].lon) < Math.abs(cx - M.SLR_FALLBACK["8461490"].lon) ? "8467150" : "8461490";
  const slr = await loadSLR(st); const a = M.SLR_FALLBACK["8467150"], b = M.SLR_FALLBACK["8461490"];
  const mhhw = Math.max(1.1, Math.min(3.9, b.mhhw + (a.mhhw - b.mhhw) * (cx - b.lon) / (a.lon - b.lon)));
  // elevations: saved files first, then USGS for anything missing
  const need = parcels.filter((p) => p.zone || p.coastal), slug = townSlug(town);
  const savedP = await readJSON(path.join(ROOT, "data", "elev", slug + ".json")), savedB = await readJSON(path.join(ROOT, "data", "bldg", slug + ".json"));
  const pmap = new Map(); if (savedP) { let x = 0, y = 0; for (let i = 0; i < savedP.n; i++) { x += savedP.lon[i]; y += savedP.lat[i]; pmap.set(x + "," + y, savedP.z[i] / 10); } }
  let bs = [];
  if (savedB) { let x = 0, y = 0; for (let i = 0; i < savedB.n; i++) { x += savedB.lon[i]; y += savedB.lat[i]; bs.push({ pt: [x / 1e6, y / 1e6], a: savedB.a[i], e: savedB.z[i] == null ? null : savedB.z[i] / 10 }); } }
  else {
    const env = `geometry=${bb.map((v) => v.toFixed(5)).join(",")}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects`;
    const bc = (await getJSON(`${BLDG}?where=1%3D1&${env}&returnCountOnly=true&f=json`)).count; const bp = []; for (let o = 0; o < bc; o += 2000) bp.push(o);
    await pool(bp, 4, async (off) => { const j = await getJSON(`${BLDG}?where=1%3D1&${env}&outFields=OBJECTID,Shape__Area&orderByFields=OBJECTID&resultOffset=${off}&resultRecordCount=2000&outSR=4326&geometryPrecision=6&f=geojson`);
      for (const f of j.features || []) { if (!f.geometry) continue; const pt = pointOn(f.geometry); if (!pt) continue; const c = Math.cos(pt[1] * Math.PI / 180); bs.push({ pt, a: Math.max(1, Math.round((+(f.properties || {}).Shape__Area || 0) * c * c)), e: null }); } });
  }
  // buildings onto parcels being modeled
  const CB = 250, bgrid = new Map(), bkey = (i, j) => i + ":" + j;
  for (const p of need) { const q = p.mb; for (let i = Math.floor(q[0] / CB); i <= Math.floor(q[2] / CB); i++) for (let j = Math.floor(q[1] / CB); j <= Math.floor(q[3] / CB); j++) { const k = bkey(i, j); let l = bgrid.get(k); if (!l) { l = []; bgrid.set(k, l); } l.push(p); } }
  for (const bd of bs) { const m = merc(bd.pt[0], bd.pt[1]), x = m[0] - O[0], y = m[1] - O[1]; const cand = bgrid.get(bkey(Math.floor(x / CB), Math.floor(y / CB))); if (!cand) continue;
    let hit = null, best = Infinity; for (const p of cand) { const q = p.mb; if (x < q[0] || x > q[2] || y < q[1] || y > q[3]) continue; const ar = (q[2] - q[0]) * (q[3] - q[1]); if (ar < best && inCompact(x, y, p)) { best = ar; hit = p; } }
    if (hit) (hit.bldgs || (hit.bldgs = [])).push(bd); }
  for (const p of need) if (p.bldgs) { const t = p.bldgs.reduce((s, x) => s + x.a, 0) || 1; for (const x of p.bldgs) x.w = x.a / t; }
  const pts = [], refs = [];
  for (const p of need) { const v = pmap.get(ptKey(p.pt)); if (v !== undefined) p.elev = v; else { refs.push([p, "p"]); pts.push(p.pt); }
    if (p.bldgs) for (const x of p.bldgs) if (x.e == null) { refs.push([x, "b"]); pts.push(x.pt); } }
  const live = pts.length ? await sampleLive(pts) : [];
  refs.forEach(([o, k], i) => { if (k === "p") o.elev = live[i]; else o.e = live[i]; });
  for (const p of need) if (p.elev != null) { const be = p.bldgs ? p.bldgs.map((x) => x.e).filter((v) => v != null) : []; p.gnd = be.length ? Math.min(...be) : p.elev; }
  // model runs, same as the app
  globalThis.S = { slr: slr.s, coastal, parcels };
  const pr = { ...PR, cbfe: coastBFE, mhhw };
  const scen = {};
  M.SCEN.forEach((name, si) => {
    const at = [], exposed = [];
    for (const y of YEARS) { const r = M.evalAll(si, y, pr, false); at.push(Math.round(r.tot)); exposed.push(r.n); }
    scen[name] = { assessedAtRisk: at, newlyExposed: exposed };
  });
  const base = M.evalAll(2, 2020, pr, false).base;
  let grandList = 0; for (const p of parcels) if (!p.exempt) grandList += p.assessed;
  return { town, slug, parcels: parcels.length, modeled: need.length, buildings: need.reduce((s, p) => s + (p.bldgs ? p.bldgs.length : 0), 0), coastal,
    grandList: Math.round(grandList), assessedAtRiskToday: Math.round(base), gauge: M.SLR_FALLBACK[st].name, liveSLR: slr.live,
    savedElevations: !!savedP, savedBuildings: !!savedB, livePoints: pts.length, scen };
}

async function main() {
  const out = path.join(ROOT, "data", "region"); await mkdir(out, { recursive: true });
  const file = path.join(out, townSlug(REGION) + ".json");
  const prev = (await readJSON(file)) || { towns: [] };
  const towns = await regionTowns();
  log(`${REGION}: ${towns.length} towns`);
  const results = [];
  for (const town of towns) {
    const t = Date.now();
    try { const r = await analyzeTown(town); results.push(r); log(`${town}: ${r.parcels} parcels, ${r.modeled} modeled, ${r.livePoints} live points, ${((Date.now() - t) / 1000).toFixed(0)} s`); }
    catch (e) { log(`${town}: FAILED (${e.message}); keeping previous result`); const old = prev.towns.find((x) => x.town === town); if (old) results.push(old); }
  }
  const doc = { region: REGION, built: new Date().toISOString().slice(0, 10), years: YEARS, scenarios: M.SCEN,
    assumptions: { ...PR, mill: "per town", cbfe: "auto", mhhw: "auto" },
    note: "assessedAtRisk = added assessed value at risk vs 2020 (land lost to high tide + market discount on newly exposed parcels + annualized post-flood reassessment). Multiply by the mill rate / 1000 for tax.",
    towns: results };
  await writeFile(file, JSON.stringify(doc));
  log(`wrote ${path.relative(ROOT, file)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
