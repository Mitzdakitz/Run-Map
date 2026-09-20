"""Ascent and descent from a 3D route geometry.

Raw elevation data jitters, and naively summing every upward step inflates
climb badly. Two defences, in the order a running watch applies them:

1. A short moving average, to take the edge off sample-to-sample noise.
2. Hysteresis: a climb is only counted once the run of gain since the last
   counted turning point exceeds ASCENT_THRESHOLD_M.
"""
from __future__ import annotations

from typing import Iterable, Sequence

import config


def smooth(values: Sequence[float], window: int) -> list[float]:
    """Centred moving average with shrinking windows at the ends."""
    values = list(values)
    if window <= 1 or len(values) <= 2:
        return values
    half = window // 2
    out = []
    for i in range(len(values)):
        lo = max(0, i - half)
        hi = min(len(values), i + half + 1)
        chunk = values[lo:hi]
        out.append(sum(chunk) / len(chunk))
    return out


def ascent_descent(
    elevations: Iterable[float],
    threshold_m: float | None = None,
    smoothing_window: int | None = None,
) -> tuple[float, float]:
    """Return (total ascent, total descent) in metres.

    `anchor` is the last confirmed turning point. `high` and `low` are the
    extremes seen since then. A direction is only confirmed, and the completed
    run only banked, once the series reverses by more than the threshold.
    """
    if threshold_m is None:
        threshold_m = config.ASCENT_THRESHOLD_M
    if smoothing_window is None:
        smoothing_window = config.ELEVATION_SMOOTHING_WINDOW

    series = [float(e) for e in elevations if e is not None]
    if len(series) < 2:
        return 0.0, 0.0
    series = smooth(series, smoothing_window)

    gain = 0.0
    loss = 0.0
    high = low = series[0]
    direction = 0  # 0 undecided, 1 climbing, -1 descending

    for e in series[1:]:
        if direction == 1:
            if e > high:
                high = e
            elif high - e >= threshold_m:
                # The climb from low up to high is over; bank it.
                gain += high - low
                direction = -1
                low = e
        elif direction == -1:
            if e < low:
                low = e
            elif e - low >= threshold_m:
                loss += high - low
                direction = 1
                high = e
        else:
            if e - low >= threshold_m:
                direction = 1
                high = e
            elif high - e >= threshold_m:
                direction = -1
                low = e
            else:
                high = max(high, e)
                low = min(low, e)

    # Bank whatever run was still in progress at the end.
    if direction == 1:
        gain += high - low
    elif direction == -1:
        loss += high - low

    return gain, loss


def ascent_descent_from_coords(coords: Sequence[Sequence[float]]) -> tuple[float, float]:
    """coords are ORS [lon, lat, elevation] triples."""
    return ascent_descent([c[2] for c in coords if len(c) >= 3])
