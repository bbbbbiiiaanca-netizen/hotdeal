"""헤더용 가로형 로고 생성: assets/logo.png, assets/logo.webp (높이 88px = 44px @2x).

gyaru-mix.png(승인된 정사각 로고)의 톤을 가로 한 줄 배지로 옮긴 버전.
어느 위치에서 실행해도 레포 루트 기준으로 저장한다.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops
import math, os, random

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets")
DH = "/usr/share/fonts/truetype/sand-box/google/Do Hyeon/DoHyeon-Regular.ttf"

K = 8                 # supersample 배율
FINAL_H = 88          # 최종 높이(px)
H = FINAL_H * K       # 작업 캔버스 높이
W = 3 * H + 200       # 넉넉한 작업 폭(나중에 trim)
PAD = 2 * K           # 배지 바깥 투명 여백

RED, ORANGE, YELLOW, PINK = "#E8121E", "#FF7A00", "#FFE93F", "#FF2E93"


def star(d, cx, cy, r, fill, n=4, inner=.35):
    pts = []
    for i in range(n * 2):
        a = math.pi * i / n - math.pi / 2; rr = r if i % 2 == 0 else r * inner
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    d.polygon(pts, fill=fill)


def heart(d, cx, cy, s, fill):
    d.ellipse([cx - s, cy - s * .6, cx, cy + s * .4], fill=fill); d.ellipse([cx, cy - s * .6, cx + s, cy + s * .4], fill=fill)
    d.polygon([(cx - s * .97, cy), (cx + s * .97, cy), (cx, cy + s * 1.1)], fill=fill)


def burst(d, cx, cy, rx, ry, n, depth, fill, rnd):
    """가로로 긴 타원형 폭발 말풍선. 바깥 꼭짓점 길이를 살짝 흔들어 손그림 느낌."""
    pts = []
    for i in range(n * 2):
        a = math.pi * i / n + .12
        k = rnd.uniform(.97, 1.06) if i % 2 == 0 else 1 - depth
        pts.append((cx + rx * k * math.cos(a), cy + ry * k * math.sin(a)))
    d.polygon(pts, fill=fill)


def word(t, size, fill, rot):
    """흰 외곽선 + 부드러운 그림자 글자 레이어(회전 적용, 여백 trim)."""
    f = ImageFont.truetype(DH, size); sw = int(size * .085)
    l, tp, r, b = ImageDraw.Draw(Image.new("L", (1, 1))).textbbox((0, 0), t, font=f, stroke_width=sw)
    m = size // 3; w, h = r - l + 2 * m, b - tp + 2 * m
    off = int(size * .045)
    sh = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(sh).text((m - l + off, m - tp + off), t, font=f, fill=(120, 0, 50, 120),
                            stroke_width=sw, stroke_fill=(120, 0, 50, 120))
    sh = sh.filter(ImageFilter.GaussianBlur(size * .025))
    fg = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(fg).text((m - l, m - tp), t, font=f, fill=fill, stroke_width=sw, stroke_fill="white")
    sh.alpha_composite(fg)
    sh = sh.rotate(rot, resample=Image.BICUBIC, expand=True)
    return sh.crop(sh.getbbox())


# 글자 레이어 먼저 만들고 크기에 맞춰 배지 폭 결정
w1 = word("핫딜", int(H * .58), RED, 5)
w2 = word("오이데~", int(H * .58), ORANGE, 4)
gap = int(H * .02)
tw = w1.width + gap + w2.width
bh = H - 2 * PAD                              # 배지 높이
bw = tw + int(bh * .5)                        # 좌우 둥근 끝 여유
W = bw + 2 * PAD
bx0, by0, bx1, by1 = PAD, PAD, PAD + bw, PAD + bh

# 배지 모양 마스크(알약형)
mask = Image.new("L", (W, H), 0)
ImageDraw.Draw(mask).rounded_rectangle([bx0, by0, bx1, by1], radius=bh // 2, fill=255)

# 핑크 그라데이션 + 글리터
rnd = random.Random(7)
bg = Image.new("RGBA", (W, H)); d = ImageDraw.Draw(bg)
for y in range(H):
    t = y / H; d.line([(0, y), (W, y)], fill=(255, int(70 + 105 * t), int(170 + 30 * t)))
for _ in range(W * H // 9000):
    x, y = rnd.randrange(W), rnd.randrange(H); r = rnd.choice([K, K, int(K * 1.4), int(K * 1.9)])
    d.ellipse([x - r, y - r, x + r, y + r], fill=rnd.choice(["white", "#FFF27A", "#FFB3E0"]))
burst(d, W / 2, H / 2, bw * .5, bh * .62, 24, .22, YELLOW, rnd)

# 글자 배치: 단어마다 따로 기울이고 살짝 위아래로 통통 튀게
tx = (W - tw) // 2
text = Image.new("RGBA", (W, H), (0, 0, 0, 0))
p1 = (tx, (H - w1.height) // 2 - int(H * .015))
p2 = (tx + w1.width + gap, (H - w2.height) // 2 + int(H * .015))
text.alpha_composite(w1, p1); text.alpha_composite(w2, p2)

# 하트·별이 글자를 가리지 않도록 글자 영역(여유 포함) 마스크
block = text.getchannel("A").point(lambda a: 255 if a > 8 else 0).filter(ImageFilter.MaxFilter(2 * K + 1))
inside = mask.filter(ImageFilter.MinFilter(6 * K + 1))


def free(cx, cy, r, placed):
    box = (int(cx - r), int(cy - r), int(cx + r), int(cy + r))
    if box[0] < 0 or box[1] < 0 or box[2] >= W or box[3] >= H: return False
    if inside.crop(box).getextrema()[0] < 255: return False
    if block.crop(box).getextrema()[1] > 0: return False
    return all(math.hypot(cx - x, cy - y) > r + rr + 7 * K for x, y, rr in placed)


deco = ImageDraw.Draw(bg); placed = []
for s, (xa, xb) in ((int(H * .085), (bx0, W / 2)), (int(H * .07), (W / 2, bx1))):  # 하트: 좌우 하나씩
    for _ in range(4000):
        cx, cy = rnd.uniform(xa, xb), rnd.uniform(by0, by1)
        if free(cx, cy, s * 1.15, placed):
            heart(deco, cx, cy, s, PINK); placed.append((cx, cy, s * 1.15)); break
for r in (H * .13, H * .1, H * .075, H * .06, H * .05, H * .045, H * .035):  # 반짝이 별(크기·위치 제각각)
    for _ in range(4000):
        cx, cy = rnd.uniform(bx0, bx1), rnd.uniform(by0, by1)
        if free(cx, cy, r * .8, placed):
            star(deco, cx, cy, r, "#FFF6A8" if r == H * .075 else "white", inner=rnd.uniform(.22, .32))
            placed.append((cx, cy, r * .8)); break

bg.alpha_composite(text)
# 배지 테두리(흰색 얇은 선)로 흰 헤더에서도 경계가 또렷하게
ImageDraw.Draw(bg).rounded_rectangle([bx0, by0, bx1, by1], radius=bh // 2, outline="white", width=int(1.2 * K))
bg.putalpha(ImageChops.multiply(bg.getchannel("A"), mask))

# trim → 높이 88 고정 축소
bb = bg.getbbox(); m = K
bg = bg.crop((bb[0] - m, bb[1] - m, bb[2] + m, bb[3] + m))
out = bg.resize((round(bg.width * FINAL_H / bg.height), FINAL_H), Image.LANCZOS)

os.makedirs(OUT, exist_ok=True)
out.save(os.path.join(OUT, "logo.png"), optimize=True)
out.save(os.path.join(OUT, "logo.webp"), lossless=True, quality=100, method=6)
print(out.size, {f: os.path.getsize(os.path.join(OUT, f)) for f in ("logo.png", "logo.webp")})
