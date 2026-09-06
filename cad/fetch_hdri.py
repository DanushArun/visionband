"""
Downloads the studio environment used for photoreal renders.

    python3 cad/fetch_hdri.py

Poly Haven, CC0. An HDRI is what makes a product render read as photographed
rather than computed: glossy plastic reflects a real room with real softbox
shapes and falloff, which no amount of point lights reproduces.

Lands in cad/assets/, which is gitignored.
"""

import os
import sys
import urllib.request

NAME = "brown_photostudio_02"
RES = "2k"  # 4k is 4× the bytes for no visible gain at these framings
URL = f"https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/{RES}/{NAME}_{RES}.hdr"

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")
PATH = os.path.join(ASSETS, f"{NAME}_{RES}.hdr")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0 Safari/537.36")


def fetch():
    if os.path.exists(PATH) and os.path.getsize(PATH) > 1_000_000:
        print(f"already have {PATH} ({os.path.getsize(PATH) / 1e6:.1f} MB)")
        return PATH

    os.makedirs(ASSETS, exist_ok=True)
    print(f"downloading {URL}")
    req = urllib.request.Request(URL, headers={"User-Agent": UA})
    tmp = f"{PATH}.part"
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as out:
        total = int(resp.headers.get("content-length", 0))
        done = 0
        while chunk := resp.read(1 << 16):
            out.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r  {done * 100 // total:3d}%  {done / 1e6:5.1f} / "
                      f"{total / 1e6:.1f} MB", end="", flush=True)
    print()
    os.replace(tmp, PATH)
    print(f"wrote {PATH}")
    return PATH


if __name__ == "__main__":
    try:
        fetch()
    except Exception as exc:  # noqa: BLE001
        print(f"failed: {exc}", file=sys.stderr)
        print("The renderer falls back to procedural softboxes without it.",
              file=sys.stderr)
        sys.exit(1)
