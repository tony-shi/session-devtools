---
name: todo-scan
description: 扫描当前 repo 里的 TODO/FIXME/XXX/HACK 注释，按文件分组输出 markdown 表格。当用户询问"有哪些待办"、"还有什么没做"、"tech debt 盘点"、"扫一下 TODO"或类似意图时使用。
---

# Todo Scan

## 任务

1. 在当前工作目录执行：

   ```bash
   grep -rEn "(TODO|FIXME|XXX|HACK)" \
     --include="*.ts" --include="*.tsx" \
     --include="*.js" --include="*.jsx" \
     --include="*.py" --include="*.go" \
     --include="*.rs" --include="*.java" \
     --exclude-dir=node_modules --exclude-dir=dist \
     --exclude-dir=.git --exclude-dir=build \
     .
   ```

2. 按文件路径分组，每个文件一个二级标题
3. 在每个分组下输出 markdown 表格，列为：`行号 | 类型 | 内容`
4. 文末给出每种类型的总数

## 约束

- 纯只读，禁止修改任何文件
- 内容超过 80 字符的截断显示，末尾加 `…`
- 如果没扫到任何标注，明确告诉用户"未发现 TODO/FIXME/XXX/HACK 标注"
