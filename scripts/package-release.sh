#!/usr/bin/env bash
# 发布包装配 —— 把终态产物(mp4/SRT/母带)组织成 out/release/ 的平台目录结构。
# 视频/SRT/母带从渲染产物复制;封面与简介/description 是人工定稿件,已存在则保留不覆盖。
#
#   bash scripts/package-release.sh <storyId> <两位序号> <ep号>
#   例:bash scripts/package-release.sh agent-loop 01 1
#      bash scripts/package-release.sh real-context 02 2
#
# 前置:out/<storyId>-zh.mp4(硬字幕)、out/<storyId>-en-clean.mp4、out/*.srt、
#       client/public/voice/<storyId>/{zh,en}-master.m4a 均已存在。
# 封面:首次装配后自行放入 cover.png;简介.md/description.md 同理(模板见 01/ep1)。

set -euo pipefail
cd "$(dirname "$0")/.."

STORY="${1:?usage: package-release.sh <storyId> <两位序号> <ep号>}"
NUM="${2:?missing 两位序号(如 02)}"
EP="${3:?missing ep号(如 2)}"

BILI="out/release/bilibili/${NUM}-${STORY}"
YT="out/release/youtube/ep${EP}"
AM="out/release/audio-masters"
mkdir -p "$BILI" "$YT" "$AM"

cp "out/${STORY}-zh.mp4" "$BILI/"
cp "out/${STORY}-zh.srt" "$BILI/"
cp "out/${STORY}-en-clean.mp4" "$YT/"
cp "out/${STORY}-en.srt" "$YT/"
cp "client/public/voice/${STORY}/zh-master.m4a" "$AM/${STORY}-zh-master.m4a"
cp "client/public/voice/${STORY}/en-master.m4a" "$AM/${STORY}-en-master.m4a"

for f in "$BILI/cover.png" "$BILI/简介.md" "$YT/cover.png" "$YT/description.md"; do
  [ -f "$f" ] || echo "⚠ 缺人工件:$f(封面/简介需手工定稿放入)"
done
echo "✓ ${STORY} → ${BILI} + ${YT} + audio-masters/"
