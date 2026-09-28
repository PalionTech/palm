"""Minimal TrueType (glyf) reader: glyph outlines as SVG path data.

Enough for outlining the wordmark without fontTools: cmap format 4, simple
and offset-only composite glyphs, quadratic contours.
"""
import struct


class Font:
    def __init__(self, path):
        self.b = b = open(path, "rb").read()
        n = struct.unpack(">H", b[4:6])[0]
        self.t = {}
        for i in range(n):
            tag, _, off, ln = struct.unpack(">4sIII", b[12 + 16 * i:28 + 16 * i])
            self.t[tag.decode("latin-1")] = off
        h = self.t["head"]
        self.upm = struct.unpack(">H", b[h + 18:h + 20])[0]
        self.loca_long = struct.unpack(">h", b[h + 50:h + 52])[0] == 1
        m = self.t["maxp"]
        self.nglyphs = struct.unpack(">H", b[m + 4:m + 6])[0]
        hh = self.t["hhea"]
        self.nhm = struct.unpack(">H", b[hh + 34:hh + 36])[0]
        o = self.t["OS/2"]
        self.typo_asc, self.typo_desc = struct.unpack(">hh", b[o + 68:o + 72])
        self.x_height, self.cap_height = struct.unpack(">hh", b[o + 86:o + 90])
        self._cmap()

    def _cmap(self):
        b, c = self.b, self.t["cmap"]
        n = struct.unpack(">H", b[c + 2:c + 4])[0]
        for i in range(n):
            pid, eid, off = struct.unpack(">HHI", b[c + 4 + 8 * i:c + 12 + 8 * i])
            s = c + off
            if struct.unpack(">H", b[s:s + 2])[0] == 4 and (pid, eid) in ((3, 1), (0, 3), (0, 4)):
                break
        else:
            raise ValueError("no cmap format 4")
        segx2 = struct.unpack(">H", b[s + 6:s + 8])[0]
        seg = segx2 // 2
        ends = struct.unpack(f">{seg}H", b[s + 14:s + 14 + segx2])
        starts = struct.unpack(f">{seg}H", b[s + 16 + segx2:s + 16 + 2 * segx2])
        deltas = struct.unpack(f">{seg}h", b[s + 16 + 2 * segx2:s + 16 + 3 * segx2])
        ro_at = s + 16 + 3 * segx2
        ros = struct.unpack(f">{seg}H", b[ro_at:ro_at + segx2])
        self.cmap = {}
        for k in range(seg):
            for ch in range(starts[k], ends[k] + 1):
                if ch == 0xFFFF:
                    continue
                if ros[k] == 0:
                    g = (ch + deltas[k]) & 0xFFFF
                else:
                    a = ro_at + 2 * k + ros[k] + 2 * (ch - starts[k])
                    g = struct.unpack(">H", b[a:a + 2])[0]
                    g = (g + deltas[k]) & 0xFFFF if g else 0
                self.cmap[ch] = g

    def advance(self, gid):
        h = self.t["hmtx"] + 4 * min(gid, self.nhm - 1)
        return struct.unpack(">H", self.b[h:h + 2])[0]

    def _loca(self, gid):
        l = self.t["loca"]
        if self.loca_long:
            return struct.unpack(">II", self.b[l + 4 * gid:l + 4 * gid + 8])
        a, z = struct.unpack(">HH", self.b[l + 2 * gid:l + 2 * gid + 4])
        return 2 * a, 2 * z

    def contours(self, gid, dx=0, dy=0):
        """List of contours, each a list of (x, y, on_curve)."""
        a, z = self._loca(gid)
        if a == z:
            return []
        b, g = self.b, self.t["glyf"] + a
        nc = struct.unpack(">h", b[g:g + 2])[0]
        if nc < 0:                      # composite: offsets only
            out, p = [], g + 10
            while True:
                flags, sub = struct.unpack(">HH", b[p:p + 4]); p += 4
                if flags & 1:
                    ox, oy = struct.unpack(">hh", b[p:p + 4]); p += 4
                else:
                    ox, oy = struct.unpack(">bb", b[p:p + 2]); p += 2
                if flags & (8 | 0x40 | 0x80):
                    raise ValueError("scaled composite glyphs are not supported")
                out += self.contours(sub, dx + ox, dy + oy)
                if not flags & 0x20:
                    return out
        ends = struct.unpack(f">{nc}H", b[g + 10:g + 10 + 2 * nc])
        npts = ends[-1] + 1
        p = g + 10 + 2 * nc
        ilen = struct.unpack(">H", b[p:p + 2])[0]
        p += 2 + ilen
        flags = []
        while len(flags) < npts:
            f = b[p]; p += 1
            flags.append(f)
            if f & 8:
                flags += [f] * b[p]; p += 1
        coords = []
        for short, same in ((2, 16), (4, 32)):
            v, vals = 0, []
            for f in flags:
                if f & short:
                    d = b[p]; p += 1
                    v += d if f & same else -d
                elif not f & same:
                    v += struct.unpack(">h", b[p:p + 2])[0]; p += 2
                vals.append(v)
            coords.append(vals)
        pts = [(x + dx, y + dy, bool(f & 1)) for x, y, f in zip(coords[0], coords[1], flags)]
        out, s = [], 0
        for e in ends:
            out.append(pts[s:e + 1]); s = e + 1
        return out


def contour_path(c, tf):
    """One quadratic contour -> SVG path data; tf maps font (x, y) to SVG (x, y)."""
    n = len(c)
    start = next((i for i, q in enumerate(c) if q[2]), None)
    if start is None:                    # all off-curve: start at a midpoint
        c = [((c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2, True)] + c[1:] + c[:1]
        start, n = 0, len(c)
    c = c[start:] + c[:start]
    f = lambda q: "{} {}".format(*(f"{v:.2f}".rstrip("0").rstrip(".") for v in tf(q[0], q[1])))
    d = [f"M{f(c[0])}"]
    i = 1
    while i <= n:
        q = c[i % n]
        if q[2]:
            if i < n:
                d.append(f"L{f(q)}")
            i += 1
            continue
        nx = c[(i + 1) % n]
        end = nx if nx[2] else ((q[0] + nx[0]) / 2, (q[1] + nx[1]) / 2, True)
        d.append(f"Q{f(q)} {f(end)}")
        i += 2 if nx[2] else 1
    d.append("Z")
    return "".join(d)
