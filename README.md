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

## Saved elevations

Sampling lidar elevation for thousands of parcels is the slowest part of an analysis, so each town's parcel elevations are saved in `data/elev/<town>.json` and the app requests only points that are missing. The files are built by the **Build saved elevations** GitHub Action (`.github/workflows/elevations.yml`, script `scripts/build-elevations.mjs`):

- Run it from the Actions tab for all towns, or for a comma-separated list of towns. Tick *force* to rebuild towns that already have files.
- It refreshes every town quarterly. It stops starting new towns after five hours and commits progress every ten towns, so a run that ends early resumes where it left off.
- `geo.js` holds the parcel-point logic shared by the app and the script, so saved points match the app exactly.

## Method in brief

- Land below future mean higher high water is treated as permanently lost (only land that is dry today counts).
- Coastal flood elevations (FEMA BFE or the town's coastal still-water elevation) rise one-for-one with sea level after 2020.
- Riverine flood elevations rise with a scenario-scaled climate allowance.
- Building damage uses the USACE generic depth–damage curve (one story, no basement).
- Tax at risk = assessed value lost to tide + market discount on newly exposed parcels + annualized post-flood reassessment, reported as the change from today's exposure.

All assumptions (mill rate, discount, first-floor height and others) are editable in the app. This is a screening tool, not a substitute for a site-specific engineering study.

## Deploy

Cloudflare Workers static assets: no build command; the repository root is served.

```
npx wrangler deploy
```
