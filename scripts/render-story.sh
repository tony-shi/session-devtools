#!/usr/bin/env bash
# 通用出片脚本 —— 任意 story 的 4K(--scale=2 → 3840×2160)/ 60fps:内挂 + 干净母带 + SRT。
# render-story1.sh 的参数化版,后续 story 复用,不再每集复制脚本。
#
#   bash scripts/render-story.sh <storyId> <CompId> <CompIdEn|-> [all|burned|clean|srt] [--scale=N]
#
#   storyId   旁白/SRT 用的 story id(STORIES 注册名,如 real-context)
#   CompId    zh composition id(如 RealContextStory)
#   CompIdEn  en composition id;传 - 表示无英文轨
#
# 例:
#   bash scripts/render-story.sh agent-loop   AgentLoopStory   AgentLoopStoryEn        # S1 全量
#   bash scripts/render-story.sh real-context RealContextStory RealContextStoryEn      # S2 全量
#   bash scripts/render-story.sh real-context RealContextStory RealContextStoryEn burned --scale=1
#     ↑ 1080p 校对版(出 4K 前先低成本全片走查;S2 的 rc-full 881 叶段渲染最慢)
#
# 注:4K@60fps 渲染较慢(单支约 15–25 分钟)。产物在 out/:
#   <storyId>-<lang>.mp4 / <storyId>-<lang>-clean.mp4 / <storyId>-<lang>.srt

set -euo pipefail
cd "$(dirname "$0")/.."

STORY="${1:?usage: render-story.sh <storyId> <CompId> <CompIdEn|-> [all|burned|clean|srt] [--scale=N]}"
COMP_ZH="${2:?missing zh composition id}"
COMP_EN="${3:?missing en composition id (or -)}"
MODE="${4:-all}"
SCALE="${5:---scale=2}"

ENTRY="src/studio/index.ts"
QUALITY="$SCALE --crf=16 --jpeg-quality=100 --log=info"

LANGS="zh"
[ "$COMP_EN" != "-" ] && LANGS="zh,en"

gen_srt() {
  echo "▶ 生成 SRT 外挂字幕($STORY $LANGS)…"
  npx tsx scripts/voice/export-srt.ts "$STORY" "$LANGS"
}

build_masters() {
  # 出片前重建母带单轨(--chunks:整段块优先,对齐失败步自动回退逐句;整条 loudnorm)。
  # 前置:synth-chunked + align-chunks 已跑过(sidecar 存在);没跑过会直接报错 fail-fast。
  echo "▶ 构建母带音轨($STORY $LANGS,chunked)…"
  npx tsx scripts/voice/master-audio.ts "$STORY" --lang zh --chunks
  [ "$COMP_EN" != "-" ] && npx tsx scripts/voice/master-audio.ts "$STORY" --lang en --chunks || true
}

render() {
  # $1 compositionId  $2 输出名  $3 lang  $4 caption(true/false)
  echo "▶ 渲染 $2  (lang=$3 · caption=$4 · master 音轨 · $SCALE/60fps)…"
  ( cd client && npx remotion render "$ENTRY" "$1" "../out/$2" \
      --props="{\"lang\":\"$3\",\"caption\":$4,\"audioMaster\":true}" $QUALITY )
}

burned() {
  render "$COMP_ZH" "$STORY-zh.mp4" zh true
  [ "$COMP_EN" != "-" ] && render "$COMP_EN" "$STORY-en.mp4" en true || true
}

clean() {
  render "$COMP_ZH" "$STORY-zh-clean.mp4" zh false
  [ "$COMP_EN" != "-" ] && render "$COMP_EN" "$STORY-en-clean.mp4" en false || true
  gen_srt
}

case "$MODE" in
  all)    build_masters; burned; clean ;;
  burned) build_masters; burned ;;
  clean)  build_masters; clean ;;
  srt)    gen_srt ;;
  *) echo "未知参数:$MODE(可用 all|burned|clean|srt)"; exit 2 ;;
esac

echo ""
echo "✓ 完成。out/ 下产物:$STORY-{zh,en}[.mp4|-clean.mp4|.srt]"
