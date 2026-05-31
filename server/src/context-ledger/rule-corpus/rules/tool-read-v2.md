---
ruleId: claude-code.tool.Read.v2
slotId: tools.builtin
verifiedFor: "2.1.158"
appliesTo:
  minCcVersion: "2.1.158"
priority: 10
sourceUnits: []
description: "Claude Code 工具：Read。2.1.158 模板，exact 全文锚定（static，可复现）。desc 790B。"
stability: static
displayName: "Read"
summary: "工具定义：Read（2.1.158 版固定描述）"
sourcemapRef: 'proxy:9e1ba147 T3C2 (2.1.158.d60); ref: claude-code-system-prompts tool-description-read'
materialization: exact_text
attribution:
  patternFromBody: true
  trailingNewlines: 0
  matchMode: exact
  mechanism: tools_schema_pattern
  category: tools_schema
---
## pattern

```exact
Reads a file from the local filesystem.

- `file_path` must be an absolute path.
- Reads up to 2000 lines by default.
- When you already know which part of the file you need, only read that part. This can be important for larger files.
- Results are returned using cat -n format, with line numbers starting at 1
- Reads images (PNG, JPG, …) and presents them visually. Reads PDFs via the `pages` parameter (e.g. "1-5", max 20 pages/request; required for PDFs over 10 pages). Reads Jupyter notebooks (.ipynb) as cells with outputs.
- Reading a directory, a missing file, or an empty file returns an error or system reminder rather than content.
- Do NOT re-read a file you just edited to verify — Edit/Write would have errored if the change failed, and the harness tracks file state for you.
```
