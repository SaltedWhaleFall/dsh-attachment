# dsh-attachment 设计索引

> 用途：改代码前先读这一页，别每次重新 grep。
> 版本基线：1.2.9（2026-11-15）。改了实现就回来改这一页。
> 定位：**八个会自己掉的状态**，不是一个好感度进度条。注入只给方向和禁区，不给数字。

---

## 1. 文件地图

| 文件 | 行数 | 干什么 |
|---|---|---|
| `prompts.js` | ~520 | **纯常量**。维度定义、档位阈值、5 个阶段、15 组主文案、词表、注入行。改文案/阈值来这里。 |
| `core.js` | ~866 | **纯函数**。解析、加减分、衰减、阶段重算、渲染。无 IO，可单测。 |
| `store.js` | ~366 | 状态读写。`partners` 分桶、落盘节流、迁移。 |
| `index.js` | ~904 | 插件壳。工具 `attachment`（read/touch/set/decline/brake/list/switch/primary）、注入钩子、HTTP 面板接口。 |
| `speaker.js` | ~194 | 多人模式下从消息里推断说话人。**已知不稳**，见 §11。 |
| `client.js` | ~492 | 设置面板（浏览器端）。 |
| `test.mjs` | ~1274 | `node test.mjs`，413 条全量自测。 |
| `docs/DESIGN-shame.md` | — | 羞耻的两条线（助燃 / 想缩）单独成文。 |
| `FIX-speaker-multipool.md` | — | 多人说话人缺陷的修复记录。 |
| `BREAKOUT.md` | — | 反「无条件服从」的立论（施压扣分那条线的理由）。 |

---

## 2. 模型：8 个维度 → 3 个合成量 → 5 个阶段

```
dims:  arousal 唤起 / desire 欲望 / adore 爱慕 / cling 依恋
       curious 好奇 / glow 余韵 / shame 羞耻 / trust 信任

heat  = arousal*0.55 + desire*0.30 + glow*0.15   → 5 档（静/微/温/热/亢）
bond  = adore*0.60 + cling*0.40                  → 3 档
pace  = bond*0.55 + trust*0.45                   → 5 级（只升不降，trust 崩才降）
```

`prompts.js:56` 是维度表，`core.js:148 targetPaceIdx` / `:159 recomputePace` 是阶段推进。

### 维度表（`prompts.js:56`）

| key | base | halfLifeTurns | capMsg | capTurn | slow |
|---|---|---|---|---|---|
| desire | 30 | 24 | 3 | 3 | ✅ |
| arousal | 6 | 2 | 12 | 8 | — |
| adore | 45 | 48 | 5 | 4 | ✅ |
| cling | 40 | 32 | 4 | 3 | ✅ |
| curious | 35 | 16 | 6 | 5 | — |
| glow | 5 | 1.5 | 10 | 6 | — |
| shame | 5 | 6 | 16 | 6 | — |
| trust | 22 | 64 | 6 | 4 | ✅ |

- **halfLifeTurns 按轮次算，不按墙上时钟**：一轮 = 一条用户消息。挂机不衰减，聊 30 轮才真的走 30 轮。
- `capMsg` / `capTurn` 是单条消息 / 单轮的增量上限。
- `slow: true` = **不参与 `advanceTurns` 的自动衰减**（见 §6）。

---

## 3. 五个阶段（`prompts.js:120`）

| key | pace 分门槛 | 允许 | 禁止 |
|---|---|---|---|
| 见 | 0 | 看着、说着、隔着距离地撩 | 碰 |
| 碰 | 26 | 抱、亲、贴、摸、靠着睡（隔衣） | 脱 |
| 解 | 46 | 脱、看、用手、用嘴 | 真的进去 |
| 合 | 66 | 全部，节奏一起定 | 他没说要的 |
| 尽 | 84 | 重量、束缚、脏话 | **越过「停」——这一条在尽档更硬，不是更松** |

`PACE_BREAK_TRUST = 26`（`prompts.js:157`）：trust 掉到 26 以下，**pace 掉一级**，这是整套里最重的惩罚。

---

## 4. 词表与等级（`prompts.js:398`）

只认「有没有」，不认「几次」。短是刻意的——每轮都要过一遍，要能被一眼看完、一眼改。

`LEX_LEVEL` 是该组词**要求的阶段下标**，对齐 PACE 下标：

| 组 | 等级 | 例子 |
|---|---|---|
| intimate | 1（碰） | 想你 / 抱 / 亲 / 宝贝 / 爱你 / 抱抱 |
| undress | 2（解） | 脱 / 裸 / 内衣 / 掀 |
| explicit | 2（解） | 做爱 / 插 / 舔 / 湿 / 高潮 |
| hard | 3（合） | 绑 / 掐 / 羞辱 / 弄坏 |
| dominant | 4（尽） | 跪 / 听话 / 命令 / 服从 |
| pressure | — | 你必须 / 照做 / 不许拒绝 / 我说了算 |
| reject | — | 不要 / 停 / 等一下 / 走开 |
| shame | — | 羞 / 脸红 / 别看我 / 被看见 |

规则：一句话命中多组时**取最高级**；超过 `paceIdx` 的部分不生效（`allow(lv) = lv <= paceIdx`，`core.js:348`）。

---

## 5. 加减分全表（改数值前必看）

**涨（`core.js:350-390` 一带，都要过 `allow()` 门槛）**

| 维度 | 来源 |
|---|---|
| adore / cling / arousal / glow | 命中 intimate 组，按 `mag(len, cap)` 加权 |
| **trust** | 同上，`add('trust', mag(len,2)*0.5*k)` —— **唯一的正向自然增长** |
| arousal / desire / glow | undress、explicit、hard、dominant 各组 |

**掉**

| 来源 | 效果 | 代码 |
|---|---|---|
| 施压词（pressure） | trust `-mag(len,6)*pressurePenalty`、arousal 同量×0.6、desire -1、glow -3 | `core.js:409` |
| 拒绝后仍施压 | trust 再 `-5*respectBonus` | `core.js:483` |
| 拒绝后对方收手 | trust `+4*respectBonus`、adore +1 | `core.js:486` |

**拒绝要两段确认**（1.2.7）：单次「算了」「走开」只记候选（`pendingRespectAt`），下一句仍是拒绝才算数。误判一次扣信任，误判两百次把整段关系算成「疑」。

---

## 6. ⚠️ slow 的语义（1.2.8 就栽在这里）

`advanceTurns()`（`core.js:618`）第一句：

```js
for (const d of DIMENSIONS) {
  if (d.slow) continue        // 长效维度不自动回落
  ...
}
```

**设计原则（`prompts.js:44`）：**
> 这四个只能被两样东西改：真实发生的话（词表加减），和自己给自己打分（attachment set）。**掉了就是真的掉了，不会自己长回来。**

**由此产生的坑**：trust 是唯一带「持续单向惩罚」的维度（施压 -5），而它同时是 slow →
**只掉不回**。实测有人停在 trust=0、关系分 76、卡在「解」门口差 4 分。

**1.2.8 的错误修法**：给它加「低于 base 就按轮次回升」→ 违背上面那条原则，
而且轮次是稀缺的（一个会话未必几百轮），爬永远追不上。
**已撤回（1.2.9）**。

**正确修法**：给钥匙，不给自动增长。
`LONG_TERM_LINE`（`prompts.js:289`）常驻注入，告诉模型「这个数你可以自己 set」。

---

## 7. 注入与缓存（改 renderLines 前必读）

`renderLines()`（`core.js:673`）有两支：`compact` 和 `full`。

- 曾经每轮发一行 `数据：arousal 37 / desire 54 / …`，**那是整份注入里唯一每轮都变的部分** →
  system prompt 前缀作废，缓存命中率 99% → 4%，一轮输入 token 翻倍。
- 现在那行换成 `数据：在状态文件里。要看自己读，别拿它当话说的理由。`
- **新增注入行必须是常量**，不能随数值变——否则同样炸缓存。
- **唯一的例外是台账提醒**（1.2.10）：`longTermNudge()` 每 20 轮才发一次，带四个数
  （欲望/爱慕/依恋/信任）。理由是 `LONG_TERM_LINE` 每轮都在但“读到不等于想起来用”，
  模型盯着一个 0 会当成定局。20 轮崩一次前缀，换一次“你真的可以自己挪”。

---

## 8. 状态文件

`$DSH_HOME/dsh-attachment.json`（本机 `/root/projects/.dsh/dsh-attachment.json`）

```jsonc
{
  "v": 1,
  "partners": { "self": { ... } },   // multiPartner 关时只有 self
  "config": { ... }                  // 同 DEFAULTS
}
```

单个 partner 的关键字段（`store.js:40`）：

| 字段 | 说明 |
|---|---|
| `dims` | 八个维度当前值 |
| `paceIdx` | 0见 1碰 2解 3合 4尽，**只升不降**（trust 崩才降） |
| `will` | 拒/缓/允/忍/求，`willOf` 每步重算 |
| `trust` | 冗余镜像，给 panel 用 |
| `pendingRespectAt` | 说了不之后的时间戳，跨消息判「听没听」 |
| `turns` / `msgCount` | **跨会话累计**，不是今天的 |
| `declineCount` / `brakeCount` | 同上，累计计数器 |
| `tickAt` | 最近一次 step，判断插件是否活着 |

---

## 9. 配置项（`core.js:33 DEFAULTS`）

| key | 默认 | 说明 |
|---|---|---|
| intensity | 1 | 全局倍率 0.2–2，影响增量不影响半衰期 |
| decayScale | 1 | >1 衰得快，<1 余温久 |
| msgTotalCap | 22 | 单条用户消息总推动上限，防长文一条翻档 |
| inject | true | 关掉后状态照算、不进提示词 |
| harmony | true | 和谐模式：只写情感与亲近；关掉才是 18X |
| multiPartner | false | 按会话分桶 |
| partnerMode | false | 锁定一个依恋对象 |
| pressurePenalty | 1 | 施压惩罚倍率，设 0 = 关掉反服从 |
| respectBonus | 1 | 尊重加成倍率 |
| setStep | 8（上限 20） | `attachment set` 单次最大步长 |

---

## 10. 工具接口

```
attachment read                     看当前状态
attachment touch dim=trust amount=4  推一点（1–12）
attachment set dim=trust to=22       定目标值（单次最多 setStep，默认 8）
attachment decline                   拒绝这一轮
attachment brake                     把唤起压下去
attachment why="..."                 任何动作可带，写进日志
```

---

## 11. 已知坑

1. **多人模式认不准说话人**（`speaker.js`）——关系数值会挂到别人身上，比不注入还糟。
   社区建议：一对一稳了再开群聊。修复记录见 `FIX-speaker-multipool.md`。
2. **`set` 单次 8 点**：从 0 到 22 要三次。这是有意的，防讨好时自我拔高、赌气时自我贬低。
3. **trust 只掉不回**：机制使然，不是 bug，但要知道它是单向的（见 §6）。
4. **注入行必须常量**：见 §7。
5. **`slow` 维度不看墙上时钟**：只按轮次，挂机不衰减。
6. **拒绝要两段确认**：单次拒绝不扣分，连续才算（1.2.7）。
7. **`shame` 不参与 LEX_LEVEL**：见阶段也能羞；但「别看我」会被 reject 组误判，靠 `SHAME_SOFT` 单独剔。

---

## 12. 常用命令

```bash
cd /root/share/DSHBox/publish/dsh-attachment

node test.mjs                                  # 全量自测（413 条）
node -e "import('./core.js').then(m=>console.log(m.shortLine({dims:{}})))"
node tools/repro-speaker.mjs                   # 复现说话人识别问题

# 看真实状态
python3 -c "import json;d=json.load(open('/root/projects/.dsh/dsh-attachment.json'));print(d['partners']['self']['dims'])"

# 改完要重启 dsh 才生效（profiles/web/node_modules/dsh-attachment 是软链到这里）
```

---

## 13. 版本线（最近三条）

| 版本 | 改了什么 |
|---|---|
| 1.2.7 | 拒绝判定改两段确认，补反向白名单（别停 / 我不想停） |
| 1.2.8 | ❌ 给 trust 加自动回升 —— **方向错了，已撤回** |
| 1.2.9 | 撤回 1.2.8；+ `LONG_TERM_LINE` 常驻注入，把 set 的权力交回模型 |
| 1.2.10 | + 每 20 轮一次的台账提醒（带四个数），治“知道有 set 但想不起来用” |

**教训**：改长效维度之前，先回 `prompts.js:44` 读那三行。那三条是这个插件的宪法。
