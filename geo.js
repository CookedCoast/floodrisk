/* Shared geometry helpers for Flood Risk & Tax Base.
   Loaded by index.html in the browser and required by scripts/build-elevations.mjs,
   so the saved elevation points are computed exactly as the app computes them. */
(function(root){
"use strict";
function polysOf(g){if(!g)return[];return g.type==="Polygon"?[g.coordinates]:g.type==="MultiPolygon"?g.coordinates:[]}
function bboxOf(g){let a=180,b=90,c=-180,d=-90;for(const p of polysOf(g))for(const r of p)for(const[x,y]of r){if(x<a)a=x;if(y<b)b=y;if(x>c)c=x;if(y>d)d=y}return[a,b,c,d]}
function inRing(x,y,r){let ins=false;for(let i=0,j=r.length-1;i<r.length;j=i++){const xi=r[i][0],yi=r[i][1],xj=r[j][0],yj=r[j][1];if(((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi))ins=!ins}return ins}
function inGeom(x,y,g){for(const p of polysOf(g)){if(inRing(x,y,p[0])){let hole=false;for(let k=1;k<p.length;k++)if(inRing(x,y,p[k])){hole=true;break}if(!hole)return true}}return false}
function ringArea(r){let a=0;for(let i=0,j=r.length-1;i<r.length;j=i++)a+=(r[j][0]+r[i][0])*(r[j][1]-r[i][1]);return Math.abs(a/2)}
function pointOn(g){
  const ps=polysOf(g);if(!ps.length)return null;let best=ps[0],ba=-1;for(const p of ps){const a=ringArea(p[0]);if(a>ba){ba=a;best=p}}
  const r=best[0];let cx=0,cy=0,A=0;for(let i=0,j=r.length-1;i<r.length;j=i++){const f=r[j][0]*r[i][1]-r[i][0]*r[j][1];cx+=(r[j][0]+r[i][0])*f;cy+=(r[j][1]+r[i][1])*f;A+=f}
  if(A!==0){cx/=3*A;cy/=3*A;if(inGeom(cx,cy,{type:"Polygon",coordinates:best}))return[cx,cy]}
  let y0=1e9,y1=-1e9;for(const[,y]of r){if(y<y0)y0=y;if(y>y1)y1=y}
  for(const f of[.5,.4,.6,.3,.7]){const y=y0+(y1-y0)*f;const xs=[];for(let i=0,j=r.length-1;i<r.length;j=i++){const yi=r[i][1],yj=r[j][1];if((yi>y)!==(yj>y))xs.push(r[i][0]+(y-yi)*(r[j][0]-r[i][0])/(yj-yi))}xs.sort((a,b)=>a-b);
    if(xs.length>=2){let w=0,m=null;for(let k=0;k+1<xs.length;k+=2){if(xs[k+1]-xs[k]>w){w=xs[k+1]-xs[k];m=(xs[k]+xs[k+1])/2}}if(m!==null)return[m,y]}}
  return[r[0][0],r[0][1]];
}
const api={polysOf,bboxOf,inRing,inGeom,ringArea,pointOn,
  /* key for a sample point: lon/lat in millionths of a degree */
  ptKey:(pt)=>Math.round(pt[0]*1e6)+","+Math.round(pt[1]*1e6),
  townSlug:(t)=>String(t).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")};
if(typeof module!=="undefined"&&module.exports)module.exports=api;else Object.assign(root,api);
})(typeof globalThis!=="undefined"?globalThis:this);
