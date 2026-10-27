"""把 gen-icons.mjs 生成的 PNG 打包成 icon.ico / icon.icns，并复制到 packages/desktop/build/。

用法（仓库根目录）：
    node scripts/brand/gen-icons.mjs .tools/brand/out
    python scripts/brand/pack-icons.py .tools/brand/out
依赖：Pillow。
"""
import shutil
import sys
from pathlib import Path

from PIL import Image

out = Path(sys.argv[1] if len(sys.argv) > 1 else ".tools/brand/out")
build = Path("packages/desktop/build")
ico_sizes = [16, 24, 32, 48, 64, 128, 256]

images = [Image.open(out / f"app-{size}.png") for size in ico_sizes]
images[-1].save(out / "icon.ico", sizes=[(s, s) for s in ico_sizes], append_images=images[:-1])
Image.open(out / "app-1024.png").save(out / "icon.icns")

shutil.copyfile(out / "app-1024.png", build / "icon.png")
shutil.copyfile(out / "icon.ico", build / "icon.ico")
shutil.copyfile(out / "icon.icns", build / "icon.icns")
for size in [16, 24, 32, 48, 64, 128, 256, 512, 1024]:
    shutil.copyfile(out / f"app-{size}.png", build / "icons" / f"{size}x{size}.png")
print(f"packed icons into {build}")
