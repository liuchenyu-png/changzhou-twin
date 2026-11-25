import json,sys,struct
from PIL import Image,ImageDraw
g=json.load(open(sys.argv[1],encoding='utf8')); B=g['bbox']; S=0.15
W=int((B['x1']-B['x0'])*S); H=int((B['y1']-B['y0'])*S)
im=Image.new('RGB',(W,H),(196,200,186)); dr=ImageDraw.Draw(im)
T=lambda p:((p[0]-B['x0'])*S,(B['y1']-p[1])*S)
for f in g['landuse']:
    col={'residential':(205,200,195),'industrial':(190,185,200),'commercial':(215,190,190)}.get(f['c'])
    if col: dr.polygon([T(p) for p in f['r'][0]],fill=col)
for f in g['landcover']: dr.polygon([T(p) for p in f['r'][0]],fill=(120,170,100) if f['c']!='farmland' else (200,210,140))
for f in g['water']: dr.polygon([T(p) for p in f['r'][0]],fill=(90,140,190))
for r in g['roads']: dr.line([T(p) for p in r['pts']],fill=(250,250,250) if r['c'] in('primary','trunk','motorway') else (235,235,235),width=max(1,int(r['w']*S)))
for b in g['buildings']:
    c=(60,60,70) if b['src']==0 else (180,60,60)
    dr.polygon([T(p) for p in b['r'][0]],fill=c)
im.save(sys.argv[2]); print(W,H)
