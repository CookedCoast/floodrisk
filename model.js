/* Flood and tax model for Flood Risk & Tax Base.
   Shared by the app (index.html) and scripts/build-region.mjs, so regional results match the app.
   Functions read the analysis state from a global S: S.slr (NOAA curves by scenario), S.coastal
   (town has VE zones) and S.parcels (parcels with zone, elevations and buildings). */
(function(root){
"use strict";
const SCEN=["Low","Intermediate-Low","Intermediate","Intermediate-High","High"];
const SCEN_SHORT=["Low","Int-Low","Int","Int-High","High"];
const RIVER_MULT=[0.5,0.75,1,1.5,2];
const SLR_YEARS=[2005,2020,2030,2040,2050,2060,2070,2080,2090,2100];
// NOAA 2022 Interagency scenarios (cm, relative to 2005). Used only if the live API cannot be reached.
const SLR_FALLBACK={
  "8467150":{name:"Bridgeport",lon:-73.1817,mhhw:3.48,s:{"Low":[0,9,16,22,29,34,38,42,46,49],"Intermediate-Low":[0,10,17,25,33,41,48,55,62,68],"Intermediate":[0,11,18,27,37,48,60,75,93,114],"Intermediate-High":[0,11,19,30,42,58,76,98,122,150],"High":[0,10,19,31,46,67,94,125,159,193]}},
  "8461490":{name:"New London",lon:-72.0950,mhhw:1.21,s:{"Low":[0,9,16,23,29,35,39,42,46,50],"Intermediate-Low":[0,10,18,26,34,42,49,56,63,69],"Intermediate":[0,11,19,28,37,49,61,76,95,115],"Intermediate-High":[0,11,20,30,43,59,78,100,125,152],"High":[0,10,19,31,47,67,95,126,161,195]}}
};
// USACE EGM 01-03, one-story no basement: % structure damage by depth above first floor (ft)
const DDF=[[-1,2.5],[0,13.4],[1,23.3],[2,32.1],[3,40.1],[4,47.1],[5,53.2],[6,58.6],[7,63.2],[8,67.2],[9,70.5],[10,73.2],[11,75.4],[12,77.2],[13,78.5],[14,79.5],[15,80.2],[16,80.7]];
function slrFt(scen,year){const s=S.slr[SCEN[scen]];let i=SLR_YEARS.findIndex(y=>y>=year);if(i<=0)i=1;if(year>2100)i=SLR_YEARS.length-1;
  const y0=SLR_YEARS[i-1],y1=SLR_YEARS[i];const v=s[i-1]+(s[i]-s[i-1])*Math.min(1,(year-y0)/(y1-y0));return v/30.48}
function ddf(d){if(d<DDF[0][0])return 0;for(let i=1;i<DDF.length;i++)if(d<=DDF[i][0]){const[a,fa]=DDF[i-1],[b,fb]=DDF[i];return(fa+(fb-fa)*(d-a)/(b-a))/100}return DDF[DDF.length-1][1]/100}
/* Water levels for one parcel; depth is then read at the parcel's land points and at each building. */
function parcelState(p,scen,year,pr){
  if(p.elev===null||p.elev===undefined)return null;
  const slrAbs=slrFt(scen,year),slr0=slrFt(scen,2020),dSLR=Math.max(0,slrAbs-slr0);
  const uplift=pr.up*RIVER_MULT[scen]*Math.max(0,Math.min(1,(year-2020)/80));
  const z=p.zone,coastalZone=z&&(z.kind==="V"||z.coastalAE);
  const coastalOn=S.coastal&&(p.coastal||coastalZone);
  const wl=pr.mhhw+slrAbs,wl0=pr.mhhw+slr0;
  let cWL=null;if(coastalOn){const base=(coastalZone&&z.bfe)?z.bfe:pr.cbfe;if(base!=null)cWL=base+dSLR}
  let rWL=null,rConst=null;
  if(z&&!coastalZone){if(z.kind==="A"){if(z.bfe!=null)rWL=z.bfe+uplift;else rConst=(z.depth!=null&&/AO/.test(z.zone))?z.depth+uplift:pr.adepth+uplift}else if(z.kind==="X02")rConst=uplift-pr.x02}
  const depthAt=e=>{const c=cWL!=null?cWL-e:-99,r=rWL!=null?rWL-e:(rConst!=null?rConst:-99);return c>=r?[c,"Coastal"]:[r,"Riverine"]};
  const newlyTidal=e=>coastalOn&&e<wl&&!(e<wl0);
  // land: share of the parcel's ground points newly below high tide
  let landLost=0;if(coastalOn){const es=p.elevs||[p.elev];let nN=0,n0=0;for(let i=0;i<es.length;i++){if(es[i]<wl)nN++;if(es[i]<wl0)n0++}landLost=Math.max(0,(nN-n0)/es.length)}
  // buildings: each building's own ground; value split by footprint area
  let bLost=0,dmgFrac=0,depth=-99,src="Coastal",exposed=false;const bs=p.bldgs;
  if(bs&&bs.length){for(const b of bs){const e=b.e!=null?b.e:p.elev;if(newlyTidal(e)){bLost+=b.w;continue}
      const[d,sr]=depthAt(e);if(d>depth){depth=d;src=sr}if(d>0){exposed=true;dmgFrac+=b.w*ddf(d-pr.ffh)}}
    if(bLost>=0.999){depth=0;}}
  else{const[d,sr]=depthAt(p.elev);depth=d;src=sr;exposed=d>0;bLost=landLost;dmgFrac=d>0?ddf(d-pr.ffh)*(1-bLost):0}
  const lost=landLost*p.aLand+bLost*p.aBldg;
  return{landLost,bLost,depth,src,exposed,dmgFrac,lost,tideShare:p.assessed>0?lost/p.assessed:landLost,nb:bs?bs.length:0};
}
function parcelMoney(p,st,pr){
  if(!st)return{tax:0,lost:0,disc:0,dmg:0,exposed:false};
  const lost=st.lost,disc=st.exposed?pr.disc*Math.max(0,p.assessed-lost):0;
  const dmg=st.exposed&&p.bldgAppr>0?st.dmgFrac*p.bldgAppr:0;
  const tax=(lost+disc+pr.aep*dmg*pr.ratio)*pr.mill/1000;
  return{tax,lost,disc,dmg,exposed:st.exposed};
}
function evalAll(scen,year,pr,detail){
  let tot=0,base=0,n=0;const rows=detail?[]:null;
  for(const p of S.parcels){if(pr.exempt&&p.exempt)continue;if(p.elev===null||p.elev===undefined)continue;
    const s1=parcelState(p,scen,year,pr),s0=parcelState(p,scen,2020,pr);const m1=parcelMoney(p,s1,pr),m0=parcelMoney(p,s0,pr);
    const d=m1.tax-m0.tax;tot+=d;base+=m0.tax;
    const newly=(m1.exposed&&!m0.exposed)||s1.tideShare>0;if(newly)n++;
    if(detail&&(d>0.5||m1.exposed||s1.tideShare>0))rows.push({p,s1,s0,m1,m0,d,newly});}
  return{tot,base,n,rows};
}
function levy(pr){let a=0;for(const p of S.parcels){if(pr.exempt&&p.exempt)continue;a+=p.assessed}return a*pr.mill/1000}
function trajectory(scen,pr){const ys=[];for(let y=2020;y<=2100;y+=10)ys.push(evalAll(scen,y,pr).tot);return ys}
function npvFrom(traj,pr){let s=0;for(let y=2026;y<=2100;y++){const i=Math.min(8,Math.floor((y-2020)/10));const y0=2020+i*10;const v0=traj[i],v1=traj[Math.min(8,i+1)];s+=(v0+(v1-v0)*(y-y0)/10)/Math.pow(1+pr.npv,y-2026)}return s}
const api={SCEN,SCEN_SHORT,RIVER_MULT,SLR_YEARS,SLR_FALLBACK,DDF,slrFt,ddf,parcelState,parcelMoney,evalAll,levy,trajectory,npvFrom};
if(typeof module!=="undefined"&&module.exports)module.exports=api;else Object.assign(root,api);
})(typeof globalThis!=="undefined"?globalThis:this);
