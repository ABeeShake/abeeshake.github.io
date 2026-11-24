#!/usr/bin/env python3
"""Prepare a track for the site's audio visualizer.

Usage:
    python3 tools/prepare_track.py path/to/track.wav slug

Writes, relative to the site root:
    assets/audio/<slug>.mp3         320 kbps MP3 for streaming
    assets/audio/<slug>.peaks.json  waveform overview with low / mid / high band energies

Needs ffmpeg on the PATH and numpy.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

SR = 44100
BINS = 2000                     # overview resolution, independent of track length
BANDS = [(20, 200), (200, 2500), (2500, 16000)]  # low, mid, high in Hz


def decode(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "2", "-ar", str(SR), "-"],
        check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype="<f4").reshape(-1, 2)


def overview(x):
    mono = x.mean(axis=1)
    n = len(mono)
    edges = np.linspace(0, n, BINS + 1).astype(int)
    peak, rms, bands = [], [], [[] for _ in BANDS]
    for a, b in zip(edges[:-1], edges[1:]):
        seg = x[a:b]
        m = mono[a:b]
        peak.append(float(np.abs(seg).max()) if len(seg) else 0.0)
        rms.append(float(np.sqrt(np.mean(m ** 2))) if len(m) else 0.0)
        if len(m) < 64:
            for lst in bands:
                lst.append(0.0)
            continue
        spec = np.abs(np.fft.rfft(m * np.hanning(len(m)))) ** 2
        freqs = np.fft.rfftfreq(len(m), 1 / SR)
        for lst, (lo, hi) in zip(bands, BANDS):
            lst.append(float(np.sqrt(spec[(freqs >= lo) & (freqs < hi)].sum())))
    # Each band is scaled to its own 99th percentile so the colours stay readable.
    out_bands = []
    for lst in bands:
        arr = np.array(lst)
        ref = np.percentile(arr, 99) or 1.0
        out_bands.append(np.clip(arr / ref, 0, 1))
    r = lambda arr: [round(float(v), 3) for v in arr]
    return {
        "duration": round(n / SR, 3),
        "bins": BINS,
        "peak": r(np.clip(peak, 0, 1)),
        "rms": r(np.clip(rms, 0, 1)),
        "low": r(out_bands[0]), "mid": r(out_bands[1]), "high": r(out_bands[2]),
    }


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, slug = Path(sys.argv[1]), sys.argv[2]
    out = Path(__file__).resolve().parent.parent / "assets" / "audio"
    out.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-codec:a", "libmp3lame",
                    "-b:a", "320k", "-ar", str(SR), str(out / f"{slug}.mp3")], check=True)
    (out / f"{slug}.peaks.json").write_text(json.dumps(overview(decode(src)), separators=(",", ":")))
    print(f"Wrote {out / (slug + '.mp3')} and {out / (slug + '.peaks.json')}")


if __name__ == "__main__":
    main()
