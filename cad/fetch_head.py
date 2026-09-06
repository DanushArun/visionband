"""
Downloads the head mesh the headband is designed around.

    python3 cad/fetch_head.py

Blender Studio's Human Base Meshes bundle — CC0, so no attribution or licensing
constraint on anything built from it, and clean quad topology with the head as a
separate object. Lands in cad/assets/, which is gitignored: 50 MB of third-party
asset does not belong in the repo when it is one HTTP request away.

Plain Python, not a Blender script — Blender's bundled interpreter has no need to
be involved in a download.
"""

import hashlib
import os
import sys
import urllib.request
import zipfile

VERSION = "v1.4.1"
URL = (
    "https://download.blender.org/demo/asset-bundles/human-base-meshes/"
    f"human-base-meshes-bundle-{VERSION}.zip"
)
HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "assets")
ZIP_PATH = os.path.join(ASSETS, f"human-base-meshes-{VERSION}.zip")

# download.blender.org rejects the default urllib agent.
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0 Safari/537.36")


def download():
    if os.path.exists(ZIP_PATH) and os.path.getsize(ZIP_PATH) > 1_000_000:
        print(f"already have {ZIP_PATH} ({os.path.getsize(ZIP_PATH) / 1e6:.1f} MB)")
        return

    os.makedirs(ASSETS, exist_ok=True)
    print(f"downloading {URL}")
    req = urllib.request.Request(URL, headers={"User-Agent": UA})
    tmp = f"{ZIP_PATH}.part"
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as out:
        total = int(resp.headers.get("content-length", 0))
        done = 0
        while chunk := resp.read(1 << 16):
            out.write(chunk)
            done += len(chunk)
            if total:
                pct = done * 100 // total
                print(f"\r  {pct:3d}%  {done / 1e6:6.1f} / {total / 1e6:.1f} MB",
                      end="", flush=True)
    print()
    os.replace(tmp, ZIP_PATH)


def extract():
    with zipfile.ZipFile(ZIP_PATH) as zf:
        blends = [n for n in zf.namelist() if n.lower().endswith(".blend")]
        if not blends:
            print("no .blend inside the archive — contents:")
            for n in zf.namelist()[:40]:
                print("   ", n)
            sys.exit(1)
        for name in blends:
            target = os.path.join(ASSETS, os.path.basename(name))
            if not os.path.exists(target):
                with zf.open(name) as src, open(target, "wb") as dst:
                    dst.write(src.read())
            print(f"  {os.path.basename(name)}  "
                  f"{os.path.getsize(target) / 1e6:.1f} MB")
        return [os.path.join(ASSETS, os.path.basename(n)) for n in blends]


def main():
    download()
    digest = hashlib.sha256(open(ZIP_PATH, "rb").read()).hexdigest()[:16]
    print(f"sha256 (first 16): {digest}")
    print("extracted .blend files:")
    paths = extract()
    print("\nNext: cad/head.py appends the head from these and reports the "
          "object names it finds.")
    return paths


if __name__ == "__main__":
    main()
