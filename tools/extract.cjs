// OpenFreeMap z14 瓦片 → 常州主城区本地米坐标（x 向东, y 向北, 原点=天宁寺附近）
const H='C:/Users/KoTriumphZ/AppData/Roaming/dsh-desktop/harness/changzhou-geodata/';
const fs=require('fs'), zlib=require('zlib');
const {VectorTile}=require(H+'node_modules/@mapbox/vector-tile');
const {PbfReader:Pbf}=require(H+'node_modules/pbf');
const LON0=119.965, LAT0=31.785;
const KX=111320*Math.cos(LAT0*Math.PI/180), KY=110574;
const P=([lon,lat])=>[+((lon-LON0)*KX).toFixed(1), +((lat-LAT0)*KY).toFixed(1)];
const out={origin:{lon:LON0,lat:LAT0,kx:KX,ky:KY},roads:[],rail:[],water:[],waterway:[],landuse:[],landcover:[],park:[],buildings:[],pois:[],names:[]};
const seenB=new Set();
const polys=g=>g.type==='Polygon'?[g.coordinates]:g.type==='MultiPolygon'?g.coordinates:[];
const lines=g=>g.type==='LineString'?[g.coordinates]:g.type==='MultiLineString'?g.coordinates:[];
for(const f of fs.readdirSync(H+'tiles-ofm/14')){
  const [x,y]=f.replace('.pbf','').split('_').map(Number);
  let buf=fs.readFileSync(H+'tiles-ofm/14/'+f); if(buf[0]===0x1f) buf=zlib.gunzipSync(buf);
  const t=new VectorTile(new Pbf(buf));
  const each=(ln,cb)=>{const L=t.layers[ln]; if(!L) return; for(let i=0;i<L.length;i++){const ft=L.feature(i); cb(ft.toGeoJSON(x,y,14).geometry, ft.properties);}};
  each('transportation',(g,p)=>{ for(const l of lines(g)){ const o={c:p.class,s:p.subclass||'',br:p.brunnel||'',lv:p.layer||0,o:p.oneway||0,pts:l.map(P)};
      (p.class==='rail'||p.class==='transit')?out.rail.push(o):out.roads.push(o);} });
  each('water',(g,p)=>{ for(const pg of polys(g)) out.water.push({c:p.class,r:pg.map(r=>r.map(P))}); });
  each('waterway',(g,p)=>{ for(const l of lines(g)) out.waterway.push({c:p.class,n:p.name||'',pts:l.map(P)}); });
  each('landuse',(g,p)=>{ for(const pg of polys(g)) out.landuse.push({c:p.class,r:pg.map(r=>r.map(P))}); });
  each('landcover',(g,p)=>{ for(const pg of polys(g)) out.landcover.push({c:p.class,s:p.subclass||'',r:pg.map(r=>r.map(P))}); });
  each('park',(g,p)=>{ if(g.type==='Point') return; for(const pg of polys(g)) out.park.push({c:p.class,n:p.name||'',r:pg.map(r=>r.map(P))}); });
  each('building',(g,p)=>{ for(const pg of polys(g)){ const r=pg.map(r=>r.map(P)); const k=r[0].slice(0,3).join(); if(seenB.has(k)) continue; seenB.add(k);
      out.buildings.push({h:p.render_height||0,mh:p.render_min_height||0,r}); } });
  each('poi',(g,p)=>{ if(g.type!=='Point'||!p.name) return; out.pois.push({n:p.name,c:p.class,s:p.subclass||'',p:P(g.coordinates)}); });
  each('water_name',(g,p)=>{ if(g.type==='Point'&&p.name) out.names.push({n:p.name,c:'water',p:P(g.coordinates)}); });
  each('park',(g,p)=>{ if(g.type==='Point'&&p.name) out.names.push({n:p.name,c:'park',p:P(g.coordinates)}); });
}
const dedupe=a=>{const s=new Set();return a.filter(o=>{const k=o.n+'|'+o.c;if(s.has(k))return false;s.add(k);return true;});};
out.pois=dedupe(out.pois); out.names=dedupe(out.names);
fs.writeFileSync(process.argv[2],JSON.stringify(out));
const cnt={}; for(const k in out) if(Array.isArray(out[k])) cnt[k]=out[k].length; console.log(cnt);
const rc={}; out.roads.forEach(r=>rc[r.c]=(rc[r.c]||0)+1); console.log(rc);
const lc={}; out.landuse.forEach(r=>lc[r.c]=(lc[r.c]||0)+1); console.log('landuse',lc);
const cc={}; out.landcover.forEach(r=>cc[r.c+'/'+r.s]=(cc[r.c+'/'+r.s]||0)+1); console.log('landcover',cc);
