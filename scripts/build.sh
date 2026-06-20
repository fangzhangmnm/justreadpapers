#!/usr/bin/env bash
# scripts/build.sh —— src/main.ts → dist/jrp-<hash>.mjs；in-place 改 index.html 引新 hash
# （注：bundle 名是 jrp-；service-worker.js 的 install/precache regex 必须跟这个名一致）
#
# 用法：编辑 src/ → 跑这个 → git commit && git push origin main
# 工具链抄 WebPaint（scripts/build.sh）；JRP 改了 ENTRY 和 bundle 名。

set -euo pipefail
cd "$(dirname "$0")/.."

ENTRY="./src/main.ts"
OUT_DIR="./dist"
ESBUILD_VER="0.24.0"
ESBUILD="./tools/esbuild/esbuild"

# 没 esbuild 自动 curl 一份（tools/esbuild/ gitignored）。
# tools/ = 构建工具；src/vendor/ = 运行时 lib（pdf.js, msal）。两个目录不混。
if [ ! -x "$ESBUILD" ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)   plat="linux-x64" ;;
    Linux-aarch64)  plat="linux-arm64" ;;
    Darwin-arm64)   plat="darwin-arm64" ;;
    Darwin-x86_64)  plat="darwin-x64" ;;
    *) echo "[build] 未知平台 $(uname -s)-$(uname -m)，手 vendor esbuild 进 $ESBUILD" >&2; exit 1 ;;
  esac
  echo "[build] 拉 esbuild $plat-$ESBUILD_VER..."
  mkdir -p tools/esbuild
  TMP=$(mktemp -d)
  curl -sL "https://registry.npmjs.org/@esbuild/${plat}/-/${plat}-${ESBUILD_VER}.tgz" | tar -xz -C "$TMP"
  mv "$TMP/package/bin/esbuild" "$ESBUILD"
  chmod +x "$ESBUILD"
  rm -rf "$TMP"
fi

mkdir -p "$OUT_DIR"
TMP_OUT="$OUT_DIR/jrp-tmp.mjs"

# 0. 类型检查门（tsc --noEmit 当构建前置硬门；esbuild 只 strip 类型不检查）。
#    没装 tsc（裸 clone 未 npm i）→ 大声警告但不挡构建；装了就强制过。
TSC="./node_modules/.bin/tsc"
if [ -x "$TSC" ]; then
  echo "[build] 类型检查 tsc --noEmit…"
  "$TSC" --noEmit -p tsconfig.json || { echo "[build] ✗ 类型检查失败，已挡下构建（修类型或先 git stash）。" >&2; exit 1; }
  echo "[build] ✓ 类型通过"
else
  echo "[build] ⚠ 未装 tsc（node_modules 缺）——跳过类型检查。装一下：npm install" >&2
fi

# 1. esbuild bundle 到临时名
"$ESBUILD" "$ENTRY" \
  --bundle --format=esm --target=es2020 \
  --minify --sourcemap=linked \
  --tree-shaking=true \
  --outfile="$TMP_OUT"

# 2. content hash 截 12 位作文件名
HASH=$(sha256sum "$TMP_OUT" | awk '{print substr($1, 1, 12)}')
OUT="$OUT_DIR/jrp-$HASH.mjs"

# 3. mv 到最终名
mv "$TMP_OUT"     "$OUT"
mv "$TMP_OUT.map" "$OUT.map"

# 老 hashed bundle 清掉，不堆积
find "$OUT_DIR" -maxdepth 1 -name 'jrp-*.mjs' -not -name "jrp-$HASH.mjs" -delete
find "$OUT_DIR" -maxdepth 1 -name 'jrp-*.mjs.map' -not -name "jrp-$HASH.mjs.map" -delete

# 4. sed 改 index.html 里引用，指向新 hash
if grep -q 'src="./dist/jrp-' index.html; then
  sed -i "s|src=\"./dist/jrp-[A-Za-z0-9-]*\\.mjs\"|src=\"./dist/jrp-$HASH.mjs\"|" index.html
else
  echo "[build] 警告：index.html 里没找到 ./dist/jrp-*.mjs script tag" >&2
fi

size=$(stat -c%s "$OUT" 2>/dev/null || wc -c < "$OUT")
echo "[build] $OUT ($size bytes, hash=$HASH)"
echo "[build] 完成。提交：git add . && git commit && git push origin main"
