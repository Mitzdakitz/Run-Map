import random

from ascent import ascent_descent, ascent_descent_from_coords


def test_noisy_flat_line_gives_near_zero_ascent():
    rng = random.Random(1)
    series = [100.0 + rng.uniform(-2.0, 2.0) for _ in range(500)]
    gain, loss = ascent_descent(series)
    assert gain < 5.0
    assert loss < 5.0


def test_steady_100m_climb_gives_about_100m():
    series = [i * 100.0 / 199 for i in range(200)]
    gain, loss = ascent_descent(series)
    assert 95.0 <= gain <= 105.0
    assert loss < 1.0


def test_100m_climb_with_2m_noise_still_gives_about_100m():
    rng = random.Random(7)
    series = [i * 100.0 / 199 + rng.uniform(-2.0, 2.0) for i in range(200)]
    gain, loss = ascent_descent(series)
    assert 90.0 <= gain <= 115.0
    assert loss < 15.0


def test_descent_is_counted_separately():
    up = [i * 50.0 / 99 for i in range(100)]
    down = [50.0 - i * 50.0 / 99 for i in range(100)]
    gain, loss = ascent_descent(up + down)
    assert 45.0 <= gain <= 52.0
    assert 45.0 <= loss <= 52.0


def test_short_or_empty_series_is_zero():
    assert ascent_descent([]) == (0.0, 0.0)
    assert ascent_descent([12.0]) == (0.0, 0.0)


def test_reads_elevation_from_ors_style_coords():
    coords = [[-1.50, 53.37, i * 100.0 / 99] for i in range(100)]
    gain, _ = ascent_descent_from_coords(coords)
    assert 95.0 <= gain <= 105.0
