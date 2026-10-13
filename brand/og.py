exec(open('gyaru.py').read().split('# D:')[0])
import random; random.seed(7)
W,H=1200,630
def eburst(d,cx,cy,rx1,ry1,rx2,ry2,n,fill):
    pts=[]
    for i in range(n*2):
        a=math.pi*i/n; rx,ry=(rx1,ry1) if i%2==0 else (rx2,ry2)
        pts.append((cx+rx*math.cos(a),cy+ry*math.sin(a)))
    d.polygon(pts,fill=fill)
def otext(im,y,t,f,fill,stroke,sw,rot=0):
    layer=Image.new("RGBA",(W,H),(0,0,0,0));d=ImageDraw.Draw(layer)
    w=d.textlength(t,font=f)
    d.text(((W-w)/2+8,y+10),t,font=f,fill=(0,0,0,90),stroke_width=sw,stroke_fill=(0,0,0,90))
    d.text(((W-w)/2,y),t,font=f,fill=fill,stroke_width=sw,stroke_fill=stroke)
    if rot: layer=layer.rotate(rot,center=(W/2,y+f.size/2),resample=Image.BICUBIC)
    im.alpha_composite(layer)
im=Image.new("RGBA",(W,H));d=ImageDraw.Draw(im)
for y in range(H):
    t=y/H; d.line([(0,y),(W,y)],fill=(255,int(80+110*t),int(180+20*t)))
for _ in range(360):
    x,y=random.randrange(W),random.randrange(H); r=random.choice([3,4,6])
    d.ellipse([x-r,y-r,x+r,y+r],fill=random.choice(["white","#FFF27A","#FFB3E0"]))
eburst(d,W/2,H/2-20,520,300,430,240,24,"#FFE93F")
random.seed(21)
for (x,y,r) in [(90,110,56),(250,560,34),(1110,120,44),(1130,470,30),(980,575,40),(60,400,22),(330,60,20),(870,45,18)]:
    star(d,x,y,r,"white",inner=random.uniform(.25,.4))
heart(d,250,215,36,"#FF2E93");heart(d,955,250,30,"#FF2E93");heart(d,975,380,20,"#FF2E93")
otext(im,20,"핫딜",ImageFont.truetype(DH,220),"#E8121E","white",16,5)
otext(im,240,"오이데~",ImageFont.truetype(DH,180),"#FF7A00","white",16,-4)
f=ImageFont.truetype(NB,40,index=1); t="매일 아침 골라 담는 특가"
w=d.textlength(t,font=f); px,py=(W-w)/2,510
d.rounded_rectangle([px-30,py-6,px+w+30,py+62],radius=34,fill="white")
d.text((px,py),t,font=f,fill="#FF2E93")
im.convert("RGB").save("../assets/og.png")
