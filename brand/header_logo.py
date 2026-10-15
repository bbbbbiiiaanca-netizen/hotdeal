"""헤더용 가로형 로고 생성: assets/logo.png, assets/logo.webp (높이 88px = 44px @2x).

배경(핑크 글리터 알약·노란 말풍선·하트·별) 없이 글자만: 기울인 두꺼운 글자, "핫딜" 빨강 #E8121E,
"오이데~" 주황 #FF7A00, 얇은 흰 외곽선 + 얇은 어두운 그림자. 배경은 투명.
어느 위치에서 실행해도 레포 루트 기준으로 저장한다.

요구 사항: Pillow >= 10 (WebP 지원 빌드), Black Han Sans(검은고딕, Google Fonts, OFL; brand/fonts 에 포함).
  (Do Hyeon·Jua 는 작게 보면 '데'가 '테'처럼 읽혀서 Black Han Sans 로 교체)
  폰트 위치는 환경변수 HOTDEAL_LOGO_FONT 로 지정하거나 FONT_CANDIDATES 경로 중 하나에 둔다.
사용법: python3 brand/header_logo.py
출력: assets/logo.png, assets/logo.webp (무손실). 356x88 고정이라 HTML width/height(178x44)와 딱 맞는다.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets")
FONT_CANDIDATES = [os.path.join(ROOT, "brand", "fonts", "BlackHanSans-Regular.ttf")]
EXPECTED_FAMILY = "Black Han Sans"


def find_font():
    env = os.environ.get("HOTDEAL_LOGO_FONT")
    if env:
        if os.path.isfile(env): return env
        sys.exit(f"HOTDEAL_LOGO_FONT 경로에 폰트 파일이 없습니다: {env}")
    for p in FONT_CANDIDATES:
        if os.path.isfile(p): return p
    sys.exit("Black Han Sans 폰트(Google Fonts, OFL 라이선스)가 필요합니다.\n"
             "https://fonts.google.com/specimen/Black+Han+Sans 에서 BlackHanSans-Regular.ttf 를 받은 뒤\n"
             "  HOTDEAL_LOGO_FONT=/경로/BlackHanSans-Regular.ttf python3 brand/header_logo.py\n"
             "처럼 지정하거나 아래 경로 중 하나에 두세요:\n  " + "\n  ".join(FONT_CANDIDATES))


DH = find_font()
# 다른 글씨체로 조용히 대체되지 않도록 실제 불러온 폰트 이름을 확인하고, 아니면 바로 중단
_fam = ImageFont.truetype(DH, 40).getname()[0]
if _fam != EXPECTED_FAMILY:
    sys.exit(f"폰트가 {EXPECTED_FAMILY} 이(가) 아닙니다: {_fam} ({DH})")
print("font:", _fam, DH, file=sys.stderr)

K = 8                 # supersample 배율
FINAL_W, FINAL_H = 356, 88  # 최종 크기(px) = HTML 178x44 @2x
H = FINAL_H * K       # 작업 캔버스 높이

RED, ORANGE = "#E8121E", "#FF7A00"


def word(t, size, fill, rot):
    """얇은 흰 외곽선 + 얇은 어두운 그림자 글자 레이어(회전 적용, 여백 trim)."""
    f = ImageFont.truetype(DH, size); sw = max(1, int(size * .035))
    l, tp, r, b = ImageDraw.Draw(Image.new("L", (1, 1))).textbbox((0, 0), t, font=f, stroke_width=sw)
    m = size // 4; w, h = r - l + 2 * m, b - tp + 2 * m
    off = int(size * .03)
    sh = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(sh).text((m - l + off, m - tp + off), t, font=f, fill=(40, 0, 0, 110),
                            stroke_width=sw, stroke_fill=(40, 0, 0, 110))
    sh = sh.filter(ImageFilter.GaussianBlur(size * .012))
    fg = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(fg).text((m - l, m - tp), t, font=f, fill=fill, stroke_width=sw, stroke_fill="white")
    sh.alpha_composite(fg)
    sh = sh.rotate(rot, resample=Image.BICUBIC, expand=True)
    return sh.crop(sh.getbbox())


# 단어마다 따로 기울이고 살짝 위아래로 통통 튀게
size = int(H * .8)
w1 = word("핫딜", size, RED, 6)
w2 = word("오이데~", size, ORANGE, 4)
gap = int(H * .03); bounce = int(H * .03)
W = w1.width + gap + w2.width
CH = max(w1.height, w2.height) + bounce * 2
text = Image.new("RGBA", (W, CH), (0, 0, 0, 0))
text.alpha_composite(w1, (0, (CH - w1.height) // 2 - bounce))
text.alpha_composite(w2, (w1.width + gap, (CH - w2.height) // 2 + bounce))

# trim → 356x88 고정 축소 (356x88 고정)
bb = text.getbbox(); m = K
text = text.crop((bb[0] - m, bb[1] - m, bb[2] + m, bb[3] + m))
out = text.resize((FINAL_W, FINAL_H), Image.LANCZOS)

os.makedirs(OUT, exist_ok=True)
out.save(os.path.join(OUT, "logo.png"), optimize=True)
out.save(os.path.join(OUT, "logo.webp"), lossless=True, quality=100, method=6)
print(out.size, {f: os.path.getsize(os.path.join(OUT, f)) for f in ("logo.png", "logo.webp")})
