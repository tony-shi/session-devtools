---
ruleId: claude-code.tool.NotebookEdit.v1
slotId: tools.builtin
verifiedFor: 2.1.126
sourceUnits: []
description: Claude Code 工具：NotebookEdit（编辑 Jupyter notebook）。description 513B。
stability: semi-static
sourcemapRef: 'binary:NotebookEdit tool (2.1.126)'
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
Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file) with new source. Jupyter notebooks are interactive documents that combine code, text, and visualizations, commonly used for data analysis and scientific computing. The notebook_path parameter must be an absolute path, not a relative path. The cell_number is 0-indexed. Use edit_mode=insert to add a new cell at the index specified by cell_number. Use edit_mode=delete to delete the cell at the index specified by cell_number.
```
