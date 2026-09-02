# VisionBand — requirements

Measurable targets. "Helps blind people" is not a requirement; everything here is a number someone can fail.

## What it is

A head-worn band carrying ranging sensors around 360°, feeding a continuous proximity soundscape through bone conduction, with vibrotactile as a coarse secondary channel.

## Non-goals — stated first, because they constrain everything

- **It does not replace a white cane.** The cane gives physical ground contact — surface texture, kerb edges, exact step position — that no sensor package reliably replicates. VisionBand is worn *alongside* a cane, always.
- **It does not occlude the ear canal.** Blind pedestrians navigate substantially by ambient sound. Any design that blocks hearing is a safety regression, no matter how good its own output is.
- **It does not touch the nervous system.** No implant, no electrode. Sensory substitution through existing hearing and touch only.
- **It is not a medical device** and makes no diagnostic or therapeutic claim.

## Functional requirements

| ID | Requirement | Target | Verified at |
|---|---|---|---|
| F1 | Angular resolution — user can name the bearing of an obstacle | ±22.5° (one of 8 sectors) | M0, M1 |
| F2 | Range resolution — user can name the range bucket | 3 buckets over 0.5–4 m | M0, M1 |
| F3 | Horizontal coverage | 360°, no dead sector wider than 15° | M0, M2 |
| F4 | Detection range | 0.3 m – 4.0 m | M2 |
| F5 | Head-height hazard detection (the cane's structural blind spot) | beam/sign at 1.7–2.1 m detected at ≥2 m | M0, M2 |
| F6 | Drop-off detection (step down, kerb, platform edge) | 0.15 m drop detected at ≥1.5 m | M0, M2 |
| F7 | Operates in total darkness | full performance at 0 lux | M2 |
| F8 | Semantic layer identifies objects ("parked car", "stairs") | best-effort, ≥0.5 Hz | M1 |

## Non-functional requirements

| ID | Requirement | Target | Verified at |
|---|---|---|---|
| N1 | End-to-end latency, obstacle appears → feedback begins | ≤150 ms | M0, M1, M2, M3 |
| N2 | Battery runtime, continuous use | ≥4 h | M3 |
| N3 | Mass on head | ≤200 g | M3 |
| N4 | Worn without pressure pain | ≥30 min | M3 |
| N5 | Bone-conduction output ceiling | hard-limited, no user override | M3 |
| N6 | Fast loop functions with no network | mandatory | M1 |
| N7 | Head sizing | 54–60 cm circumference | M4 |
| N8 | Target unit cost at small volume | ≤₹6,000 | M4 |

**N1 is the requirement that kills designs.** Feedback that lags is worse than no feedback, because the user learns to distrust it and then it is just noise on a head. Every milestone re-measures it; it only ever gets worse as the system grows.

## Operating envelope

- Indoor and outdoor pedestrian walking speed, ≤1.5 m/s.
- Ambient: 0–100k lux (direct Indian sunlight washes out infrared ToF — this is a real M2 risk, see the ADR).
- Weather: dry and light rain. Monsoon-proofing is deferred, and explicitly noted as unresolved.

## The two loops

The architecture splits by latency requirement, and the split is not negotiable:

| | Fast loop | Slow loop |
|---|---|---|
| Input | depth / range map | RGB frame |
| Rate | 15–30 Hz | 0.5–2 Hz |
| Output | soundscape + haptics | speech |
| Network | never | yes |
| Answers | "where is stuff" | "what is it" |
| Degrades to | silence | a stale sentence |

The fast loop must never wait on the slow one. Speech ducks under a fast-loop alert; it never queues ahead of it.
