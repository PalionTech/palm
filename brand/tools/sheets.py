"""Raster outputs: contact sheets, favicon PNGs, app icons, social card."""
import os
from PIL import Image, ImageDraw
from render import render
import build
from build import BRAND, GREEN, MINT, INK, PAPER

SIZES = (128, 64, 32, 16)


def _zoom_panel(im, cells, x, y, zoom):
    """Paste nearest-neighbour enlargements of `cells` (crop boxes) at x, y."""
    dr = ImageDraw.Draw(im)
    for box in cells:
        w, h = box[2] - box[0], box[3] - box[1]
        im.paste(im.crop(box).resize((w * zoom, h * zoom), Image.NEAREST), (x, y))
        dr.rectangle((x - 1, y - 1, x + w * zoom, y + h * zoom), outline="#9aa")
        x += w * zoom + 12
    return x


def _sheet(rows, out, head, zoom=6, rowh=160, label_w=250, extra_h=0, extra_html=""):
    """rows: [(label, inner(sz, bg) -> svg markup[, viewBox])] drawn at SIZES on paper and ink."""
    top = 28
    x, cols = label_w, []
    for bg in (0, 1):
        for sz in SIZES:
            cols.append((x, sz, bg)); x += sz + 28
        x += 36
    zx = x + 10
    W, H = zx + 2 * (16 * zoom + 12) + 10, top + rowh * len(rows) + 12 + extra_h
    split = cols[len(SIZES)][0] - 32
    cells = []
    for i, (label, inner, *vb) in enumerate(rows):
        y = top + 12 + i * rowh
        vb = vb[0] if vb else "0 0 64 64"
        cells.append(f'<div class="l" style="top:{y + 50}px">{label}</div>')
        for cx, sz, bg in cols:
            col = GREEN if bg == 0 else MINT
            cells.append(f'<svg style="position:absolute;left:{cx}px;top:{y + (128 - sz) // 2}px;color:{col}" '
                         f'width="{sz}" height="{sz}" viewBox="{vb}">{inner(sz, bg)}</svg>')
    html = (f'<!doctype html><html><head><meta charset="utf-8"><style>body{{margin:0;width:{W}px;height:{H}px;'
            f'position:relative;background:#F4F4F2;font:12px/1.4 Menlo,monospace;color:#333}}'
            f'.l{{position:absolute;left:14px;width:{label_w - 30}px}}</style></head><body>'
            f'<div style="position:absolute;left:{label_w - 14}px;top:{top}px;width:{split - label_w + 14}px;height:{H - extra_h - top}px;background:#fff"></div>'
            f'<div style="position:absolute;left:{split}px;top:{top}px;width:{zx - 10 - split}px;height:{H - extra_h - top}px;background:{INK}"></div>'
            f'<div style="position:absolute;left:14px;top:8px">{head}</div>'
            + "".join(cells) + extra_html + "</body></html>")
    tmp = out + ".html"
    with open(tmp, "w") as f:
        f.write(html)
    render(tmp, out, W, H, transparent=False)
    os.remove(tmp)
    im = Image.open(out).convert("RGB")
    small = [c for c in cols if c[1] == 16]
    for i in range(len(rows)):
        y = top + 12 + i * rowh + 56
        _zoom_panel(im, [(cx, y, cx + 16, y + 16) for cx, _, _ in small], zx, y - 40, zoom)
    return im


def variant_sheet(rows, stem):
    def inner(d):
        def f(sz, bg):
            guide = ('<g fill="none" stroke="#e33" stroke-width=".25"><path d="M32 0V64M0 32H64"/>'
                     '<rect x=".13" y=".13" width="63.75" height="63.75"/></g>' if sz == 128 and bg == 0 else "")
            return f'{guide}<path fill="currentColor" d="{d}"/>'
        return f
    im = _sheet([(l, inner(d)) for l, d in rows], stem + ".png",
                "128 / 64 / 32 / 16 px on paper and ink (red: centre lines, 64-unit box); right: 16 px at 6x")
    im.save(stem + ".png", optimize=True)


# ---------------------------------------------------------------- PNG outputs
FAVICONS = (16, 32, 48)
TILES = {"apple-touch-icon.png": (180, 0.64), "icon-192.png": (192, 0.56), "icon-512.png": (512, 0.56)}


def favicon_pngs():
    """favicon-{16,32,48}.png: favicon.svg (light scheme) at exact size, transparent."""
    x, imgs = 0, []
    for sz in FAVICONS:
        imgs.append(f'<img src="favicon.svg" width="{sz}" height="{sz}" style="position:absolute;left:{x}px;top:0">')
        x += sz + 10
    page = os.path.join(BRAND, "_fav.html")
    with open(page, "w") as f:
        f.write(f'<!doctype html><body style="margin:0;background:transparent">{"".join(imgs)}</body>')
    out = os.path.join(BRAND, "_fav.png")
    render(page, out, x, 48)
    im = Image.open(out)
    x = 0
    for sz in FAVICONS:
        im.crop((x, 0, x + sz, sz)).save(os.path.join(BRAND, f"favicon-{sz}.png"), optimize=True)
        x += sz + 10
    os.remove(page); os.remove(out)
    ims = [Image.open(os.path.join(BRAND, f"favicon-{sz}.png")) for sz in FAVICONS]
    ims[-1].save(os.path.join(BRAND, "favicon.ico"), sizes=[(s, s) for s in FAVICONS], append_images=ims[:-1])


def tile_pngs():
    """App icons: the mint mark on an ink square (opaque; iOS/Android round the corners).
    The mark fills `ratio` of the tile height, inside the maskable safe zone for 192/512."""
    for name, (sz, ratio) in TILES.items():
        h = sz * ratio
        d = build.mark_d(x=0, y=0, height=h)
        x0, y0, x1, y1 = build.extent(build.PIVOT, build.rays_for(build.WINNER))
        w = h * (x1 - x0) / (y1 - y0)
        page = os.path.join(BRAND, "_tile.html")
        with open(page, "w") as f:
            f.write(f'<!doctype html><body style="margin:0;background:{INK}">'
                    f'<svg width="{sz}" height="{sz}" viewBox="0 0 {sz} {sz}" style="display:block">'
                    f'<path fill="{MINT}" transform="translate({(sz - w) / 2:.3f} {(sz - h) / 2:.3f})" d="{d}"/></svg></body>')
        out = os.path.join(BRAND, name)
        render(page, out, sz, sz, transparent=False)
        Image.open(out).convert("RGB").save(out, optimize=True)
        os.remove(page)


def social_card():
    render(os.path.join(BRAND, "social-card.html"), os.path.join(BRAND, "social-card.png"), 1280, 640,
           transparent=False)


def preview():
    """brand/preview.png: the mark at 16-128 px on paper and ink, the 16 px
    favicon PNG enlarged, and the lockups on both backgrounds."""
    d = build.mark_d()
    path = lambda sz, bg: f'<path fill="currentColor" d="{d}"/>'
    rows = [("mark.svg<br>(64-unit box)", path),
            ("favicon.svg<br>(56-unit crop: the stem<br>lands on whole pixels)", path, build.FAVICON_VIEWBOX)]
    extra_h = 470
    y0 = 28 + 12 + 160 * len(rows) + 10
    lock = (f'<div style="position:absolute;left:0;top:{y0}px;width:100%;height:{extra_h - 20}px;display:flex">'
            f'<div style="flex:1;background:#fff;display:flex;flex-direction:column;gap:40px;align-items:center;justify-content:center">'
            f'<img src="{BRAND}/wordmark.svg" height="72"><img src="{BRAND}/wordmark-stacked.svg" height="200"></div>'
            f'<div style="flex:1;background:{INK};display:flex;flex-direction:column;gap:40px;align-items:center;justify-content:center">'
            f'<img src="{BRAND}/wordmark-dark.svg" height="72"><img src="{BRAND}/wordmark-stacked-dark.svg" height="200"></div></div>')
    out = os.path.join(BRAND, "preview.png")
    im = _sheet(rows, out, "palm: the mark at 128 / 64 / 32 / 16 px on paper and ink, the 16 px renders at 6x, and the lockups",
                extra_h=extra_h, extra_html=lock)
    im.save(out, optimize=True)


def pngs():
    favicon_pngs()
    tile_pngs()
    social_card()
    preview()
