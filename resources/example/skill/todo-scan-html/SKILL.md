---
name: todo-scan-html
description: 把 TODO 扫描结果渲染成 HTML 报告并在浏览器打开。用法：/todo-scan-html [目录]
arguments: [path]
allowed-tools: Bash(python3 *)
---

# Todo Scan (HTML 报告)

调用本 skill 自带的渲染脚本，把扫描结果写成 `todo-report.html` 并在浏览器打开。

## 执行

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/render.py "${0:-.}"
```

- `${CLAUDE_SKILL_DIR}` 会被替换为本 SKILL.md 所在目录，**不受当前工作目录影响**
- `${0:-.}` 是第一个位置参数，没传就用 `.`

## 这一幕想展示什么

- skill 不只是 prompt，也可以**打包脚本**作为可执行能力
- `${CLAUDE_SKILL_DIR}` 让脚本路径在任何工作目录下都能解析
- 配 `allowed-tools: Bash(python3 *)` 后，调用免确认

## 约束

- 脚本是纯 stdlib Python 3，无需安装依赖
- 输出文件落在**当前工作目录**下的 `todo-report.html`
- 没扫到任何标注时，脚本输出一个 "no todos found" 的页面
