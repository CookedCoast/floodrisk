/* Flood extent and depth for Flood Risk & Tax Base.
 *
 * The USGS 3DEP image service returns elevation for the map view encoded in the red channel
 * of a PNG (Remap into 254 bins + Colormap value -> (v,0,0)). FEMA zones and the coastal reach
 * are rasterized onto the same grid in the browser. Each scenario/year is then classified locally,
 * so changing the year or playing the animation needs no further downloads.
 * Uses globals from index.html: S, P, $, slrFt, RIVER_MULT, SCEN, SCEN_SHORT, money, num, log, PI_R, polysOf.
 */
"use strict";
const DEM_SVC = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage";
const FT_M = 3.28084, ACRE_M2 = 4046.856;
const FLOOD_RGBA = { chronic: [32, 50, 110, 190], d3: [201, 48, 44, 175], d1: [232, 131, 58, 165], d0: [242, 193, 78, 160] };
const F = { view: null, town: null, overlay: null, req: 0, timer: null, playing: null, acresKey: null, acres: null };

/* ---------- elevation grid ---------- */
function demRule(loM, stepM) {
  const ir = [-10000, loM + stepM], ov = [1], cm = [[1, 1, 0, 0]];
  for (let i = 1; i < 254; i++) { ir.push(loM + i * stepM, loM + (i + 1) * stepM); ov.push(i + 1); cm.push([i + 1, i + 1, 0, 0]); }
  return { rasterFunction: "Colormap", outputPixelType: "U8",
    rasterFunctionArguments: { Colormap: cm, Raster: { rasterFunction: "Remap", outputPixelType: "U8",
      rasterFunctionArguments: { InputRanges: ir, OutputValues: ov, AllowUnmatched: false } } } };
}
/* Elevation range (ft) that matters for the zones in an extent, across all scenarios and years. */
function wlRange(ext, pr) {
  let lo = Infinity, hi = -Infinity;
  const maxSLR = slrFt(4, 2100), up = pr.up * RIVER_MULT[4];
  if (S.coastal) { lo = Math.min(lo, pr.mhhw - 4); hi = Math.max(hi, pr.mhhw + maxSLR, (pr.cbfe || 0) + maxSLR); }
  for (const z of S.zones) {
    const b = z.mb;
    if (b[2] + S.O[0] < ext[0] || b[0] + S.O[0] > ext[2] || b[3] + S.O[1] < ext[1] || b[1] + S.O[1] > ext[3]) continue;
    if (z.bfe != null) { lo = Math.min(lo, z.bfe - 4); hi = Math.max(hi, z.bfe + (z.kind === "V" || z.coastalAE ? maxSLR : up)); }
  }
  if (!isFinite(lo)) return null;
  return [lo, hi + 0.5];
}
async function fetchDEM(ext, w, h, pr) {
  const rg = wlRange(ext, pr);
  if (!rg) return null;
  const loM = rg[0] / FT_M, stepM = Math.max(0.02, (rg[1] - rg[0]) / FT_M / 253);
  const body = new URLSearchParams({
    bbox: ext.map((v) => v.toFixed(2)).join(","), bboxSR: "3857", imageSR: "3857", size: `${w},${h}`,
    format: "png32", transparent: "true", interpolation: "RSP_BilinearInterpolation",
    renderingRule: JSON.stringify(demRule(loM, stepM)), f: "json" });
  const meta = await getJSON(DEM_SVC, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }, 2);
  if (!meta.href) throw new Error("no image");
  const blob = await (await fetch(meta.href)).blob();
  const bm = await createImageBitmap(blob);
  const c = document.createElement("canvas"); c.width = bm.width; c.height = bm.height;
  const ctx = c.getContext("2d"); ctx.drawImage(bm, 0, 0);
  const px = ctx.getImageData(0, 0, c.width, c.height).data;
  const n = c.width * c.height, v = new Uint8Array(n);
  for (let i = 0; i < n; i++) v[i] = px[4 * i + 3] > 128 ? px[4 * i] : 0;
  const me = meta.extent || { xmin: ext[0], ymin: ext[1], xmax: ext[2], ymax: ext[3] };
  const grid = { w: c.width, h: c.height, ext: [me.xmin, me.ymin, me.xmax, me.ymax], v, loFt: loM * FT_M, stepFt: stepM * FT_M };
  rasterizeZones(grid, pr);
  return grid;
}
/* FEMA zone index and coastal-reach mask on the DEM grid. */
function rasterizeZones(g, pr) {
  const res = (g.ext[2] - g.ext[0]) / g.w;
  const X = (dx) => (S.O[0] + dx - g.ext[0]) / res, Y = (dy) => (g.ext[3] - (S.O[1] + dy)) / res;
  const trace = (ctx, z) => { const xy = z.xy, rg = z.rg; let s0 = 0;
    for (let r = 0; r < rg.length; r++) { const e = rg[r]; ctx.moveTo(X(xy[2 * s0]), Y(xy[2 * s0 + 1]));
      for (let i = s0 + 1; i < e; i++) ctx.lineTo(X(xy[2 * i]), Y(xy[2 * i + 1])); ctx.closePath(); s0 = e; } };
  const inView = (z) => { const b = z.mb; return !(b[2] + S.O[0] < g.ext[0] || b[0] + S.O[0] > g.ext[2] || b[3] + S.O[1] < g.ext[1] || b[1] + S.O[1] > g.ext[3]); };
  const c = document.createElement("canvas"); c.width = g.w; c.height = g.h;
  const ctx = c.getContext("2d");
  const order = S.zones.map((z, i) => [z, i]).filter(([z]) => inView(z)).sort((a, b) => ({ X02: 0, A: 1, V: 2 })[a[0].kind] - ({ X02: 0, A: 1, V: 2 })[b[0].kind]);
  for (const [z, i] of order) { const id = i + 1; ctx.fillStyle = `rgb(${id & 255},${id >> 8},255)`; ctx.beginPath(); trace(ctx, z); ctx.fill(); }
  const d = ctx.getImageData(0, 0, g.w, g.h).data, n = g.w * g.h;
  g.zone = new Uint16Array(n);
  for (let i = 0; i < n; i++) if (d[4 * i + 3] > 200 && d[4 * i + 2] > 250) { const id = d[4 * i] + (d[4 * i + 1] << 8); if (id <= S.zones.length) g.zone[i] = id; }
  g.reach = null;
  if (S.coastal) {
    const m = document.createElement("canvas"); m.width = g.w; m.height = g.h;
    const mc = m.getContext("2d"); mc.fillStyle = mc.strokeStyle = "#000"; mc.lineJoin = mc.lineCap = "round";
    mc.lineWidth = Math.max(1, 2 * (+$("p_buf").value || 1500) / res);
    mc.beginPath(); for (const z of S.zones) if (z.kind === "V" && inView(z)) trace(mc, z); mc.fill(); mc.stroke();
    const md = mc.getImageData(0, 0, g.w, g.h).data; g.reach = new Uint8Array(n);
    for (let i = 0; i < n; i++) g.reach[i] = md[4 * i + 3] > 0 ? 1 : 0;
    for (let i = 0; i < n; i++) { const z = g.zone[i] && S.zones[g.zone[i] - 1]; if (z && (z.kind === "V" || z.coastalAE)) g.reach[i] = 1; }
  }
}
/* Classify every pixel for one scenario/year. Returns class codes: 0 none, 1 below high tide, 2 <1 ft, 3 1-3 ft, 4 >3 ft. */
function classify(g, scen, year, pr, out) {
  const slrAbs = slrFt(scen, year), slr0 = slrFt(scen, 2020), dSLR = Math.max(0, slrAbs - slr0);
  const uplift = pr.up * RIVER_MULT[scen] * Math.max(0, Math.min(1, (year - 2020) / 80));
  const wl = pr.mhhw + slrAbs, wl0 = pr.mhhw + slr0;
  const nz = S.zones.length + 1, zC = new Uint8Array(nz), zWL = new Float32Array(nz).fill(NaN), zD = new Float32Array(nz).fill(NaN);
  S.zones.forEach((z, i) => {
    const id = i + 1;
    if (z.kind === "V" || z.coastalAE) { zC[id] = 1; zWL[id] = (z.bfe != null ? z.bfe : (pr.cbfe || 0)) + dSLR; }
    else if (z.kind === "A") { if (z.bfe != null) zWL[id] = z.bfe + uplift; else zD[id] = (z.depth != null && /AO/.test(z.zone) ? z.depth : pr.adepth) + uplift; }
    else zD[id] = uplift - pr.x02;
  });
  const cw = (pr.cbfe || 0) + dSLR, n = g.w * g.h, lo = g.loFt, st = g.stepFt, v = g.v, zn = g.zone, rc = g.reach;
  for (let i = 0; i < n; i++) {
    out[i] = 0;
    if (!v[i]) continue;
    const e = lo + (v[i] - 0.5) * st, id = zn[i];
    const coastal = rc && (rc[i] || zC[id]);
    if (coastal) { if (e < wl0) continue; if (e < wl) { out[i] = 1; continue; } }
    let d = -99;
    if (coastal) d = (zC[id] ? zWL[id] : cw) - e;
    if (id && !zC[id]) { const r = isNaN(zWL[id]) ? zD[id] : zWL[id] - e; if (r > d) d = r; }
    out[i] = d > 3 ? 4 : d > 1 ? 3 : d > 0 ? 2 : 0;
  }
  return out;
}
function paint(g, cls) {
  const c = document.createElement("canvas"); c.width = g.w; c.height = g.h;
  const ctx = c.getContext("2d"), img = ctx.createImageData(g.w, g.h), d = img.data;
  const pal = [null, FLOOD_RGBA.chronic, FLOOD_RGBA.d0, FLOOD_RGBA.d1, FLOOD_RGBA.d3];
  for (let i = 0; i < cls.length; i++) { const p = pal[cls[i]]; if (p) { d[4 * i] = p[0]; d[4 * i + 1] = p[1]; d[4 * i + 2] = p[2]; d[4 * i + 3] = p[3]; } }
  ctx.putImageData(img, 0, 0);
  return c;
}
const toLatLng = (x, y) => [(2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * 180 / Math.PI, x / 6378137 * 180 / Math.PI];

/* ---------- map layer ---------- */
function floodReset() {
  if (F.overlay && S.map) { S.ctrl && S.ctrl.removeLayer(F.overlay); F.overlay.remove(); }
  F.overlay = null; F.view = null; F.town = null; F.acres = null; F.acresKey = null; stopPlay();
  if (S.map && !F.wired) { S.map.on("moveend", () => { clearTimeout(F.timer); F.timer = setTimeout(floodFetchView, 350); }); F.wired = true; }
}
async function floodFetchView() {
  if (!S.map || !S.parcels.length || !S.slr) return;
  if (F.overlay && !S.map.hasLayer(F.overlay) && F.view) return;
  const b = S.map.getBounds(), sz = S.map.getSize();
  const sw = S.map.options.crs.project(b.getSouthWest()), ne = S.map.options.crs.project(b.getNorthEast());
  const scale = Math.min(1, 1600 / Math.max(sz.x, sz.y));
  const w = Math.max(64, Math.round(sz.x * scale)), h = Math.max(64, Math.round(sz.y * scale));
  const id = ++F.req;
  floodNote("Loading flood depth for this view…");
  try {
    const g = await fetchDEM([sw.x, sw.y, ne.x, ne.y], w, h, P());
    if (id !== F.req) return;
    F.view = g; floodRender(); floodNote("");
  } catch (e) { if (id === F.req) floodNote("Flood depth shading is unavailable right now; parcel results are unaffected."); }
}
function floodRender() {
  const g = F.view; if (!g || !S.map) return;
  const cls = classify(g, S.scen, S.year, P(), new Uint8Array(g.w * g.h));
  const url = paint(g, cls).toDataURL("image/png");
  const bounds = [toLatLng(g.ext[0], g.ext[1]), toLatLng(g.ext[2], g.ext[3])];
  if (!F.overlay) {
    F.overlay = L.imageOverlay(url, bounds, { opacity: 1, interactive: false, className: "flood-overlay" }).addTo(S.map);
    S.ctrl.addOverlay(F.overlay, "Flood extent and depth");
    F.overlay.bringToBack(); if (S.zoneLayer) S.zoneLayer.redraw();
  } else { F.overlay.setUrl(url); F.overlay.setBounds(L.latLngBounds(bounds)); }
}
function floodNote(t) { const el = $("floodnote"); if (el) { el.textContent = t; el.hidden = !t; } }

/* ---------- area over time (parcel land in the town) ---------- */
async function floodTownGrid() {
  const pr = P();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of S.parcels) { const b = p.mb; if (b[0] < x0) x0 = b[0]; if (b[1] < y0) y0 = b[1]; if (b[2] > x1) x1 = b[2]; if (b[3] > y1) y1 = b[3]; }
  const ext = [x0 + S.O[0], y0 + S.O[1], x1 + S.O[0], y1 + S.O[1]];
  const k = 1600 / Math.max(ext[2] - ext[0], ext[3] - ext[1]);
  const w = Math.max(64, Math.round((ext[2] - ext[0]) * k)), h = Math.max(64, Math.round((ext[3] - ext[1]) * k));
  const g = await fetchDEM(ext, w, h, pr);
  if (!g) return null;
  // parcel-land mask: only flooded land on parcels counts toward acres
  const res = (g.ext[2] - g.ext[0]) / g.w, c = document.createElement("canvas"); c.width = g.w; c.height = g.h;
  const ctx = c.getContext("2d"); ctx.fillStyle = "#000"; ctx.beginPath();
  for (const p of S.parcels) { const xy = p.xy, rg = p.rg; let s0 = 0;
    for (let r = 0; r < rg.length; r++) { const e = rg[r]; ctx.moveTo((S.O[0] + xy[2 * s0] - g.ext[0]) / res, (g.ext[3] - S.O[1] - xy[2 * s0 + 1]) / res);
      for (let i = s0 + 1; i < e; i++) ctx.lineTo((S.O[0] + xy[2 * i] - g.ext[0]) / res, (g.ext[3] - S.O[1] - xy[2 * i + 1]) / res); ctx.closePath(); s0 = e; } }
  ctx.fill();
  const md = ctx.getImageData(0, 0, g.w, g.h).data; g.land = new Uint8Array(g.w * g.h);
  for (let i = 0; i < g.land.length; i++) g.land[i] = md[4 * i + 3] > 127 ? 1 : 0;
  const lat = toLatLng((g.ext[0] + g.ext[2]) / 2, (g.ext[1] + g.ext[3]) / 2)[0];
  g.acrePx = Math.pow(res * Math.cos(lat * Math.PI / 180), 2) / ACRE_M2;
  return g;
}
async function floodTownStart() {
  $("acresChart").innerHTML = ""; $("acresNote").textContent = "Loading town elevation grid…";
  try { F.town = await floodTownGrid(); }
  catch (e) { F.town = null; }
  if (!F.town) { $("acresNote").textContent = "Flooded area could not be computed right now."; return; }
  floodAcres();
}
function floodAcres() {
  const g = F.town; if (!g) return;
  const pr = P(), key = JSON.stringify(pr) + "|" + S.scen;
  if (F.acresKey !== key) {
    const years = []; for (let y = 2020; y <= 2100; y += 10) years.push(y);
    const cls = new Uint8Array(g.w * g.h);
    F.acres = years.map((y) => { classify(g, S.scen, y, pr, cls); const a = [0, 0, 0, 0, 0];
      for (let i = 0; i < cls.length; i++) if (g.land[i] && cls[i]) a[cls[i]]++; return { y, a: a.map((v) => v * g.acrePx) }; });
    F.acresKey = key;
  }
  drawAcres();
}
function drawAcres() {
  const data = F.acres; if (!data) return;
  $("acresChart").innerHTML = acresSVG(data, S.year, { grid: "var(--line)", text: "var(--muted)", mark: "var(--accent)",
    c: ["", "var(--chronic)", "var(--d0)", "var(--d1)", "var(--d3)"] });
  const cur = data.find((d) => d.y === Math.round(S.year / 10) * 10) || data[data.length - 1];
  const tot = cur.a[1] + cur.a[2] + cur.a[3] + cur.a[4], base = data[0].a.slice(1).reduce((s, v) => s + v, 0);
  $("acresNote").textContent = `${SCEN[S.scen]}, ${cur.y}: ${num(cur.a[1])} acres of parcel land below high tide and ${num(cur.a[2] + cur.a[3] + cur.a[4])} acres in the 1% flood, ${num(tot)} in all (${num(base)} today).`;
}
function acresSVG(data, year, c) {
  const W = 900, H = 240, m = { l: 64, r: 16, t: 12, b: 30 };
  const tot = data.map((d) => d.a[1] + d.a[2] + d.a[3] + d.a[4]);
  const nice = niceMax(Math.max(1, ...tot)), bw = (W - m.l - m.r) / data.length;
  const Y = (v) => H - m.b - v / nice * (H - m.t - m.b);
  const ft = `font-family="Golos Text,system-ui,sans-serif" font-size="12"`;
  let s = "";
  for (let k = 0; k <= 4; k++) { const v = nice * k / 4; s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${c.grid}"/><text ${ft} x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end" fill="${c.text}">${num(v)}</text>`; }
  data.forEach((d, i) => {
    const x = m.l + i * bw + bw * 0.18, w = bw * 0.64; let acc = 0;
    for (const k of [1, 4, 3, 2]) { const v = d.a[k]; if (v <= 0) continue; s += `<rect x="${x.toFixed(1)}" y="${Y(acc + v).toFixed(1)}" width="${w.toFixed(1)}" height="${(Y(acc) - Y(acc + v)).toFixed(1)}" fill="${c.c[k]}"/>`; acc += v; }
    const sel = d.y === Math.round(year / 10) * 10;
    if (sel) s += `<rect x="${(x - 3).toFixed(1)}" y="${m.t}" width="${(w + 6).toFixed(1)}" height="${H - m.t - m.b}" fill="none" stroke="${c.mark}" stroke-width="1.5" stroke-dasharray="4 3"/>`;
    s += `<text ${ft} x="${(x + w / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle" fill="${c.text}"${sel ? ' font-weight="700"' : ""}>${d.y}</text>`;
  });
  s += `<text ${ft} x="${m.l - 8}" y="${m.t - 2}" text-anchor="end" fill="${c.text}">acres</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Flooded parcel acres by year">${s}</svg>`;
}
/* Town-wide flood image for the report (light background, print colors). */
function floodReportImage() {
  const g = F.town; if (!g) return null;
  const cls = classify(g, S.scen, S.year, P(), new Uint8Array(g.w * g.h));
  const c = document.createElement("canvas"); c.width = g.w; c.height = g.h;
  const ctx = c.getContext("2d"), img = ctx.createImageData(g.w, g.h), d = img.data;
  const pal = [null, [32, 50, 110], [242, 193, 78], [232, 131, 58], [201, 48, 44]];
  for (let i = 0; i < cls.length; i++) {
    const p = pal[cls[i]], j = 4 * i;
    if (p) { d[j] = p[0]; d[j + 1] = p[1]; d[j + 2] = p[2]; d[j + 3] = 255; }
    else if (g.land[i]) { d[j] = 228; d[j + 1] = 232; d[j + 2] = 235; d[j + 3] = 255; }
    else { d[j] = 247; d[j + 1] = 249; d[j + 2] = 248; d[j + 3] = 255; }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL("image/png");
}

/* ---------- play through the years ---------- */
function stopPlay() { if (F.playing) { clearInterval(F.playing); F.playing = null; } const b = $("play"); if (b) { b.textContent = "▶ Play 2030–2100"; b.setAttribute("aria-pressed", "false"); } }
function togglePlay() {
  if (F.playing) { stopPlay(); return; }
  const yEl = $("year"), b = $("play");
  b.textContent = "❚❚ Pause"; b.setAttribute("aria-pressed", "true");
  if (S.year >= 2100) { S.year = 2030; yEl.value = 2030; recompute(); }
  F.playing = setInterval(() => {
    if (S.year >= 2100) { stopPlay(); return; }
    S.year += 10; yEl.value = S.year; recompute();
  }, 1100);
}
