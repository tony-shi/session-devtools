# /goal · 让 Claude 持续工作直到达成目标

> 来源：docs/en/goal.md

## 是什么

`/goal <condition>` 给当前 session 挂一个**完成条件 hook**——只要条件没满足，Claude 就不停（Stop hook 持续阻塞）。条件满足后 hook 自动清除，session 回到常态。

## 怎么演

```text
/goal 跑通所有 client/ 下的 vitest 单测，所有用例 pass
```

然后提一个任务：

```text
帮我修一下 SessionListV2 那个排序 bug
```

## 预期看到

- Claude 修改代码
- 跑 vitest
- 发现还有 fail → 继续改
- 直到全 pass → 自动停止（Goal 自动清除）
- 中间不会因为"我做完了一轮"就停

## 一句话解读

**`/goal` 把"我以为做完了"的判断权从 Claude 手里收走**，交给一个客观可验证的条件。适合"修到全绿 / build 跑通 / 某指标达标"这类有明确终止条件的任务。

## 易踩坑

- 条件**必须客观可验证**。"代码看起来更干净"这种主观条件，Claude 会自己判断为达成
- 想中途取消用 `/goal clear`
- 不要把 `/goal` 当 todo list 用——一次只挂一个条件
- Goal hook 是**阻塞性的**，机器会一直转，注意 token 成本

## 关联

- 我们当前 session 就在 `/goal` 下运行 —— 这本身就是个 demo
