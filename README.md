# VisionBand

A 360° spatial-awareness headband for blind users. Ranging sensors around the head feed a continuous proximity soundscape through bone conduction, with vibrotactile as a coarse secondary channel.

It **complements a white cane** — it does not replace one. A cane gives physical ground contact that no sensor package reliably replicates. VisionBand covers what a cane structurally cannot: head-height hazards, objects to the side and behind, and open space beyond arm's reach.

No implant. Everything routes through existing hearing and touch.

<img width="3024" height="1898" alt="Screenshot 2026-09-02 at 10 18 33 AM" src="https://github.com/user-attachments/assets/f932c33e-6576-4ce1-8e64-5a0450380734" />


## Where the project is

**M0 — simulation.** Proving in software that ranging sensors on a head can reconstruct a usable picture of a room, and that the picture can be heard. No hardware has been bought, and none will be until M0's gates pass.

```
M0  simulation          ← here
M1  phone prototype
M2  bench hardware
M3  form factor
M4  PCB + enclosure
M5  validation with blind users
```

Each stage costs roughly 10× the one before it. Each exists to kill the idea cheaply before you pay for the next.

## Running the simulator

```bash
# ES modules need a server; opening index.html directly will not work
python3 -m http.server 8000
open http://localhost:8000/sim/
```

Or build the standalone single file, which runs from anywhere:

```bash
node tools/bundle.mjs
open dist/visionband-sim.html
```

What you are looking at: the **left panel** is the room as it really is; the **right panel** is only what the sensors returned, accumulated into a decaying occupancy map. The gap between the two is the point of the exercise. The bars below are the sector map being sonified — dimmed bars are detected but deliberately gated out, because sonifying all eight at once is unlistenable.

The visual reconstruction is a **debugging instrument, not a user feature**. The user is blind. It exists so that failure is diagnosable by eye instead of inferred from beeps.

## Tests

```bash
node --test sonification/encoder.test.mjs
```

The encoder gets implemented three times — TypeScript here, Swift on the phone, C++ on the ESP32. `sonification/vectors.json` is the golden file all three must reproduce. Without it you end up with three subtly different devices and no way to tell which one you tested.

Regenerate the vectors only after a deliberate spec change, never to make a failing test pass:

```bash
node sonification/generate-vectors.mjs
```

## Layout

```
docs/
  00-requirements.md   measurable targets and explicit non-goals
  01-encoding-spec.md  depth → sound, as maths. The core document.
  03-test-protocol.md  how each gate is judged
  decisions/           ADRs
sim/                   M0 simulator (three.js, no build step)
sonification/          the encoder — reference impl, tests, golden vectors
tools/                 bundler
```

## Findings so far

- **4 sensors is not enough.** At 63° nominal FOV an 8×8 zone grid only *samples* ±27.6°, so four sensors leave a 35° blind gap — failing requirement F3 (≤15°). Six leave 5°. The simulator produced this number; guesswork would not have.
- **A down-pitched ground sensor is mandatory.** Horizontal sensors return nothing where the floor stops, and "no return" is indistinguishable from open space. Without it a drop-off is invisible.
- **Bearing cannot be encoded by transducer placement.** Bone carries vibration across the whole skull, so both cochleae hear every transducer. Direction has to live in the signal. See `docs/decisions/0001`.
- **Front and back produce identical pan.** They are separated only by the rear low-pass filter, which makes timbre a load-bearing cue rather than a refinement. Gate C in the test protocol exists specifically to test whether it holds up.

## Status of the sensor model

The simulator ray-casts, so it proves geometry, coverage and encoding — **not sensor physics**. Multipath, ambient-IR washout in sunlight, specular reflection off glass and wet ground, retroreflection off signage, and cross-talk between units are all real and all only appear at M2 with hardware in hand. They are listed in `docs/decisions/0001`. A passed simulation is not a working sensor.
