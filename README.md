# Flood Risk & Tax Base

A SECOG web app that estimates how sea level rise and inland flooding affect property values and property tax revenue, parcel by parcel, for any Connecticut municipality. Pick a town, a NOAA 2022 sea level rise scenario and a planning year to see the added annual tax revenue at risk, a parcel exposure map, the loss by type and land use, and a ranked parcel list. Results export as a CSV or a printable report (print / save as PDF).

Live site: https://floodrisk.secogct.gov

It is a static site (`index.html` + `logo.svg`) with no build step. Each time a town is analyzed, the browser pulls live data from:

| Data | Source |
|---|---|
| Parcel boundaries, assessed and appraised values | Connecticut CAMA and Parcel Layer (CT OPM / ArcGIS) |
| Flood zones and base flood elevations | FEMA National Flood Hazard Layer |
| Ground elevation (1 m lidar) | USGS 3DEP elevation service |
| Sea level rise scenarios (2022 Interagency) | NOAA CO-OPS, Bridgeport and New London gauges |
| Building footprints | CT 2D Building Footprints (ArcGIS) |

## Flood extent and depth

The map shades modeled flood extent and depth for the selected scenario and year, and a chart shows flooded parcel acres by decade. Elevation for the map view comes from the USGS 3DEP image service encoded in a PNG (`flood.js`); the browser compares it with the same water levels used for parcels, so changing the year or pressing Play needs no new downloads.

## Flood elevation tiles

The USGS 3DEP image service computes each map view on demand, which takes 15–60 seconds and often times out. The **Build flood elevation tiles** GitHub Action (`.github/workflows/dem.yml`, script `scripts/build-dem.mjs`) downloads the 1 m elevation once, only where flooding is possible (FEMA flood zones plus the coastal reach around VE zones), and saves it as 256 px tiles in `data/dem/<z>/<x>/<y>.png` for zooms 12–15. Each pixel stores elevation in 5 cm steps (`R*256 + G = (metres + 100) * 20`; transparent = no data). The app reads these tiles for towns listed in `data/dem/towns.json` and falls back to the live service for others. SECOG towns are built first.

## SECOG region comparison

The **Build regional comparison** GitHub Action (`.github/workflows/region.yml`, script `scripts/build-region.mjs`) runs the same model (`model.js`, `geo.js`) for every SECOG town with the default assumptions, for all five scenarios and every decade, and writes `data/region/southeastern-ct.json`. The app ranks towns by share of tax base at risk or by dollars a year, using each town's latest municipal mill rate from CT OPM on data.ct.gov. It refreshes monthly.

## Saved elevations

Sampling lidar elevation for thousands of parcels and buildings is the slowest part of an analysis, so each town's parcel elevations are saved in `data/elev/<town>.json`, and each building's point, footprint area and ground elevation in `data/bldg/<town>.json`. The app requests only points that are missing. The files are built by the **Build saved elevations** GitHub Action (`.github/workflows/elevations.yml`, script `scripts/build-elevations.mjs`):

- Run it from the Actions tab for all towns, or for a comma-separated list of towns. Tick *force* to rebuild towns that already have files.
- It refreshes every town quarterly. It stops starting new towns after five hours and commits progress every ten towns, so a run that ends early resumes where it left off.
- `geo.js` holds the parcel-point logic shared by the app and the script, so saved points match the app exactly.

## Method in brief

- Land below future mean higher high water is treated as permanently lost (only land that is dry today counts).
- Coastal flood elevations (FEMA BFE or the town's coastal still-water elevation) rise one-for-one with sea level after 2020.
- Riverine flood elevations rise with a scenario-scaled climate allowance.
- Buildings from the CT 2D Building Footprints layer are matched to parcels; each building's own ground elevation sets its flood depth and tidal loss, with the parcel's building value split by footprint area. Land loss uses the parcel's ground points.
- Building damage uses the USACE generic depth–damage curve (one story, no basement).
- Tax at risk = assessed value lost to tide + market discount on newly exposed parcels + annualized post-flood reassessment, reported as the change from today's exposure.

All assumptions (mill rate, discount, first-floor height and others) are editable in the app. This is a screening tool, not a substitute for a site-specific engineering study.

## Deploy

Cloudflare Workers static assets: no build command; the repository root is served.

```
npx wrangler deploy
```
