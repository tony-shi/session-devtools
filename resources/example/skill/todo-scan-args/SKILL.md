---
name: todo-scan-args
description: 扫描指定目录下的 TODO/FIXME/XXX/HACK，可选限定文件扩展名。用法：/todo-scan-args <目录> 或 /todo-scan-args <目录> <扩展名>
arguments: [path, ext]
allowed-tools: Bash(grep *)
---

# Todo Scan (参数 + 预批准版)

在 `$path` 范围内扫描 TODO/FIXME/XXX/HACK，可选用 `$ext` 限定扩展名（不含点，如 `ts` / `go`）。

## 执行

如果 `$ext` 非空：

```bash
grep -rEn "(TODO|FIXME|XXX|HACK)" --include="*.$ext" "$path"
```

如果 `$ext` 为空，扫常见代码扩展：

```bash
grep -rEn "(TODO|FIXME|XXX|HACK)" \
  --include="*.ts" --include="*.tsx" \
  --include="*.js" --include="*.jsx" \
  --include="*.py" --include="*.go" \
  --include="*.rs" --include="*.java" \
  --exclude-dir=node_modules --exclude-dir=dist \
  --exclude-dir=.git --exclude-dir=build \
  "$path"
```

## 输出

按文件分组的 markdown 表格：`行号 | 类型 | 内容`。

## 约束

- 纯只读
- 内容超过 80 字符截断
- 如果 `$path` 不存在或没扫到，明确告知用户
- `allowed-tools: Bash(grep *)` 让 `grep` 在本 skill 激活期间免确认
