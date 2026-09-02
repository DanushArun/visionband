# Test protocol

How a milestone is judged passed. Every gate is a number someone can fail, run before moving on.

## M0 gate A — reconstruction legibility

**Question:** does accumulating ToF returns produce a picture a person can read?

1. Open the simulator, untick **Show truth panel**. You now see only what the device knows.
2. Let it run one full there-and-back pass (~30 s).
3. Without looking at ground truth, write down where you believe the **doorway**, the **pillar** and the **drop-off** are.
4. Tick the truth panel and score yourself.

**Pass:** all three identified, positions within 1 m.

Repeat with sensor counts 4, 6 and 8. Record the count at which it first passes — that number is the BOM decision, and it should be justified by this test rather than by intuition.

## M0 gate B — audible bearing and range

**Question:** can the soundscape be understood without sight?

Requires bone-conduction headphones. Air-conduction headphones will give an optimistic result and invalidate the trial, because the whole question is whether panning survives the skull.

1. Enable sound. Set voices to 3.
2. Screen off or eyes closed. Have someone else scrub the simulation to a random time, or run it unattended and call out at random moments.
3. Per trial, say aloud: the **sector** of the nearest object, and its **range bucket** (near <1 m / mid 1–2.5 m / far >2.5 m).
4. Check against the HUD's "Nearest" readout. 50 trials.

**Pass:** ≥80% correct on sector (±1 sector counts as correct), ≥80% correct on bucket.

Log each run below. If a run fails, change **one** encoder parameter and re-run — changing several at once tells you nothing about which mattered.

### Trial log

| Date | Encoding variant | Sensors | Voices | Sector % | Bucket % | Notes |
|---|---|---|---|---|---|---|
| | | | | | | |

## M0 gate C — front/back disambiguation

Sector 0 and sector 4 produce **identical pan**; only the rear low-pass separates them. This is the encoding's weakest point, so it gets its own test.

1. 20 trials, alternating randomly between an object directly ahead and directly behind at the same distance.
2. Say "front" or "back".

**Pass:** ≥75%. Below that, the low-pass cue is insufficient and the spec needs a stronger rear marker — a different waveform, or a delay, or moving bearing to the haptic channel entirely.

## Latency measurement (every milestone, N1 ≤150 ms)

1. Film at 240 fps: the moment an obstacle enters range, and the moment feedback begins.
2. Count frames between them; divide by 240.
3. Record the *worst* of 10 trials, not the mean. Users experience the worst case.

| Milestone | Worst-case latency | Pass |
|---|---|---|
| M0 | | |
| M1 | | |
| M2 | | |
| M3 | | |

## Human testing rules (M5, and any blindfolded trial before it)

Non-negotiable, from the first blindfolded walk onwards:

- The participant carries **their own cane**, always.
- A **sighted guide** is within arm's reach.
- **No roads, no stairs, no platform edges** during early testing.
- Written consent, and the participant can stop instantly without giving a reason.
- The device is never described to a participant as something that replaces a cane.
