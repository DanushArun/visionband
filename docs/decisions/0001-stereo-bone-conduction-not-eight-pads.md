# ADR 0001 — Direction lives in the signal, not in pad placement

**Status:** accepted
**Date:** 2026-09-02

## Context

The original concept, and the v3 3D model built from it, placed **8 bone-conduction transducers** around the headband — one per sector — on the assumption that the user would localise an obstacle by feeling *which pad* was active.

## Decision

Use **2 bone-conduction transducers** (left and right temple). Encode bearing in the *audio signal* via stereo panning, not in transducer placement. Keep **4 vibrotactile motors** at the quadrants, and let those carry physical position.

## Why

Bone conducts vibration across the entire skull. A transducer at the back-left temple excites **both** cochleae, at nearly the same time and amplitude. This is the well-known reason bone-conduction audio has poorer spatial imaging than air conduction — the two ears receive a far more similar signal than they would from a sound in the room. Contact point therefore carries almost no directional information, and 8 pads would have produced 8 sources that all sound like they are in the middle of the head.

The distinction that matters:

- **Hearing** localises by inter-aural differences in the *signal*. So direction must be encoded there — pan, level, timing.
- **Touch** localises by receptor position on the skin, which is spatially precise. So the haptic motors *can* carry direction by placement, and should.

## Consequences

- Transducer count 8 → 2. Materially cheaper, lighter, less power, far simpler to mount.
- The sonification encoder becomes the load-bearing component: bearing accuracy is now entirely a software property. This is why `docs/01-encoding-spec.md` and its test vectors exist.
- **Open risk:** if M0 shows that stereo panning cannot be localised *through the skull* even when encoded correctly, direction moves wholly to the haptic channel and audio becomes range-only. M0 must test this explicitly, on a real bone-conduction headset, not on air-conduction headphones.

## What simulation cannot settle

Recorded here so a passed M0 is never mistaken for a working sensor. These are real effects that only appear with hardware at M2:

- **Multipath** — infrared bouncing off two surfaces before returning, reporting a phantom object further away than either.
- **Ambient IR washout** — direct sunlight saturating the ToF receiver. Serious in Indian outdoor daylight; a plausible reason the outdoor case needs a different sensor entirely.
- **Specular reflection** — glass, polished granite, standing water. The beam leaves and never comes back, and the surface reads as empty space. Modelled crudely in the sim as a per-material dropout probability; the reality is angle-dependent and much less forgiving.
- **Retroreflection** — road signs and safety vests returning far more energy than expected, saturating a zone.
- **Cross-talk** — several ToF units firing into overlapping fields and reading each other's photons.
- **Skull-transmitted vibration** from the haptics contaminating the bone-conduction audio channel, since both are vibrating the same bone.
