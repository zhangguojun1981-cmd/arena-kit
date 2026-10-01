# 模型指纹辅助识别（离线 MVP）

> 适用范围：当 Trigger trace 管线**无法**确认一个会话的真实模型名时，用一批结构化探针回答做**统计推断**，给出 `opus / fable / gpt6 / unknown` 的家族判断，必要且证据充分时再给出具体 `estimatedModel`。
>
> 这是**辅助**手段，不是真名来源。它永远不会覆盖服务端已确认的模型，不会把不同协议的概率合并，也不会把一次“魔法答案”当成判据。

## 为什么需要它

Arena Agent 模式下，可观测的文本流里**没有**可读取 run 的授权（trace 需要 Trigger JWT 的 run scope，而当前抓包里的 token 只有 `read:sessions`/`write:sessions`）。因此真名管线在 Agent 模式常常拿不到模型字段。用户明确接受“不可能 100% 正确”的统计识别作为补充（原始诉求：找 Opus 系 / Fable 系 / GPT‑6 系的指纹识别方案并落地）。

本模块就是这个补充：把“模型在随机数/偏好题上的分布偏好”当作弱指纹，和版本化的参考分布比对。

## 两个协议，严格分离

| 协议 | 类型 | 语义 | 参考来源 | 覆盖 |
|---|---|---|---|---|
| `modeltrace-long-integers-v1` | histogram（1..355，355 维） | 让模型生成一长串整数，取最长数字串，统计频率直方图 | [ModelTrace](https://github.com/xqy2006/ModelTrace)（MIT） | 当前 Opus 4.6/4.7/4.8/5/5.5 + GPT‑6 astra/sol/luna（**无 Fable**） |
| `fpverify-battery-v1` | categorical | 一套固定偏好题（随机数/颜色/动物/城市/硬币），聚成类别分布 | [fpverify](https://github.com/Mohamed7415/fpverify)（MIT, commit `bcd60d9`, channel `cursor-harness`） | Fable 5、Opus‑4.8‑thinking、GPT‑5.6‑sol（**无 Fable 5.1 / GPT‑6**） |

**硬性约束：两个协议的候选概率绝不相加、绝不合并成一个概率。** 它们的渠道、提示形态、采样条件完全不同，混合会制造虚假置信度。manifest 与两个 protocol 文件里都写明了这条。

## 判定内核（`src/lib/fingerprint.js`）

纯函数，无 DOM / IPC / 网络。调用方传入已解析的参考 bank 对象与一批回答，`classify()` 产出符合指纹 schema 的结果对象。

### 评分流程（histogram）

1. **解析**：`parseIntegers` 取最长整数串（字母分隔会断开 run，独立复现 ModelTrace 解析器），超出 `[1,355]` 丢弃。
2. **直方图 + 平滑**：`histogram` → `smoothedProbs`（add‑0.5，未见 bin 不归零）。
3. **白化（判别性关键）**：`whitenStats` 跨 bank 计算每个 bin 的均值/标准差，把每个模型的分布 z‑score 成 centroid。原始分布之间的 Bhattacharyya 重叠都在 0.97~0.99，几乎分不开；白化放大了模型**真正有差异**的少数 bin。这是复用 ModelTrace 的 nuisance‑projection 思路（只做对角版本，没有照搬其完整 ordered‑block 管线）。
4. **亲和度**：`affinityHistogram` = 样本白化向量到模型 centroid 的白化平方距离，`score=exp(-dist)`，`logScore=-dist`。
5. **家族 softmax**：每个家族取其最佳成员的 `logScore`，`exp(beta*(v-max))`，`beta=12`（ModelTrace 自己对多次回复标定到 12；单次回复它用 ≈7.2——我们用多回复值作为**未标定**默认）。`confidence = topW/totalW`，`margin = topW/secondW`。

### 评分流程（categorical）

每题在参考分布下的平滑似然，几何平均（mean log‑prob）跨已答题，保持长度无关。

### 四道防线（都是“宁可 unresolved 不要假阳性”）

1. **信号门槛**：histogram 要求 ≥ `minValidNumbers=80` 个有效整数；categorical 要求 ≥ `CATEGORICAL_MIN_QUESTIONS=3` 道已答题。
   - 直接后果：单个 `73`（Fable 和 Opus‑4.8‑thinking **都**会出）永远不足以判定。
2. **OOD 比值门（histogram 主防线）**：`uniformRatio = dist(样本, 均匀零假设) / dist(样本, 最佳模型)`。
   - 真实回答比“均匀噪声”更靠近某个模型 → 比值 > 1，且**随样本量增长**。
   - 均匀 PRNG 批次在任意 n 下比值都 ≤ 1。
   - 阈值 `minUniformRatio=1.05`。相比绝对分数地板，这个比值**不会惩罚短但真实**的回答，也更抗样本量变化。
   - 实测：noisy‑opus5 比值 1.02@300 → 1.56@1800；uniform 0.98→0.88。
3. **非目标家族即 unknown**：sonnet / haiku / gpt5 作为**负类**留在 bank 里。若最接近的是它们 → `family='unknown'`、`reason='closest-is-non-target'`，绝不强行套一个目标家族。闭集不得凭空制造目标。
4. **margin / confidence 门**：`minMargin=1.2`、`minConfidence=0.6`（移植自 arena‑local‑bridge PR#29，**未标定**）。

判定顺序（`classify`）：OOD 门 → 非目标门 → margin/confidence 门。任一不过都给出带 `reason` 的 `unresolved`，而不是硬判。

## 结果 schema

```
{
  schemaVersion: 1,
  sessionId,
  family: 'opus'|'fable'|'gpt6'|'unknown',
  estimatedModel: <id>|null,          // 仅在 attributed 且证据足够时
  candidates: [{ id, family, score, normalizedScore, samples, referenceVersion }],
  confidence, margin,
  status: 'attributed'|'unresolved'|'failed',
  source: 'fingerprint',              // 恒为 fingerprint，便于与服务端真名区分
  protocol: { id, version, promptSetHash, channel, reasoningTier, language },
  referenceBankVersion, probeCount, createdAt,
  reason?, error?
}
```

`sanitizeResult()` 保证序列化出去的对象**只有**上述字段：绝不夹带原始回答文本、token、header。测试 `fingerprint.test.mjs` 专门断言 token‑like / rawReply 不会出现在 JSON 里。

## 诚实边界（务必保留，不要在后续包装成“已验证准确率”）

- 所有引用的项目性能数字都是**作者自述**（交叉验证 / 模拟），**不是**独立的当前‑Arena 准确率。
- 交叉验证 ≠ 独立 Arena 准确率；家族分类 ≠ 精确版本识别；同厂商分类 ≠ **Opus 对 Fable** 的区分；低 JSD ≠ 权重相同；softmax 概率 ≠ 标定正确率；一个 token 的回答 ≠ 一次廉价查询。
- bundled 阈值全是**未标定默认值**（`calibrated:false`）。真正可用的准确率需要在**同模型、同渠道、同协议、同推理档位、同系统提示、同采样条件**下用真实 Arena 数据重新采集 + 标定。
- **Fable 5.1 没有同协议公开参考**，必须先补采才能做 Fable‑5.1 专属判定。
- Fable 的安全路由（部分任务回退 Opus）是混淆因素，不要用敏感题的拒答/路由作为唯一身份依据。

## 现状与后续（PR 拆分）

- **PR1（本次）**：离线判定内核 + 参考 bank + 测试。零模型调用、不碰 trace 授权、不持久化任何原文/凭证。← 已完成
- **PR2**：history 增加 `estimatedModel` 字段；model‑resolve 优先级（低于 live/history 真名，高于 title 猜测）；只读 dock UI 展示。
- **PR3**：页面侧回答归约 + 安全事件通道（仍不发送）；数据标定。
- **PR4**：主动探针（**需用户再次明确确认**，固定提示词 allowlist）。
- **PR5**：阈值标定。
