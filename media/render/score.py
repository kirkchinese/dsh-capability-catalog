"""Synthesize the 60 s promo soundtrack (48 kHz stereo WAV) aligned to promo.html's timeline.

Cues: dark pad (0-14 s) with a rising pulse and tick counter, riser into an impact at the title
(14.9 s), a brighter major pad for the solution, soft bells on each tool step (25/27.4/29.8 s),
a whoosh on scene changes, and a resolving swell that fades out at the end.
Usage: python3 score.py out.wav
"""
import sys
import wave

import numpy as np

SR = 48000
DUR = 60.0
N = int(SR * DUR)
t = np.arange(N) / SR
rng = np.random.default_rng(7)


def env(start, attack, hold, release):
    """Linear attack/hold/release envelope over the whole timeline."""
    e = np.zeros(N)
    a, h, r = start, start + attack, start + attack + hold
    end = r + release
    e += np.clip((t - a) / max(attack, 1e-6), 0, 1) * (t < h)
    e += ((t >= h) & (t < r)) * 1.0
    e += np.clip(1 - (t - r) / max(release, 1e-6), 0, 1) * (t >= r) * (t < end)
    return e


def note(freq):
    return 440.0 * 2 ** ((freq - 69) / 12)




def lowpass_fast(x, cutoff_hz):
    """Constant-cutoff one-pole low-pass via scipy-free IIR in blocks."""
    alpha = 1 - np.exp(-2 * np.pi * cutoff_hz / SR)
    y = np.empty_like(x)
    acc = 0.0
    block = 4096
    # Exact recursion, processed in Python blocks with numpy cumulative tricks is complex;
    # a short FIR approximation is enough for pads.
    taps = int(min(2048, max(16, 1.5 / alpha)))
    k = alpha * (1 - alpha) ** np.arange(taps)
    k /= k.sum()
    return np.convolve(x, k, mode='same')


def pad(chord, start, length, cutoff, gain, detune=0.12):
    out = np.zeros((N, 2))
    for i, m in enumerate(chord):
        f = note(m)
        for side, d in ((0, -detune), (1, detune)):
            ph = rng.uniform(0, 2 * np.pi)
            saw = 2 * ((f * (1 + d / 100) * t + ph / (2 * np.pi)) % 1) - 1
            out[:, side] += saw
    out /= len(chord)
    for side in (0, 1):
        out[:, side] = lowpass_fast(out[:, side], cutoff)
    e = env(start, min(2.5, length / 3), max(0, length - 2.5 - 2.0), 2.5)
    return out * e[:, None] * gain


mix = np.zeros((N, 2))

# Dark pad: D minor colors, 0-15 s
mix += pad([38, 50, 53, 57], 0.0, 15.2, 700, 0.22)
mix += pad([41, 53, 57, 60], 7.0, 8.2, 900, 0.12)

# Pulse (heartbeat-like sub) 6-14.6 s, accelerating
beats = []
tb = 6.0
interval = 0.72
while tb < 14.4:
    beats.append(tb)
    interval = max(0.34, interval * 0.95)
    tb += interval
for b in beats:
    m = (t >= b) & (t < b + 0.5)
    tt = t[m] - b
    freq = 58 * np.exp(-tt * 6) + 42
    mix[m] += (np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-tt * 9) * 0.42)[:, None]

# Counter ticks 7.8-12 s
for k in np.linspace(7.8, 12.0, 46):
    m = (t >= k) & (t < k + 0.03)
    tt = t[m] - k
    mix[m] += (np.sin(2 * np.pi * 2400 * tt) * np.exp(-tt * 160) * 0.08)[:, None]

# Riser 11.6-14.9 s: filtered noise sweeping up
noise = rng.normal(0, 1, (N, 2))
rise = env(11.6, 3.3, 0, 0.05) ** 2
riser = np.stack([lowpass_fast(noise[:, c], 2500) for c in (0, 1)], 1) * rise[:, None] * 0.16
mix += riser

# Impact at 14.9 s
m = (t >= 14.9) & (t < 17.5)
tt = t[m] - 14.9
boom = np.sin(2 * np.pi * np.cumsum(70 * np.exp(-tt * 3) + 36) / SR) * np.exp(-tt * 2.4) * 0.9
crash = lowpass_fast(rng.normal(0, 1, m.sum()), 6000) * np.exp(-tt * 3.5) * 0.3
mix[m] += (boom + crash)[:, None]

# Bright pad: D major / B minor / G major / A, 15-60 s
mix += pad([50, 57, 62, 66, 69], 15.0, 12.0, 1600, 0.26)
mix += pad([47, 54, 59, 62, 66], 26.0, 9.0, 1500, 0.25)
mix += pad([43, 55, 59, 62, 67], 34.0, 9.0, 1700, 0.25)
mix += pad([45, 57, 61, 64, 69], 42.0, 8.5, 1700, 0.25)
mix += pad([50, 57, 62, 66, 69, 74], 50.0, 10.0, 2000, 0.28)

# Soft bells on tool steps and on the -96.6% reveal
def bell(at, midi, gain=0.18):
    m = (t >= at) & (t < at + 2.6)
    tt = t[m] - at
    f = note(midi)
    s = (np.sin(2 * np.pi * f * tt) + 0.5 * np.sin(2 * np.pi * f * 2.01 * tt) + 0.25 * np.sin(2 * np.pi * f * 3.98 * tt)) * np.exp(-tt * 2.2)
    mix[m, 0] += s * gain
    mix[m, 1] += np.roll(s, 240) * gain

for at, midi in ((25.0, 74), (27.4, 78), (29.8, 81), (37.8, 86), (37.95, 81), (55.4, 74), (55.6, 78), (55.8, 81)):
    bell(at, midi)

# Whooshes at scene changes
for at in (21.2, 33.6, 41.4, 49.8):
    m = (t >= at) & (t < at + 0.9)
    tt = t[m] - at
    w = lowpass_fast(rng.normal(0, 1, m.sum()), 1800) * np.sin(np.pi * tt / 0.9) ** 2 * 0.22
    mix[m, 0] += w * (1 - tt / 0.9)
    mix[m, 1] += w * (tt / 0.9)

# Gentle 8th-note pluck groove 22-49 s to keep motion
bpm = 96
step = 60 / bpm / 2
seq = [62, 69, 66, 69, 59, 66, 62, 66]
k = 0
at = 22.0
while at < 49.0:
    midi = seq[k % len(seq)]
    m = (t >= at) & (t < at + 0.4)
    tt = t[m] - at
    s = np.sin(2 * np.pi * note(midi) * tt) * np.exp(-tt * 9) * 0.09
    mix[m, k % 2] += s
    mix[m, 1 - k % 2] += s * 0.6
    k += 1
    at += step

# Master: fade in/out, soft clip, normalize
master = env(0.0, 1.5, DUR - 1.5 - 2.5, 2.5)
mix *= master[:, None]
mix = np.tanh(mix * 1.2)
mix /= np.max(np.abs(mix)) / 0.89

out = sys.argv[1] if len(sys.argv) > 1 else 'score.wav'
with wave.open(out, 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix * 32767).astype('<i2').tobytes())
print('wrote', out)
