"""The app icon, rasterised — `python3 src-tauri/icon.py`, then
`npx tauri icon src-tauri/icon.png` to cut the sizes `tauri.conf.json` names.
(That command also writes Windows, Android and iOS sets; this app bundles for macOS
only, and they are deleted.)

This file exists because the icon had **no source**. `icons/` held generated art
with nothing behind it, so its colour could not be changed without redrawing it.
There is no PIL, no ImageMagick and no rsvg here, and macOS's `qlmanage` composites
an SVG onto *white* — measured, not assumed — which for an icon is the one thing
that must not happen. So the shapes are analytic and this writes the PNG itself.

**The mark**: a compass needle, off its axis, north solid and south hollow, with an
arc sweeping round it and an arrowhead on the sweep. The drawing before all of this
was a ring, four ticks and an eight-point rose — five elements inside one tile,
which at 32 is a smudge. Two shapes of *different weight* is the difference: a solid
mass and a thin sweep read apart at any size, where five outlines of one weight do
not. The sweep's gap is centred on the direction the needle points, so the needle
runs out through the break rather than crossing the line.

**The tile** is Apple's: 824 of 1024, which is the macOS app-icon grid, and a
*squircle* — a superellipse, not a rounded rectangle. Circular corners beside the
real thing read as slightly swollen, and every other icon in that Dock is the real
thing. Every measurement below is a fraction of the tile, so the grid is the one
number to change.
"""
import math, struct, zlib

N = 1024
C = N / 2
TILE = 824.0              # the macOS app-icon grid, of 1024
HALF = TILE / 2
# The squircle's exponent: 2 is an ellipse and ∞ is a square. 5 is the shoulder
# macOS draws, which is the shape this icon is compared against in a Dock.
SQUIRCLE = 5.0

def of_tile(fraction):
    return fraction * TILE

# The needle stops well short of the sweep: at 32px the gap between them is what
# keeps the mark from reading as one blob, and 6% of the tile here is 2px there.
LENGTH = of_tile(0.286)   # centre to tip
WAIST = of_tile(0.093)    # centre to the widest point
LEAN_DEG = 28.0           # off vertical, so the needle reads as pointing
LEAN = math.radians(LEAN_DEG)
# One weight for both strokes — the needle's hollow half and the sweep. They were
# 34 and 26, which at a glance read as two hands drawing the same mark.
STROKE = of_tile(0.034)

# The sweep, in bearings: 0 is up and they run clockwise, like the needle's lean.
SWEEP_R = of_tile(0.391)
SWEEP_W = STROKE
GAP = 104.0                                 # centred on where the needle points
SWEEP_FROM = LEAN_DEG + GAP / 2             # clockwise from here...
SWEEP_TO = LEAN_DEG - GAP / 2 + 360.0       # ...round to here
# The head is built off the sweep's **tangent**, not off two more bearings. Bearings
# put its axis on the chord between them, which over ten degrees leans it half that
# out of true — the arrow read as rolled off the circle it belongs to. Base on the
# end of the sweep, so the shaft's round cap is inside the triangle.
HEAD_LENGTH = of_tile(0.086)
HEAD_HALF = of_tile(0.030)

TOP = (0xf8, 0xf8, 0xf5)
BOTTOM = (0xea, 0xea, 0xe4)
RIM = (0xd6, 0xd6, 0xcf)
INK = (0x12, 0x12, 0x15)


def bearing(deg, r):
    """A point at `r` from the centre, `deg` clockwise from straight up."""
    a = math.radians(deg)
    return (C + r * math.sin(a), C - r * math.cos(a))


def rotate(x, y):
    return (C + x * math.cos(LEAN) - y * math.sin(LEAN), C + x * math.sin(LEAN) + y * math.cos(LEAN))


NORTH = rotate(0.0, -LENGTH)
SOUTH = rotate(0.0, LENGTH)
EAST = rotate(WAIST, 0.0)
WEST = rotate(-WAIST, 0.0)


def toward(point, other, distance):
    """`point`, moved `distance` towards `other`."""
    dx, dy = other[0] - point[0], other[1] - point[1]
    step = distance / math.hypot(dx, dy)
    return (point[0] + dx * step, point[1] + dy * step)


# The filled half reaches two pixels past the waist it shares with the outlined one.
# A union of signed distances is `min`, and `min` is only right *outside* both
# shapes: on an edge they share, each reads zero, so the union reads zero too and
# the edge draws at half coverage — a pale seam through solid black. Two pixels of
# overlap put that edge inside both, where the union is unambiguous. Invisible
# either way: it is black over black.
NORTH_EAST = toward(EAST, SOUTH, 2.0)
NORTH_WEST = toward(WEST, SOUTH, 2.0)

def head(deg, length, half):
    """An arrowhead sitting on the sweep at `deg`, pointing the way it travels.

    Along the tangent, and `half` across the radius: the two directions the circle
    itself gives at that point, which is what makes the head look like part of it."""
    a = math.radians(deg)
    ex, ey = C + SWEEP_R * math.sin(a), C - SWEEP_R * math.cos(a)
    tx, ty = math.cos(a), math.sin(a)          # clockwise along the circle
    nx, ny = math.sin(a), -math.cos(a)         # outward from the centre
    return (
        (ex + tx * length, ey + ty * length),
        (ex + nx * half, ey + ny * half),
        (ex - nx * half, ey - ny * half),
    )


HEAD = head(SWEEP_TO, HEAD_LENGTH, HEAD_HALF)
SWEEP_ENDS = (bearing(SWEEP_FROM, SWEEP_R), bearing(SWEEP_TO, SWEEP_R))


def squircle(x, y, half):
    """Distance to a superellipse — negative inside.

    There is no closed form for it, so this is the implicit function divided by the
    length of its gradient: exact *at* the boundary and close enough either side of
    it, which is all an antialiased edge asks. Deep inside, the gradient goes to
    zero and the ratio stops meaning anything, so that case answers a flat
    "well inside".
    """
    ax, ay = abs(x - C) / half, abs(y - C) / half
    implicit = ax**SQUIRCLE + ay**SQUIRCLE - 1.0
    if implicit < -0.5:
        return -half
    gradient = math.hypot(
        SQUIRCLE * ax ** (SQUIRCLE - 1) / half, SQUIRCLE * ay ** (SQUIRCLE - 1) / half
    )
    return implicit / gradient if gradient else -half


def triangle(x, y, a, b, c):
    """Signed distance to a triangle: negative inside. Exact, so one sample a pixel
    antialiases it and the hollow half can be drawn by stroking `abs(d)`."""
    best, sides = float('inf'), []
    for (px, py), (qx, qy) in ((a, b), (b, c), (c, a)):
        ex, ey = qx - px, qy - py
        wx, wy = x - px, y - py
        t = max(0.0, min(1.0, (wx * ex + wy * ey) / (ex * ex + ey * ey)))
        best = min(best, math.hypot(wx - t * ex, wy - t * ey))
        sides.append(ex * wy - ey * wx)
    # Inside means the same side of all three edges — which side depends on the
    # winding, so it is not fixed here. Fixing it drew one of these two triangles as
    # a one-pixel outline, its fill lost to a vertex order.
    inside = all(s >= 0 for s in sides) or all(s <= 0 for s in sides)
    return -best if inside else best


def arc(x, y):
    """Signed distance to the sweep: the circle where the bearing is inside the
    range, and the nearer end cap where it is not — which is what rounds the tail."""
    dx, dy = x - C, y - C
    deg = math.degrees(math.atan2(dx, -dy)) % 360.0
    if deg < SWEEP_FROM:
        deg += 360.0
    if SWEEP_FROM <= deg <= SWEEP_TO:
        return abs(math.hypot(dx, dy) - SWEEP_R) - SWEEP_W / 2
    return min(math.hypot(x - ex, y - ey) for ex, ey in SWEEP_ENDS) - SWEEP_W / 2


def coverage(d):
    return max(0.0, min(1.0, 0.5 - d))


def over(dst, src, alpha):
    return tuple(round(s * alpha + d * (1 - alpha)) for s, d in zip(src, dst))


rows = []
margin = (N - TILE) / 2
lo, hi = int(margin) - 2, int(N - margin) + 2
for y in range(N):
    row = bytearray(N * 4)
    if lo <= y <= hi:
        t = min(max((y - margin) / TILE, 0.0), 1.0)
        ground = tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM))
        for x in range(lo, hi + 1):
            fx, fy = x + 0.5, y + 0.5
            edge = squircle(fx, fy, HALF)
            tile = coverage(edge)
            if tile <= 0:
                continue
            colour = ground
            # The rim rides the same curve rather than a second, smaller one: two
            # superellipses are not parallel, and the gap between them would open
            # at the shoulders.
            rim = coverage(abs(edge + 2.0) - 1.5)
            if rim > 0:
                colour = over(colour, RIM, rim)
            # **One coverage for the whole mark**, from the nearest of the four
            # shapes: `min` of signed distances is the union, and taking each
            # shape's coverage and `max`ing those is not. Where two of them meet
            # edge to edge — the needle's halves along their shared waist, the
            # arrowhead across the shaft — both were half covered and the union
            # came out at a half, drawing a pale seam through solid black. See
            # `NORTH_EAST` for the other half of that fix.
            #
            # North is filled. South is the same triangle outlined *inside* its own
            # edge, so the halves share one silhouette and both tips are mitred;
            # stroking the distance rounds the south tip instead, which leaves one
            # sharp point and one blunt one on a single needle.
            south = triangle(fx, fy, SOUTH, WEST, EAST)
            ink = coverage(
                min(
                    triangle(fx, fy, NORTH, NORTH_EAST, NORTH_WEST),
                    max(south, -(south + STROKE)),
                    arc(fx, fy),
                    triangle(fx, fy, *HEAD),
                )
            )
            if ink > 0:
                colour = over(colour, INK, ink)
            o = x * 4
            row[o], row[o + 1], row[o + 2] = colour
            row[o + 3] = round(255 * tile)
    rows.append(bytes(row))

raw = b''.join(b'\x00' + r for r in rows)


def chunk(kind, body):
    return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))


png = (
    b'\x89PNG\r\n\x1a\n'
    + chunk(b'IHDR', struct.pack('>IIBBBBB', N, N, 8, 6, 0, 0, 0))
    + chunk(b'IDAT', zlib.compress(raw, 9))
    + chunk(b'IEND', b'')
)
open('src-tauri/icon.png', 'wb').write(png)
print('wrote', len(png), 'bytes')
