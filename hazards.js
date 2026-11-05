/* Coastal hazards for Flood Risk & Tax Base: datasets from the CT ECO Coastal Hazards Viewer.
 *
 * Loaded after a town's main analysis. For the town's parcel extent it fetches CT DEEP and CT ECO layers,
 * tags every parcel (hurricane surge category, evacuation zone, coastal boundary, erosion susceptibility,
 * nearest short-term shoreline change), checks the model against Storm Sandy (2012), and adds map overlays,
 * including DEEP's 2009 sea level rise inundation layers and CT ECO 2023 aerial imagery.
 * Uses globals from index.html, geo.js and model.js.
 */
"use strict";
const HZ_ORG = "https://services1.arcgis.com/FjPcSmEFuDYlIdKC/ArcGIS/rest/services";
const HZ_CE = "https://cteco.uconn.edu/ctmaps/rest/services/Coastal";
const HZ_SRC = {
  surge: { url: `${HZ_ORG}/CT_Hurricane_Surge_Inundation/FeatureServer/0`, out: "HURR_CAT", kind: "poly", off: 0.00003 },
  evac: { url: `${HZ_ORG}/Hurricane_Evacuation_Zones_2014/FeatureServer/0`, out: "Zone", kind: "poly", where: "Zone IN ('A','B')", off: 0.00003 },
  cbound: { url: `${HZ_ORG}/Coastal_Boundary/FeatureServer/0`, out: "OBJECTID", kind: "poly", off: 0.00003 },
  erosion: { url: `${HZ_ORG}/Erosion_Susceptibility_Set/FeatureServer/1`, out: "EROSION_CA", kind: "poly", off: 0.00003 },
  shore: { url: `${HZ_ORG}/Shoreline_Change_Short_Term/FeatureServer/5`, out: "EPR,NSM", kind: "point" },
  shoreUp: { url: `${HZ_ORG}/Shoreline_Change_Short_Term/FeatureServer/4`, out: "EPR,NSM", kind: "point" },
  hwm: { url: `${HZ_CE}/TS_Sandy_Water_Level/MapServer/1`, out: "Elevation_navd88,height_ground,Description,HWM_ID", kind: "point" },
  dmg: { url: `${HZ_CE}/TS_Sandy_Damage_Assessments/MapServer/9`, out: "DMG_COMBO,DEPTH_COMB,INUNDATED", kind: "point" },
};
const SURGE_COL = ["", "#f0997b", "#d85a30", "#993c1d", "#4a1b0c"];
const EROSION_DESC = { 1: "Highly erodible soil and coarse erodible surficial materials", 2: "Highly erodible soil and finer erodible surficial materials", 3: "Erodible surficial materials", 4: "Highly erodible soil" };
const DMG_ORDER = ["Affected", "Minor", "Major", "Destroyed"];
const DEEP_SLR_IN = [0, 6, 12, 18, 24, 36, 60, 79];  // layers 1-8 of the DEEP MHW and AMM services
const HZS = { state: "idle", town: null, data: {}, overlays: [], dyn: {}, summary: null };

/* ---------- fetching ---------- */
async function hzFetch(key, bb, onPage) {
  const s = HZ_SRC[key];
  const geo = `geometry=${bb.map((v) => v.toFixed(5)).join(",")}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects`;
  const where = encodeURIComponent(s.where || "1=1");
  const cnt = (await getJSON(`${s.url}/query?where=${where}&${geo}&returnCountOnly=true&f=json`, {}, 3)).count || 0;
  const pages = []; for (let o = 0; o < cnt; o += 1000) pages.push(o);
  const feats = [];
  await pool(pages, 4, async (off) => {
    const u = `${s.url}/query?where=${where}&${geo}&outFields=${s.out}&returnGeometry=true&outSR=4326&geometryPrecision=6${s.off ? `&maxAllowableOffset=${s.off}` : ""}&orderByFields=OBJECTID&resultOffset=${off}&resultRecordCount=1000&f=geojson`;
    const j = await getJSON(u, {}, 3);
    for (const f of j.features || []) if (f.geometry) feats.push(f);
    if (onPage) onPage();
  });
  return feats;
}
/* Polygons as compact Web Mercator arrays relative to the town origin, with a grid index for point tests. */
function hzPolys(feats, attr) {
  const items = feats.map((f) => Object.assign({ v: attr(f.properties || {}) }, compact(f.geometry, S.O)));
  const C = 250, grid = new Map(), big = [];
  items.forEach((it) => {
    const b = it.mb, i0 = Math.floor(b[0] / C), i1 = Math.floor(b[2] / C), j0 = Math.floor(b[1] / C), j1 = Math.floor(b[3] / C);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 400) { big.push(it); return; }
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = i + ":" + j; let l = grid.get(k); if (!l) { l = []; grid.set(k, l); } l.push(it); }
  });
  const test = (x, y) => {
    const out = [], cand = (grid.get(Math.floor(x / C) + ":" + Math.floor(y / C)) || []).concat(big);
    for (const it of cand) { const b = it.mb; if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue; if (inCompact(x, y, it)) out.push(it.v); }
    return out;
  };
  return { items, test };
}
const hzXY = (pt) => { const m = merc(pt[0], pt[1]); return [m[0] - S.O[0], m[1] - S.O[1]]; };
const hzPoints = (feats) => feats.map((f) => ({ pt: f.geometry.coordinates, xy: hzXY(f.geometry.coordinates), a: f.properties || {} }));

/* ---------- analysis ---------- */
function hzReset() {
  HZS.state = "idle"; HZS.town = null; HZS.data = {}; HZS.summary = null;
  if (S.map) for (const o of HZS.overlays) { S.ctrl.removeLayer(o.layer); o.layer.remove(); }
  HZS.overlays = [];
  for (const p of S.parcels || []) delete p.hz;
  hzCard();
}
async function hzStart() {
  hzReset();
  const town = S.townName; HZS.town = town; HZS.state = "loading";
  // coastal towns only: is any parcel inside the CGS 22a-94 coastal boundary?
  const bb = S.bb; let done = 0; const keys = Object.keys(HZ_SRC);
  hzCard(`Loading coastal hazard layers for ${town}…`);
  try {
    const res = await Promise.all(keys.map(async (k) => {
      try { const f = await hzFetch(k, bb, () => { done++; }); return [k, f]; }
      catch (e) { return [k, null]; }
    }));
    if (HZS.town !== town) return;
    const raw = Object.fromEntries(res);
    const failed = keys.filter((k) => raw[k] === null);
    const d = HZS.data;
    d.surge = hzPolys(raw.surge || [], (a) => +a.HURR_CAT || 0);
    d.evac = hzPolys(raw.evac || [], (a) => String(a.Zone || "").trim());
    d.cbound = hzPolys(raw.cbound || [], () => 1);
    d.erosion = hzPolys(raw.erosion || [], (a) => +a.EROSION_CA || 0);
    d.shore = hzPoints([...(raw.shore || []), ...(raw.shoreUp || [])]);
    d.hwm = hzPoints(raw.hwm || []);
    d.dmg = hzPoints(raw.dmg || []);
    d.failed = failed;
    hzTagParcels();
    HZS.state = "ready";
    hzOverlays();
    hzSummarize();
    if (S.results && typeof drawTable === "function") drawTable(S.results);
    if (failed.length) log(`Some coastal hazard layers did not load (${failed.join(", ")}); the rest are shown`, "e");
    else log("Coastal hazard layers loaded", "ok");
  } catch (e) {
    if (HZS.town !== town) return;
    HZS.state = "error"; hzCard("Coastal hazard layers could not be loaded right now. The rest of the analysis is unaffected.");
  }
}
/* Tag each parcel: tested at its buildings when it has them, else its interior point. */
function hzTagParcels() {
  const d = HZS.data;
  // shoreline change points on a grid for nearest search
  const C = 200, sg = new Map();
  for (const s of d.shore) { const k = Math.floor(s.xy[0] / C) + ":" + Math.floor(s.xy[1] / C); let l = sg.get(k); if (!l) { l = []; sg.set(k, l); } l.push(s); }
  for (const p of S.parcels) {
    const pts = p.bldgs && p.bldgs.length ? p.bldgs.map((b) => b.pt) : [p.pt];
    let surge = 0, evac = "", cb = false, ero = 0;
    for (const pt of pts) {
      const [x, y] = hzXY(pt);
      for (const c of d.surge.test(x, y)) if (c && (!surge || c < surge)) surge = c;
      for (const z of d.evac.test(x, y)) if (z === "A" || (z === "B" && evac !== "A")) evac = z;
      if (d.cbound.test(x, y).length) cb = true;
      for (const c of d.erosion.test(x, y)) if (c && (!ero || c < ero)) ero = c;
    }
    // nearest short-term shoreline change transect within 150 m of the parcel edge (bbox)
    let shore = null, best = 150;
    if (d.shore.length) {
      const b = p.mb, i0 = Math.floor((b[0] - 150) / C), i1 = Math.floor((b[2] + 150) / C), j0 = Math.floor((b[1] - 150) / C), j1 = Math.floor((b[3] + 150) / C);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (const s of sg.get(i + ":" + j) || []) {
        const dx = Math.max(b[0] - s.xy[0], 0, s.xy[0] - b[2]), dy = Math.max(b[1] - s.xy[1], 0, s.xy[1] - b[3]), dist = Math.hypot(dx, dy);
        if (dist < best && s.a.EPR != null) { best = dist; shore = { epr: +s.a.EPR, nsm: +s.a.NSM, dist: Math.round(dist) }; }
      }
    }
    p.hz = { surge, evac, cb, ero, shore };
  }
  // Sandy damage points onto parcels
  const C2 = 250, pg = new Map();
  for (const p of S.parcels) { const b = p.mb; for (let i = Math.floor(b[0] / C2); i <= Math.floor(b[2] / C2); i++) for (let j = Math.floor(b[1] / C2); j <= Math.floor(b[3] / C2); j++) { const k = i + ":" + j; let l = pg.get(k); if (!l) { l = []; pg.set(k, l); } l.push(p); } }
  for (const dm of d.dmg) {
    const [x, y] = dm.xy; let hit = null, best = Infinity;
    for (const p of pg.get(Math.floor(x / C2) + ":" + Math.floor(y / C2)) || []) { const q = p.mb; if (x < q[0] || x > q[2] || y < q[1] || y > q[3]) continue; const ar = (q[2] - q[0]) * (q[3] - q[1]); if (ar < best && inCompact(x, y, p)) { best = ar; hit = p; } }
    dm.parcel = hit;
  }
}

/* ---------- summary for the selected scenario/year ---------- */
function hzSummarize() {
  if (HZS.state !== "ready") { hzCard(); return; }
  const pr = P(), taxable = S.parcels.filter((p) => !(pr.exempt && p.exempt)), gl = taxable.reduce((s, p) => s + p.assessed, 0) || 1;
  const sum = (f) => { let n = 0, v = 0, b = 0; for (const p of taxable) if (f(p)) { n++; v += p.assessed; b += p.bldgs ? p.bldgs.length : 0; } return { n, v, b, pct: v / gl * 100 }; };
  const exposedNow = new Set(), exposedSel = new Set();
  for (const p of taxable) {
    if (p.elev == null) continue;
    const s0 = parcelState(p, S.scen, 2020, pr), s1 = parcelState(p, S.scen, S.year, pr);
    if (s0 && (s0.exposed || s0.tideShare > 0)) exposedNow.add(p);
    if (s1 && (s1.exposed || s1.tideShare > 0)) exposedSel.add(p);
  }
  const surge = [1, 2, 3, 4].map((c) => ({ c, ...sum((p) => p.hz && p.hz.surge && p.hz.surge <= c) }));
  const evac = ["A", "B"].map((z) => ({ z, ...sum((p) => p.hz && (z === "A" ? p.hz.evac === "A" : p.hz.evac === "A" || p.hz.evac === "B")) }));
  const cb = sum((p) => p.hz && p.hz.cb), cbExp = sum((p) => p.hz && p.hz.cb && exposedSel.has(p));
  const ero = [1, 2, 3, 4].map((c) => ({ c, ...sum((p) => p.hz && p.hz.ero === c) }));
  const eroding = sum((p) => p.hz && p.hz.shore && p.hz.shore.epr < -0.1);
  const maxEro = Math.min(0, ...taxable.filter((p) => p.hz && p.hz.shore).map((p) => p.hz.shore.epr));
  // Sandy check
  const dm = HZS.data.dmg.filter((x) => x.parcel && /Affected|Minor|Major|Destroyed/.test(x.a.DMG_COMBO || ""));
  const byLevel = DMG_ORDER.map((l) => ({ l, n: dm.filter((x) => x.a.DMG_COMBO === l).length, cap: dm.filter((x) => x.a.DMG_COMBO === l && exposedNow.has(x.parcel)).length }));
  const capNow = dm.filter((x) => exposedNow.has(x.parcel)).length, capSurge1 = dm.filter((x) => x.parcel.hz && x.parcel.hz.surge === 1).length;
  const hw = HZS.data.hwm.map((x) => +x.a.Elevation_navd88).filter((v) => isFinite(v) && v > 0).sort((a, b) => a - b);
  HZS.summary = { gl, surge, evac, cb, cbExp, ero, eroding, maxEro, sandy: { n: dm.length, byLevel, capNow, capSurge1, hwmN: hw.length, hwmMed: hw.length ? hw[Math.floor(hw.length / 2)] : null, hwmMax: hw.length ? hw[hw.length - 1] : null } };
  hzCard();
}

/* ---------- card ---------- */
function hzCard(msg) {
  const box = $("hzBody"); if (!box) return;
  if (msg) { box.innerHTML = `<div class="empty">${esc(msg)}</div>`; return; }
  if (HZS.state === "idle") { box.innerHTML = `<div class="empty">Analyze a town to see its hurricane surge, evacuation, coastal boundary, erosion and Storm Sandy information.</div>`; return; }
  if (HZS.state !== "ready" || !HZS.summary) return;
  const s = HZS.summary, pct = (v) => (v === 0 ? "0%" : v < 0.01 ? "<0.01%" : v < 0.1 ? v.toFixed(3) + "%" : v.toFixed(2) + "%");
  const row = (label, o, extra = "") => `<tr><td>${label}</td><td class="n">${num(o.n)}</td><td class="n">${num(o.b)}</td><td class="n">${money(o.v)}</td><td class="n">${pct(o.pct)}</td>${extra}</tr>`;
  const anySurge = s.surge[3].n > 0;
  const sd = s.sandy;
  box.innerHTML = `
  <div class="hzgrid">
    <div><h4>Hurricane surge <small>(CT DEEP SLOSH, 2012)</small></h4>
      ${anySurge ? `<table class="hzt"><thead><tr><th>Category</th><th class="n">Parcels</th><th class="n">Buildings</th><th class="n">Assessed</th><th class="n">Grand list</th></tr></thead><tbody>
      ${s.surge.map((r) => row(`<i class="sw" style="background:${SURGE_COL[r.c]}"></i>${r.c > 1 ? "Categories 1–" + r.c : "Category 1"}`, r)).join("")}</tbody></table>
      <p class="note">Parcels a hurricane of that category could inundate at peak surge arriving at mean high water, at today's sea level. Cumulative: a Category 3 storm also floods the Category 1–2 areas.</p>`
      : `<p class="note">No hurricane surge inundation is mapped in ${esc(HZS.town)}.</p>`}</div>
    <div><h4>Evacuation zones <small>(2014)</small></h4>
      ${s.evac[1].n ? `<table class="hzt"><thead><tr><th>Zone</th><th class="n">Parcels</th><th class="n">Buildings</th><th class="n">Assessed</th><th class="n">Grand list</th></tr></thead><tbody>
      ${row("Zone A", s.evac[0])}${row("Zones A and B", s.evac[1])}</tbody></table>` : `<p class="note">No hurricane evacuation zones in ${esc(HZS.town)}.</p>`}
      <h4>Coastal boundary <small>(CGS 22a-94)</small></h4>
      ${s.cb.n ? `<table class="hzt"><thead><tr><th></th><th class="n">Parcels</th><th class="n">Buildings</th><th class="n">Assessed</th><th class="n">Grand list</th></tr></thead><tbody>
      ${row("In the coastal boundary", s.cb)}${row(`…and exposed, ${SCEN_SHORT[S.scen]} ${S.year}`, s.cbExp)}</tbody></table>` : `<p class="note">${esc(HZS.town)} has no land in the coastal boundary.</p>`}
    </div>
    <div><h4>Erosion</h4>
      ${s.ero.some((r) => r.n) || s.eroding.n ? `<table class="hzt"><thead><tr><th></th><th class="n">Parcels</th><th class="n">Buildings</th><th class="n">Assessed</th><th class="n">Grand list</th></tr></thead><tbody>
      ${s.ero.filter((r) => r.n).map((r) => row(`Susceptibility category ${r.c}`, r)).join("")}
      ${row(`Within 150 m of eroding shoreline${s.maxEro < 0 ? ` (up to ${Math.abs(s.maxEro).toFixed(2)} m/yr)` : ""}`, s.eroding)}</tbody></table>
      <p class="note">Erosion susceptibility of terrace escarpments (DEEP, 2005). Shoreline change is the 1983–2006 end point rate (CT Sea Grant); rates over 0.1 m a year of retreat count as eroding.</p>` : `<p class="note">No mapped erosion susceptibility or shoreline change in ${esc(HZS.town)}.</p>`}</div>
    <div><h4>Storm Sandy check <small>(2012)</small></h4>
      ${sd.n ? `<p class="hzbig"><b>${num(sd.capNow)} of ${num(sd.n)}</b> buildings FEMA assessed as affected or damaged by Sandy sit on parcels this model shows exposed today (${Math.round(sd.capNow / sd.n * 100)}%).</p>
      <table class="hzt"><thead><tr><th>Sandy damage</th><th class="n">Buildings</th><th class="n">Exposed in model today</th></tr></thead><tbody>
      ${sd.byLevel.filter((r) => r.n).map((r) => `<tr><td>${r.l}</td><td class="n">${num(r.n)}</td><td class="n">${num(r.cap)}</td></tr>`).join("")}</tbody></table>` : `<p class="note">No FEMA Sandy damage assessments fall on ${esc(HZS.town)} parcels.</p>`}
      ${sd.hwmN ? `<p class="note">${sd.hwmN} USGS high-water marks: median ${sd.hwmMed.toFixed(1)} ft, highest ${sd.hwmMax.toFixed(1)} ft NAVD88${S.coastBFE != null ? `, compared with the ${S.coastBFE.toFixed(1)} ft coastal 1% still-water elevation the model uses` : ""}.</p>` : ""}</div>
  </div>
  <p class="note">Sources: CT DEEP via the CT ECO Coastal Hazards Viewer; FEMA and USGS Storm Sandy data via CT ECO. Toggle the map layers from the map's layer button.${HZS.data.failed && HZS.data.failed.length ? ` Not loaded: ${HZS.data.failed.join(", ")}.` : ""}</p>`;
}

/* ---------- map overlays ---------- */
/* ArcGIS dynamic map/image service drawn for the current view. */
const DynLayer = window.L ? L.Layer.extend({
  initialize(url, params, opts) { this._url = url; this._p = params; this._o = Object.assign({ opacity: 0.75 }, opts); },
  onAdd(map) { this._map = map; map.on("moveend", this._update, this); this._update(); },
  onRemove(map) { map.off("moveend", this._update, this); if (this._img) { this._img.remove(); this._img = null; } },
  setParams(p) { Object.assign(this._p, p); if (this._map) this._update(); },
  _update() {
    const map = this._map; if (!map) return;
    const b = map.getBounds(), sz = map.getSize(), crs = map.options.crs, sw = crs.project(b.getSouthWest()), ne = crs.project(b.getNorthEast());
    const q = new URLSearchParams(Object.assign({ bbox: [sw.x, sw.y, ne.x, ne.y].map((v) => v.toFixed(1)).join(","), bboxSR: 3857, imageSR: 3857, size: `${sz.x},${sz.y}`, format: "png32", transparent: true, f: "image" }, this._p));
    const url = `${this._url}/${this._url.endsWith("ImageServer") ? "exportImage" : "export"}?${q}`;
    if (!this._img) { this._img = L.imageOverlay(url, b, { opacity: this._o.opacity, interactive: false }).addTo(map); }
    else { this._img.setUrl(url); this._img.setBounds(b); }
  },
}) : null;
function hzPointLayer(points, style, tip) {
  const g = L.layerGroup();
  for (const p of points) { const m = L.circleMarker([p.pt[1], p.pt[0]], Object.assign({ radius: 5, weight: 1.5, color: "#fff", fillOpacity: 0.95 }, style(p))); if (tip) m.bindTooltip(tip(p), { direction: "top" }); g.addLayer(m); }
  return g;
}
function hzOverlays() {
  if (!S.map || !window.L) return;
  const d = HZS.data, add = (name, layer) => { HZS.overlays.push({ name, layer }); S.ctrl.addOverlay(layer, name); };
  if (d.surge.items.length) add("Hurricane surge, Cat 1–4", new CanvasLayer(d.surge.items, (it) => it.v ? { key: "s" + it.v, z: 5 - it.v, fill: SURGE_COL[it.v], fa: 0.45, stroke: null } : null));
  if (d.evac.items.length) add("Evacuation zones A/B", new CanvasLayer(d.evac.items, (it) => ({ key: "e" + it.v, z: it.v === "A" ? 2 : 1, fill: it.v === "A" ? "#c9302c" : "#e8833a", fa: 0.08, stroke: it.v === "A" ? "#c9302c" : "#e8833a", sa: 0.9, sw: 1.4, dash: [6, 4] })));
  if (d.cbound.items.length) add("Coastal boundary", new CanvasLayer(d.cbound.items, () => ({ key: "cb", z: 1, fill: null, stroke: "#2e7d32", sa: 1, sw: 2.2 })));
  if (d.erosion.items.length) add("Erosion susceptibility", new CanvasLayer(d.erosion.items, (it) => ({ key: "r" + it.v, z: 5 - it.v, fill: ["", "#8a4b0f", "#a8641f", "#c98a45", "#e0b27a"][it.v] || "#c98a45", fa: 0.45, stroke: null })));
  if (d.shore.length) add("Shoreline change 1983–2006", hzPointLayer(d.shore, (p) => ({ radius: 4, fillColor: +p.a.EPR < 0 ? "#b42318" : "#2e7d32" }), (p) => `${+p.a.EPR < 0 ? "Retreat" : "Advance"} ${Math.abs(+p.a.EPR).toFixed(2)} m/yr`));
  if (d.hwm.length) add("Sandy high-water marks", hzPointLayer(d.hwm, () => ({ radius: 6, fillColor: "#1f73ae" }), (p) => `Sandy high-water mark ${(+p.a.Elevation_navd88).toFixed(1)} ft NAVD88${p.a.Description ? "<br>" + esc(p.a.Description) : ""}`));
  if (d.dmg.length) add("Sandy damage assessments", hzPointLayer(d.dmg, (p) => ({ radius: 4.5, fillColor: { Affected: "#f2c14e", Minor: "#e8833a", Major: "#c9302c", Destroyed: "#4a1b0c" }[p.a.DMG_COMBO] || "#9aa3ab" }), (p) => `Sandy: ${esc(p.a.DMG_COMBO || "")}${p.a.DEPTH_COMB != null ? `, ${(+p.a.DEPTH_COMB).toFixed(1)} ft water` : ""}`));
  // DEEP 2009 sea level rise inundation, following the selected scenario and year
  HZS.dyn.mhw = new DynLayer(`${HZ_CE}/Sea_Level_Rise_Mean_High_Water/MapServer`, { layers: "show:" + hzDeepLayer() }, { opacity: 0.7 });
  HZS.dyn.amm = new DynLayer(`${HZ_CE}/Sea_Level_Rise_Average_Monthly_Maximum/MapServer`, { layers: "show:" + hzDeepLayer() }, { opacity: 0.7 });
  HZS.dyn.sandy = new DynLayer(`${HZ_CE}/TS_Sandy_Surge_Data/MapServer`, { layers: "show:0" }, { opacity: 0.7 });
  add("DEEP SLR: mean high water", HZS.dyn.mhw);
  add("DEEP SLR: monthly maximum", HZS.dyn.amm);
  add("Sandy surge depth", HZS.dyn.sandy);
  hzDeepLabel();
}
/* Nearest DEEP increment to sea level rise since 2005 for the selected scenario and year. */
function hzDeepLayer() { const inch = slrFt(S.scen, S.year) * 12; let best = 0; DEEP_SLR_IN.forEach((v, i) => { if (Math.abs(v - inch) < Math.abs(DEEP_SLR_IN[best] - inch)) best = i; }); return best + 1; }
function hzDeepLabel() {
  const li = hzDeepLayer(), lab = DEEP_SLR_IN[li - 1] ? `+${DEEP_SLR_IN[li - 1]} in` : "today";
  for (const o of HZS.overlays) if (o.layer === HZS.dyn.mhw || o.layer === HZS.dyn.amm) {
    const base = o.layer === HZS.dyn.mhw ? "DEEP SLR: mean high water" : "DEEP SLR: monthly maximum", name = `${base} (${lab})`;
    if (o.name !== name) { const on = S.map.hasLayer(o.layer); S.ctrl.removeLayer(o.layer); S.ctrl.addOverlay(o.layer, name); o.name = name; if (on) o.layer.addTo(S.map); }
  }
}
function hzOnScenario() {
  if (HZS.state !== "ready") return;
  const li = hzDeepLayer();
  if (HZS.dyn.mhw && HZS.dyn.mhw._p.layers !== "show:" + li) { HZS.dyn.mhw.setParams({ layers: "show:" + li }); HZS.dyn.amm.setParams({ layers: "show:" + li }); hzDeepLabel(); }
  hzSummarize();
}

/* ---------- per-parcel text for popup, ledger, CSV ---------- */
function hzPopupRows(p) {
  if (!p.hz) return HZS.state === "loading" ? `<tr><td>Coastal hazards</td><td>loading…</td></tr>` : "";
  const h = p.hz;
  return `<tr><td>Hurricane surge</td><td>${h.surge ? "Category " + h.surge : "none mapped"}</td></tr>
  ${h.evac ? `<tr><td>Evacuation zone</td><td>Zone ${h.evac}</td></tr>` : ""}
  <tr><td>Coastal boundary</td><td>${h.cb ? "inside" : "outside"}</td></tr>
  ${h.ero ? `<tr><td>Erosion susceptibility</td><td>Category ${h.ero}</td></tr>` : ""}
  ${h.shore ? `<tr><td>Shoreline change nearby</td><td>${h.shore.epr < 0 ? "retreat" : "advance"} ${Math.abs(h.shore.epr).toFixed(2)} m/yr</td></tr>` : ""}`;
}
const hzSurgeCell = (p) => (p.hz ? (p.hz.surge ? `<span class="pill surge${p.hz.surge}">Cat ${p.hz.surge}</span>` : "–") : "…");
const hzCSV = (p) => (p.hz ? [p.hz.surge || "", p.hz.evac || "", p.hz.cb ? "Y" : "N", p.hz.ero || "", p.hz.shore ? p.hz.shore.epr.toFixed(2) : ""] : ["", "", "", "", ""]);
const HZ_CSV_HEAD = ["Hurricane_Surge_Cat", "Evac_Zone", "In_Coastal_Boundary", "Erosion_Cat", "Shoreline_EPR_m_yr"];

/* ---------- report section ---------- */
function hzReportHTML() {
  if (HZS.state !== "ready" || !HZS.summary) return "";
  const s = HZS.summary, pct = (v) => (v === 0 ? "0%" : v < 0.01 ? "<0.01%" : v.toFixed(2) + "%");
  const tr = (l, o) => `<tr><td>${l}</td><td class="n">${num(o.n)}</td><td class="n">${num(o.b)}</td><td class="n">${money(o.v)}</td><td class="n">${pct(o.pct)}</td></tr>`;
  const head = `<thead><tr><th></th><th class="n">Parcels</th><th class="n">Buildings</th><th class="n">Assessed value</th><th class="n">Share of grand list</th></tr></thead>`;
  const sd = s.sandy;
  return `<h2 class="pb">Coastal hazards</h2>
  <p class="small">From the CT ECO Coastal Hazards Viewer: CT DEEP hurricane surge inundation (SLOSH, 2012) and evacuation zones (2014), the CGS 22a-94 coastal boundary, erosion susceptibility (2005), short-term shoreline change 1983–2006 (CT Sea Grant), and FEMA/USGS Storm Sandy (2012) data. Parcels are tested at their buildings, or at a point inside the parcel when no building is mapped. Taxable parcels only.</p>
  ${s.surge[3].n ? `<h3>Hurricane surge inundation, today's sea level</h3><table>${head}<tbody>${s.surge.map((r) => tr(r.c > 1 ? `Categories 1–${r.c}` : "Category 1", r)).join("")}</tbody></table>` : ""}
  ${s.evac[1].n || s.cb.n ? `<h3>Evacuation zones and coastal boundary</h3><table>${head}<tbody>${s.evac[1].n ? tr("Evacuation zone A", s.evac[0]) + tr("Evacuation zones A and B", s.evac[1]) : ""}${s.cb.n ? tr("In the coastal boundary", s.cb) + tr(`In the coastal boundary and exposed, ${esc(SCEN[S.scen])} ${S.year}`, s.cbExp) : ""}</tbody></table>` : ""}
  ${s.ero.some((r) => r.n) || s.eroding.n ? `<h3>Erosion</h3><table>${head}<tbody>${s.ero.filter((r) => r.n).map((r) => tr(`Susceptibility category ${r.c}: ${EROSION_DESC[r.c] || ""}`, r)).join("")}${tr("Within 150 m of shoreline retreating more than 0.1 m/yr (1983–2006)", s.eroding)}</tbody></table>` : ""}
  ${sd.n ? `<h3>Storm Sandy check</h3><p>${num(sd.capNow)} of ${num(sd.n)} buildings that FEMA assessed as affected or damaged by Sandy (${Math.round(sd.capNow / sd.n * 100)}%) are on parcels this model shows exposed to today's 1% flood or high tide.${sd.hwmN ? ` USGS high-water marks in the town reached a median of ${sd.hwmMed.toFixed(1)} ft and a maximum of ${sd.hwmMax.toFixed(1)} ft NAVD88.` : ""}</p>
  <table><thead><tr><th>Sandy damage level</th><th class="n">Buildings</th><th class="n">On parcels exposed in the model today</th></tr></thead><tbody>${sd.byLevel.filter((r) => r.n).map((r) => `<tr><td>${r.l}</td><td class="n">${num(r.n)}</td><td class="n">${num(r.cap)}</td></tr>`).join("")}</tbody></table>` : ""}`;
}
