# Encoding specification v0.1

Depth → audio + haptics, as maths. Language-independent, because this gets implemented three times (TypeScript in the browser, Swift on the phone, C++ on the ESP32) and all three must produce identical output. `sonification/encoder.js` is the reference implementation; `sonification/vectors.json` holds input→output pairs every port must reproduce.

**This document is the product.** Sensors and enclosures are how it gets delivered.

## Input

A **sector map**: `S` nearest-distance values, one per angular sector, in metres, head-relative.

- `S = 8` sectors, each 45° wide. Sector 0 is centred on straight ahead; index increases clockwise viewed from above.
- Sector *k* covers bearing `[k·45° − 22.5°, k·45° + 22.5°]`.
- A sector with no return is `Infinity` (unknown), which is **not** the same as "clear". The distinction matters: unknown means the sensor got nothing back, which happens for glass and for a drop-off.
- Bearings are relative to head forward, so head rotation is already applied upstream. Turning the head must rotate the soundscape.

## Parameters

| Symbol | Value | Meaning |
|---|---|---|
| `d_min` | 0.30 m | below this, saturated |
| `d_max` | 4.00 m | beyond this, silent |
| `γ` | 1.6 | proximity curve exponent |
| `N_active` | 3 | how many sectors may sound at once |
| `f_base` | 220 Hz | carrier for sector 0 |
| `r_min`, `r_max` | 2, 14 Hz | tremolo rate at far / near |

## Stage 1 — proximity

For each sector, normalised proximity `p ∈ [0,1]`:

```
p = clamp01((d_max − d) / (d_max − d_min)) ^ γ
```

`p = 0` for `d = Infinity`. The exponent γ makes the response deliberately non-linear: near objects dominate, far ones sit quietly under them. Linear mapping produces a wall of undifferentiated noise in a cluttered room.

## Stage 2 — salience gating

Sort sectors by `p` descending; keep the top `N_active` with `p > 0.02`, silence the rest.

This is the single most important rule in the spec. A corridor returns something in all 8 sectors at all times, and sonifying all 8 is unlistenable and exhausting. The user needs the nearest few things, not a complete depth map.

## Stage 3 — audio parameters

Per surviving sector *k* at proximity *p*:

| Parameter | Formula | Rationale |
|---|---|---|
| Gain | `p` | closer = louder |
| Pan | `sin(bearing_k)` | bearing → inter-aural difference |
| Carrier | `f_base · 2^(elev/12)` | elevation → pitch, vOICe convention |
| Tremolo rate | `r_min + p·(r_max − r_min)` | closer = faster pulse |
| Tremolo depth | `0.35 + 0.45·p` | closer = more insistent |

Bearing is carried **only** by pan and by the front/back timbre cue below — never by which transducer is energised. See ADR 0001: bone conducts across the whole skull, so contact point carries no directional information.

**Front/back disambiguation.** Pan alone is ambiguous — a sound 45° front-right and one 135° back-right produce the same inter-aural difference. Rear sectors are therefore low-passed at 1.2 kHz, mimicking the pinna shadowing that makes real rear sources sound duller. Without this, "behind me" and "in front of me" are indistinguishable.

## Stage 4 — haptics

Independent of audio and deliberately coarser. 4 motors at the quadrants (front, right, back, left). Motor *m* takes the max proximity of the sectors overlapping its quadrant, with a steeper curve (`p^2.2`) and a floor at 0.25, so it only speaks about things that are genuinely close.

Haptics are the redundant channel. If audio is masked by traffic, or the user has turned it down, the quadrant motors still convey the urgent case.

## Open questions for M0

- Is γ = 1.6 right, or does it need to change with clutter?
- Is `N_active = 3` correct? Test 1, 2, 3, 5, 8.
- Does the elevation→pitch mapping help, or is it just confusing on top of everything else?
- **Does stereo panning survive bone conduction at all?** Must be tested on a real bone-conduction headset. If it doesn't, bearing moves entirely to haptics and this spec changes fundamentally.
