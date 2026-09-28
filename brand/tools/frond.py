"""Geometry for the palm mark: bars of one family radiating from one pivot.

Each ray (leaflet or stem) is the convex hull of a circle of radius rb at the
pivot P and a circle of radius rt at the tip, a distance `length` along the
ray: a straight bar when rb == rt, a tapered leaflet when rb < rt. Angles are
degrees clockwise from straight up (0 = up, 180 = the stem).

The outline is the exact union of the rays. Neighbouring rays meet at a notch,
the intersection of their facing tangent edges, so the result is one closed
contour of lines and tip arcs: no overlapping subpaths, no stray points.
"""
import math


def unit(deg):
    a = math.radians(deg)
    return math.sin(a), -math.cos(a)


def fmt(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def pt(p):
    return f"{fmt(p[0])} {fmt(p[1])}"


def add(p, v, k=1.0):
    return p[0] + v[0] * k, p[1] + v[1] * k


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1]


class Ray:
    def __init__(self, pivot, angle, length, rb, rt):
        self.angle, self.length, self.rb, self.rt = angle, length, rb, rt
        u = unit(angle)
        self.tip = add(pivot, u, length)
        s = (rt - rb) / length                 # sin of the taper angle
        c = math.sqrt(1 - s * s)
        n_l, n_r = unit(angle - 90), unit(angle + 90)
        # outward normals of the two tangent edges
        self.m_l = (n_l[0] * c - u[0] * s, n_l[1] * c - u[1] * s)
        self.m_r = (n_r[0] * c - u[0] * s, n_r[1] * c - u[1] * s)
        self.c_l = dot(pivot, self.m_l) + rb    # edge line: X . m = c
        self.c_r = dot(pivot, self.m_r) + rb
        self.large = 1 if rt > rb else 0       # tip arc exceeds 180 deg when tapered out


def meet(m1, c1, m2, c2):
    det = m1[0] * m2[1] - m1[1] * m2[0]
    return (c1 * m2[1] - c2 * m1[1]) / det, (m1[0] * c2 - m2[0] * c1) / det


def frond_path(pivot, rays):
    """rays: [(angle, length, rb, rt)] -> SVG path data for their union."""
    rs = sorted((Ray(pivot, *r) for r in rays), key=lambda r: r.angle % 360)
    n = len(rs)
    notch = [meet(rs[i].m_r, rs[i].c_r, rs[(i + 1) % n].m_l, rs[(i + 1) % n].c_l)
             for i in range(n)]
    d = [f"M{pt(notch[-1])}"]
    for i, r in enumerate(rs):
        a, b = add(r.tip, r.m_l, r.rt), add(r.tip, r.m_r, r.rt)
        d.append(f"L{pt(a)}A{fmt(r.rt)} {fmt(r.rt)} 0 {r.large} 1 {pt(b)}")
        if i < n - 1:
            d.append(f"L{pt(notch[i])}")
    d.append("Z")
    return "".join(d)


def extent(pivot, rays):
    """Bounding box (x0, y0, x1, y1) of the union."""
    xs, ys = [], []
    for ang, length, rb, rt in rays:
        t = add(pivot, unit(ang), length)
        xs += [t[0] - rt, t[0] + rt, pivot[0] - rb, pivot[0] + rb]
        ys += [t[1] - rt, t[1] + rt, pivot[1] - rb, pivot[1] + rb]
    return min(xs), min(ys), max(xs), max(ys)


def fan(n, step):
    """n evenly stepped angles centred on 0, e.g. fan(7, 22) -> -66 .. 66."""
    return [step * (i - (n - 1) / 2) for i in range(n)]


def outline(pivot, rays, steps=24):
    """The union as a polygon (arcs sampled), for area and centroid checks."""
    rs = sorted((Ray(pivot, *r) for r in rays), key=lambda r: r.angle % 360)
    n = len(rs)
    pts = []
    for i, r in enumerate(rs):
        a0 = math.atan2(r.m_l[1], r.m_l[0])
        a1 = math.atan2(r.m_r[1], r.m_r[0])
        while a1 <= a0:
            a1 += 2 * math.pi
        for k in range(steps + 1):
            a = a0 + (a1 - a0) * k / steps
            pts.append((r.tip[0] + r.rt * math.cos(a), r.tip[1] + r.rt * math.sin(a)))
        nx = rs[(i + 1) % n]
        pts.append(meet(r.m_r, r.c_r, nx.m_l, nx.c_l))
    return pts


def centroid(pts):
    a = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        k = x0 * y1 - x1 * y0
        a += k
        cx += (x0 + x1) * k
        cy += (y0 + y1) * k
    return cx / (3 * a), cy / (3 * a), abs(a) / 2
