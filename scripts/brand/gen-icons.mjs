// 由 nek logo（G:/coding/nekcode/site/docs/public/logo.svg）生成应用图标母版。
// 用法：node scripts/brand/gen-icons.mjs <outDir>，再运行 scripts/brand/pack-icons.py <outDir>
import { createCanvas, Path2D } from "@napi-rs/canvas";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: node gen-icons.mjs <outDir>");
mkdirSync(outDir, { recursive: true });

const HEAD = "M10 54V14l14 12h16l14-12v40a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4Z";
const PROMPT = "M20 34l7 5-7 5v-3.2l3.2-1.8L20 37.2Zm11 10h12v3H31Z";
const PURPLE = "#6d4fc2";

/** 圆角矩形路径（squircle 近似）。 */
function roundedRect(ctx, x, y, size, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + size, y, x + size, y + size, radius);
  ctx.arcTo(x + size, y + size, x, y + size, radius);
  ctx.arcTo(x, y + size, x, y, radius);
  ctx.arcTo(x, y, x + size, y, radius);
  ctx.closePath();
}

/** 底板 + 居中 logo。`plate` 为底板占画布比例（macOS 网格约 0.805）。 */
function render(size, { plate, logo }) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const plateSize = size * plate;
  const offset = (size - plateSize) / 2;
  roundedRect(ctx, offset, offset, plateSize, plateSize * 0.225);
  const gradient = ctx.createLinearGradient(0, offset, 0, offset + plateSize);
  gradient.addColorStop(0, "#ffffff");
  gradient.addColorStop(1, "#efeaf9");
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.lineWidth = Math.max(1, size / 512);
  ctx.strokeStyle = "rgba(109, 79, 194, 0.18)";
  ctx.stroke();

  const logoSize = plateSize * logo;
  const scale = logoSize / 64;
  ctx.save();
  ctx.translate((size - logoSize) / 2, (size - logoSize) / 2 + logoSize * 0.02);
  ctx.scale(scale, scale);
  ctx.fillStyle = PURPLE;
  ctx.fill(new Path2D(HEAD));
  ctx.fillStyle = "#ffffff";
  ctx.fill(new Path2D(PROMPT));
  ctx.restore();
  return canvas.toBuffer("image/png");
}

/** 透明底的纯 logo（窗口内徽标、关于页）。 */
function renderMark(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const scale = size / 64;
  ctx.scale(scale, scale);
  ctx.fillStyle = PURPLE;
  ctx.fill(new Path2D(HEAD));
  ctx.fillStyle = "#ffffff";
  ctx.fill(new Path2D(PROMPT));
  return canvas.toBuffer("image/png");
}

const appSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
for (const size of appSizes) {
  // 小尺寸底板铺满，避免留白导致图标看起来过小
  const plate = size <= 48 ? 1 : 0.805;
  const logo = size <= 48 ? 0.8 : 0.72;
  writeFileSync(join(outDir, `app-${size}.png`), render(size, { plate, logo }));
}
for (const size of [64, 128, 256, 512]) {
  writeFileSync(join(outDir, `mark-${size}.png`), renderMark(size));
}
console.log(`generated ${appSizes.length} app icons and 4 marks in ${outDir}`);
