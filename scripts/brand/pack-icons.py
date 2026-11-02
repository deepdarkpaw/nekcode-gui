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

for name in ["icon", "icon_installer"]:
    shutil.copyfile(out / "app-1024.png", build / f"{name}.png")
    shutil.copyfile(out / "icon.ico", build / f"{name}.ico")
    shutil.copyfile(out / "icon.icns", build / f"{name}.icns")
for name in ["icon_linux.png", "icon_windows.png"]:
    shutil.copyfile(out / "app-1024.png", build / name)
for name in ["dmg_background.png", "dmg_background@2x.png"]:
    shutil.copyfile(out / name, build / name)
for size in [16, 24, 32, 48, 64, 128, 256, 512, 1024]:
    shutil.copyfile(out / f"app-{size}.png", build / "icons" / f"{size}x{size}.png")
# renderer 内的应用标志：index.html 启动占位、启动徽标、关于页与 Windows 左上角共用这一张。
renderer_logo = Path("packages/desktop/src/renderer/public/logo/icons/512x512.png")
shutil.copyfile(out / "app-512.png", renderer_logo)
# UI 包按 import.meta.url 引用仓库根 public/ 的同一张图（侧栏、关于页、启动徽标、更新对话框），必须与上面保持一致。
shared_logo = Path("public/logo/icons/512x512.png")
shutil.copyfile(out / "app-512.png", shared_logo)
shutil.copyfile(out / "app-1024.png", Path("public/icon_512@2x.png"))
print(f"packed icons into {build}, {renderer_logo} and {shared_logo.parent.parent.parent}")
