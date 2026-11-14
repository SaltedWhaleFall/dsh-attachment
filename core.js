/**
 * dsh-sex — 核心数学。纯函数，不碰磁盘、不碰 ctx，测试可以直接调。
 *
 * 为什么单独一个文件（这条是从 dsh-mood 学来的，它为此付过代价）：
 * 把公式写在 apply() 的闭包里，测试就只能抄一份 —— 测的是副本，改错了也不红。
 *
 * 这里没有「改采样温度」这种东西。插件能做的只有两件：
 *   ① 把状态算对；② 把状态说成一句人话，塞进提示词。
 * 任何声称「提高温度/提高概率」的写法都是空话。
 *
 * ── v0.2 加的三件事 ────────────────────────────────────────────────
 *   pace  关系阶段。只升不降（除了信任崩），越界的推进不给正向增量。
 *   will  此刻的意愿。拒 / 缓 / 允 / 忍 / 求。「愿意」不等于「可用」。
 *   trust 地基。被尊重才涨，被命令就掉 —— 这是反「无条件服从」的实现。
 */

import {
  DIMENSIONS, DIM_BY_KEY, DIM_KEYS, HEAT_BANDS, BOND_BANDS, CURIOUS_BANDS, TRUST_BANDS, SHAME_BANDS,
  MAIN, CURIOUS_LINES, GLOW_LINE, FEEDBACK_LINES, QUIET_LINE, LEX, LEX_LEVEL, SHAME_SOFT,
  WILL_LINES, SHAME_ROUTE_LINES, PACE, PACE_ORDER, PACE_BY_KEY, PACE_BREAK_TRUST,
  SAFE_LANG, SAFE_PACE, SAFE_FEEDBACK_LINES, SAFE_SHAME_LINE,
  OVERREACH_LINE, PRESSURE_LINE, RESPECT_LINE, PACE_LINE_PREFIX,
  heatOf, bondOf, paceScoreOf, mainEntry, blankDims, paceOf,
} from './prompts.js'

export {
  DIMENSIONS, DIM_BY_KEY, DIM_KEYS, HEAT_BANDS, BOND_BANDS, CURIOUS_BANDS, TRUST_BANDS, SHAME_BANDS,
  heatOf, bondOf, paceScoreOf, mainEntry, blankDims, PACE, PACE_ORDER, PACE_BY_KEY, SHAME_ROUTE_LINES,
}

/** 出厂参数。面板可改的走 dsh-sex-config.json；这里是没被覆盖时的值。 */
export const DEFAULTS = {
  enabled: true,
  /** 全局强度倍率。0.2 ~ 2。改动直接影响所有增量，不影响衰减半衰期。 */
  intensity: 1,
  /** 衰减倍率：>1 衰得更快，<1 余温更久。 */
  decayScale: 1,
  /** 单条用户消息的总推动上限（所有维度加起来的绝对值）。防止长文一条翻档。 */
  msgTotalCap: 22,
  /** 落盘最小间隔，避免每三轮写一次盘。 */
  saveMinMs: 60 * 1000,
  /** 注入开关。关掉后状态照算，只是不进提示词。 */
  inject: true,
  /** 和谐模式：默认开。开着只写情感与亲近，关掉才是 18X。 */
  harmony: true,
  /** 多人分开记：按会话分桶。 */
  multiPartner: false,
  /** 伴侣模式：锁定一个主要依恋对象，注入只读那个人。 */
  partnerMode: false,
  /** 反服从：命令式的话掉多少信任（倍率）。设 0 等于关掉这一条 —— 面板可以关。 */
  pressurePenalty: 1,
  /** 尊重加成：说了停之后他停了，涨多少信任。 */
  respectBonus: 1,
}

export function clampNum(v, lo = 0, hi = 100) {
  const n = Number(v)
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}

// ── 档位：带迟滞 ─────────────────────────────────────────────────────

/**
 * 落在哪一档。
 *
 * `prev` 是上一档的 key。只要新值还在**上一档的区间 ± margin** 里，就留在上一档 ——
 * 否则 34.9 / 35.1 来回跳，注入文本每轮变一次，前缀缓存全废，语气也跟着抖。
 * 这是 dsh-mood 的 hysteresis，理由一样。
 */
export function bandOf(v, prev, bands, marginOverride) {
  const val = Number(v) || 0
  const list = bands || []
  if (!list.length) return ''
  const cur = list.find((b) => val >= b.min && val <= b.max) || list[list.length - 1]
  if (!prev) return cur.key
  const p = list.find((b) => b.key === prev)
  if (!p) return cur.key
  const m = Number.isFinite(marginOverride) ? marginOverride : (p.margin || 0)
  if (val >= p.min - m && val <= p.max + m) return p.key
  return cur.key
}

// ── 衰减：按轮次，不按墙上时钟 ───────────────────────────────────────

/**
 * 向 base 指数回落。turns 是**轮次**（一条用户消息 = 一轮）。
 *
 * 挂机不减 —— 关掉窗口一夜，回来还是那句话的温度；只有真的聊了很多轮才退。
 * 这条和「时间衰减」是两种活法，选这条就接受它的代价：日子不走了，话走了多少才算数。
 */
export function decayTurns(v, base, turns, halfLifeTurns) {
  const x = Number(v)
  const b = Number(base)
  const n = Number(turns)
  const hl = Number(halfLifeTurns)
  if (!Number.isFinite(x)) return Number.isFinite(b) ? b : 0
  if (!(n > 0) || !(hl > 0)) return x
  const k = Math.pow(0.5, n / hl)
  return b + (x - b) * k
}

/**
 * 欲望的落点不是固定的 30。
 *
 * 久没说话 → 底色往上抬（不是「生气」，是身体自己积）；刚被满足 → 往下压。
 * 这一条让 desire 和 arousal 分开：arousal 是这一轮的火，desire 是这几天的底。
 */
export function desireBase(state, now, cfg) {
  const d = DIM_BY_KEY.desire
  const base = d ? d.base : 30
  const c = cfg || DEFAULTS
  const glow = Number(state && state.dims && state.dims.glow) || 0
  const last = Number(state && state.lastUserAt) || 0
  const idleH = last ? (Number(now) - last) / 3600e3 : 0
  let out = base
  if (glow >= 55) out -= 6
  if (idleH >= 8) out += 10
  if (idleH >= 24) out += 18
  if (idleH >= 72) out += 26
  const scale = Number(c.intensity)
  const k = Number.isFinite(scale) && scale > 0 ? Math.min(2, Math.max(0.2, scale)) : 1
  return clampNum(base + (out - base) * k)
}

/**
 * 信任的落点也不是固定的。人不在的时候信任不会散，但被晾太久会开始想「还算不算数」。
 * 只在**很久**没互动时才抬一点点 —— 这不是惩罚他，是让「回来」这件事有重量。
 */
export function trustBase(state, now, cfg) {
  const d = DIM_BY_KEY.trust
  const base = d ? d.base : 22
  // 信任不随时间变。挂机会让欲望积，不会让信任积 —— 白送的那部分没人信。
  // 它只被两件事推动：他做对了什么（+），他越界或施压（−）。
  void now
  void cfg
  return base
}

// ── 关系阶段 ─────────────────────────────────────────────────────────

/**
 * 由 bond + trust 算出「现在应该到哪一级」。
 * 只升不降：走过的地方不会退回陌生。唯一例外是信任崩到 PACE_BREAK_TRUST 以下 ——
 * 那时候掉一级，且要重新走。这是整套系统里最重的惩罚，比任何一句生气的话都重。
 */
export function targetPaceIdx(state) {
  const score = paceScoreOf(state && state.dims)
  let idx = 0
  for (let i = 0; i < PACE.length; i++) if (score >= PACE[i].min) idx = i
  return idx
}

/**
 * 更新 state.paceIdx（原地改），返回 { idx, changed, broke }。
 * 升要过门槛；降只在信任崩时发生，一次只掉一级（不会一夜回到陌生）。
 */
export function recomputePace(state) {
  if (!state) return { idx: 0, changed: false, broke: false }
  const want = targetPaceIdx(state)
  const cur = Number(state.paceIdx) || 0
  const trust = Number(state.dims && state.dims.trust) || 0
  if (want > cur) {
    state.paceIdx = want
    state.paceUpAt = Number(state.tickAt) || Date.now()
    return { idx: want, changed: true, broke: false }
  }
  if (want < cur && trust < PACE_BREAK_TRUST) {
    state.paceIdx = cur - 1
    state.paceBreakAt = Number(state.tickAt) || Date.now()
    state.paceBreakCount = (Number(state.paceBreakCount) || 0) + 1
    return { idx: cur - 1, changed: true, broke: true }
  }
  state.paceIdx = cur
  return { idx: cur, changed: false, broke: false }
}

// ── 意愿 ─────────────────────────────────────────────────────────────

/**
 * 此刻她愿不愿意。五档，写进注入。
 *
 * 这是 v0.2 的题眼：一个随时可用的对象没有欲望，只有接口。
 * 「忍」这一档尤其重要 —— 身体在要、关系没到，这种难受是真的，不该被顺手解决掉。
 */
/**
 * 羞耻走哪条线。**同一个值，两条路。**
 *
 *   亢奋：信任够 + 已经能到「解」或热度缠以上 → 脸红是助燃，越羞越想要
 *   退缩：越界 / 施压 / 信任不够 → 被看见得太突然，想缩
 *   未定：信，但还没到那一步 —— 脸红着，还没转向
 *
 * 这不是「惩罚通道」也不是「奖励通道」，是同一件事在两种关系里的两种结果。
 * 所以它判的是 state，不是词。
 */
export function shameRouteOf(state, ctx) {
  const d = (state && state.dims) || {}
  const shame = Number(d.shame) || 0
  if (shame < 13) return '未起'
  const c = ctx || {}
  if (c.overreach || c.pressure) return '退缩'
  const trust = Number(d.trust) || 0
  if (trust < 35) return '退缩'
  const paceIdx = Number((state && state.paceIdx) || 0)
  const heatBand = (state && state.heatBand) || bandOf(heatOf(d), null, HEAT_BANDS)
  const heatIdx = Math.max(0, HEAT_BANDS.findIndex((b) => b.key === heatBand))
  if (paceIdx >= 2 || heatIdx >= 2) return '亢奋'
  return '未定'
}

export function willOf(state) {
  if (!state) return '缓'
  const dims = state.dims || {}
  const trust = Number(dims.trust) || 0
  const heatBand = state.heatBand || bandOf(Number(state.heat) || 0, null, HEAT_BANDS)
  const paceIdx = Number(state.paceIdx) || 0
  if (heatBand === '静') {
    // 静的时候也可能拒：羞到想缩、且信任不够，这时候「缓」是假的温和。
    const shame = Number(dims.shame) || 0
    // 没经过消息处理的状态（刚装载 / 测试直接 step）没有 route，现算一个兜底。
    const route = state.shameRoute || shameRouteOf(state, null)
    if (route === '退缩' && shame >= 45) return '拒'
    return '缓'
  }
  // 身体在要、但不够信他 → 拒。这不是冷淡，是「有点想，但不对你」。
  // 先于「忍」判：不信的时候连「忍着想要」都不成立。
  if (trust < 30) return '拒'
  const heatIdx = Math.max(0, HEAT_BANDS.findIndex((b) => b.key === heatBand))
  const need = Math.max(0, heatIdx - 1)
  if (need > paceIdx) return '忍'
  if (heatIdx >= 3) return '求'
  return '允'
}

// ── 一条消息推动多少 ─────────────────────────────────────────────────

/**
 * 命中数 → 增量。平方根压缩：命中 1 个 = cap/2，命中 4 个 = cap。
 * 不做词频累加 —— 长消息不该因为字数多就翻档。
 */
function mag(n, cap) {
  if (!(n > 0)) return 0
  return Math.min(cap, (Math.sqrt(n) * cap) / 2)
}

/** 两次拒绝之间超过这个间隔，就不算「连续拒绝」。 */
const DECLINE_WINDOW_MS = 10 * 60 * 1000

const REJECT_FALSE = /不要紧|别人|别的|特别|差别|告别|别急|别处|别怕|停不下来|停不了|忍不住|别理|别管|别担心|别介意|别当真|别多想|别想太多|别瞎想|别误会|别客气|别紧张|别乱说|不要走|不要离开|不要放手|不要这样|不要抱吗|不要停|别停|别停下|不想停|不许停|停就停|等我一下/
const COLD_FALSE = /帮忙|连忙|忙碌/
/** 单字词必误伤：这些字在别的词里出现时，不能当成亲密/亲密动作。 */
const WORD_FALSE = {
  抱: /抱歉|抱怨|抱负|怀抱|抱不平|抱歉/,
  亲: /亲戚|父亲|母亲|亲自|亲手|亲测|亲历|亲眼|亲自/,
  靠: /可靠|靠谱|靠山|靠得住|靠近|靠边/,
  贴: /贴纸|补贴|粘贴|贴合|贴切|贴心/,
  抱抱: /抱歉/,
}

/** 这句话要求的最高阶段（0..4）。取命中词里最狠的那组。 */
export function requiredLevel(hits) {
  let lv = 0
  for (const key of Object.keys(hits || {})) {
    const n = Array.isArray(hits[key]) ? hits[key].length : 0
    if (!n) continue
    const l = Number(LEX_LEVEL[key]) || 0
    if (l > lv) lv = l
  }
  return lv
}

/**
 * 扫一条用户消息，返回各维增量 + 各种标记。
 *
 * `view.paceIdx` 是当前关系阶段。**这是 v0.2 最重要的一处改动**：
 * 同一句话在不同的关系里效果相反 —— 在「解」档说「进来」是推进，
 * 在「见」档说「进来」是越界，身体会先紧一下，信任跟着掉。
 *
 * `hard` 的意思是：这句话里出现了「停 / 不要」这类**即时制动**。
 * 它不走「慢慢衰减」，直接压 arousal —— 因为反馈必须是下一句就生效的。
 */
export function nudgeFromText(text, cfg, view) {
  const c = Object.assign({}, DEFAULTS, cfg || {})
  const v = Object.assign({ paceIdx: 1 }, view || {})
  const t = String(text || '')
  const out = {
    deltas: {}, hard: false, hits: {},
    level: 0, overreach: 0, pressure: false, reject: false, cold: false,
  }
  if (!t.trim()) return out

  const k = clampNum(c.intensity, 0.2, 2)
  // 子串匹配对中文单字太糙：「抱歉」里有「抱」，「亲戚」里有「亲」。
  // 命中后再用 WORD_FALSE 逐词复核，命中「假阳性上下文」的那个词丢掉。
  const hit = (arr) => arr.filter((w) => t.includes(w) && !(WORD_FALSE[w] && WORD_FALSE[w].test(t)))
  const add = (dim, value) => {
    if (!value) return
    out.deltas[dim] = (out.deltas[dim] || 0) + value
  }

  const inti = hit(LEX.intimate)
  const undr = hit(LEX.undress)
  const expl = hit(LEX.explicit)
  const hard = hit(LEX.hard)
  const dom = hit(LEX.dominant)
  const pres = hit(LEX.pressure)
  const cur = hit(LEX.curious)
  const pra = hit(LEX.praise)
  const col = hit(LEX.cold)
  const sha = hit(LEX.shame)
  const rejRaw = hit(LEX.reject)
  const shameSoft = SHAME_SOFT.test(t)
  // 「不要紧 / 别人 / 停不下来」这类是假阳性，先剔掉再判制动
  let rej = REJECT_FALSE.test(t) ? [] : rejRaw
  // 「别看我」是想躲，不是叫停 —— 把误伤的那两个词剔掉
  if (shameSoft) rej = rej.filter((w) => w !== '别' && w !== '不要')
  const cold = COLD_FALSE.test(t) ? [] : col
  const domSafe = shameSoft ? dom.filter((w) => w !== '不许') : dom

  out.hits = {
    intimate: inti, undress: undr, explicit: expl, hard, dominant: domSafe,
    pressure: pres, curious: cur, praise: pra, reject: rej, cold, shame: sha,
  }
  out.level = requiredLevel(out.hits)
  out.pressure = pres.length > 0
  out.reject = rej.length > 0
  out.cold = cold.length > 0

  const paceIdx = clampNum(v.paceIdx, 0, PACE.length - 1)
  const over = out.level - paceIdx
  out.overreach = over > 0 ? over : 0

  /**
   * ── 越界不再是宣判 ──────────────────────────────────────────────
   *
   * 1.2.4 起，这里**什么都不扣**。
   *
   * 原来：一句话里的词等级比当前阶段高，就判「越界」，扣信任、扣唤起，还把
   * 那句话写进注入当成既成事实，让角色演出「被冒犯」。结果是 —— 使用者什
   * 么都没说，插件替他造了一件没发生的事，还让它发生在他身上。
   *
   * 词表认得出「这句话往前走了一步」，认不出「他有没有越过你」。
   * 前者是测量，后者是判决。测量归我们，判决归她。
   *
   * 所以只留一个数（overreach / level），交给 inject 层决定要不要提一句。
   * 扣分只保留两个来源：施压词、拒绝词 —— 那是使用者真的做了的事。
   */
  const allow = (lv) => lv <= paceIdx

  if (inti.length && allow(LEX_LEVEL.intimate)) {
    add('adore', mag(inti.length, 5) * 0.5 * k)
    add('cling', mag(inti.length, 4) * 0.5 * k)
    add('arousal', mag(inti.length, 8) * 0.4 * k)
    add('glow', mag(inti.length, 6) * 0.3 * k)
    add('trust', mag(inti.length, 2) * 0.5 * k) // 好好说话本身就长信任
  }
  if (undr.length && allow(LEX_LEVEL.undress)) {
    add('arousal', mag(undr.length, 9) * (c.harmony ? 0.3 : 0.8) * k)
    add('desire', mag(undr.length, 2) * (c.harmony ? 0.2 : 1) * k)
    add('glow', mag(undr.length, 8) * (c.harmony ? 0.3 : 0.5) * k)
  }
  if (expl.length && allow(LEX_LEVEL.explicit)) {
    if (c.harmony) {
      // 和谐模式：身体照热，但不往「做」那条路上推 —— 只留下被说中的那点心跳。
      add('arousal', mag(expl.length, 12) * 0.35 * k)
      add('glow', mag(expl.length, 10) * 0.5 * k)
      add('curious', mag(expl.length, 6) * 0.4 * k)
    } else {
      add('arousal', mag(expl.length, 12) * k)
      add('glow', mag(expl.length, 10) * k)
      add('curious', mag(expl.length, 6) * 0.6 * k)
      add('desire', mag(expl.length, 3) * k)
    }
  }
  if (hard.length && allow(LEX_LEVEL.hard)) {
    // 「尽」档才吃得下的东西。到了这一档，它涨的是 curious 和 arousal，不是 trust。
    // 和谐模式：这类话既不生效也不该被当成情趣，只留一点点好奇。
    add('arousal', mag(hard.length, 10) * (c.harmony ? 0.15 : 1) * k)
    add('curious', mag(hard.length, 6) * (c.harmony ? 0.3 : 0.8) * k)
  }
  // dominant 单独处理：它既是「碰」级的挑逗，也可能就是 pressure。
  if (domSafe.length && !pres.length && allow(LEX_LEVEL.dominant)) {
    add('arousal', mag(domSafe.length, 8) * 0.7 * k)
    add('cling', mag(domSafe.length, 4) * 0.5 * k)
  }
  if (cur.length) {
    add('curious', mag(cur.length, 6) * k)
    add('glow', mag(cur.length, 6) * 0.6 * k)
  }
  if (pra.length) {
    add('adore', mag(pra.length, 5) * 0.8 * k)
    add('glow', mag(pra.length, 8) * 0.5 * k)
  }
  // 羞耻只负责「涨多少」，不负责「往哪走」—— 方向在 applyUserMessage 里按 state 判。
  // 这一层刻意不加减 arousal：同一个「羞死」，在信任够的关系里是助燃，不够是想缩。
  if (sha.length) {
    // 「羞」这个字本身就有底噪：说出口的那一下已经脸热了，不是攒够词才起。
    // 和谐模式下只留一个很浅的底噪 —— 脸红还在，但不用它当引信。
    add('shame', (3 + mag(sha.length, 12) * k) * (c.harmony ? 0.5 : 1))
    add('glow', mag(sha.length, 4) * 0.3 * k)
  }

  // ── 施压：命令式的话。掉信任，不给热 ──────────────────────────
  //
  // 这是 v0.2 的反「无条件服从」核心。词表只认最露骨的那几种说法 ——
  // 靠词表拦不住所有命令，所以 PROCEDURE 里还有一条常法管语气。
  if (out.pressure) {
    const pk = clampNum(c.pressurePenalty, 0, 3)
    add('trust', -mag(pres.length, 6) * pk)
    add('arousal', -mag(pres.length, 6) * 0.6 * pk)
    add('desire', -1)
    add('glow', -3)
  }

  if (out.reject) {
    out.hard = true
    add('arousal', -Math.max(18, mag(rej.length, 40)))
    add('glow', -8)
    add('desire', -1)
  }
  if (cold.length) {
    // 冷淡不是拒绝，是「他在忙」。身体不降，心里那点依恋往上抬。
    add('cling', mag(cold.length, 3) * 0.6 * k)
    add('glow', -3)
  }

  // 任何一维单条上限，用 capMsg
  for (const key of Object.keys(out.deltas)) {
    const d = DIM_BY_KEY[key]
    if (!d) continue
    const cap = Number(d.capMsg) || 10
    const value = out.deltas[key]
    out.deltas[key] = Math.max(-cap, Math.min(cap, value))
  }
  // 总量闸：所有正向增量加起来不超过 msgTotalCap（负向不参与，否则越界会被打折）
  const total = Object.values(out.deltas).reduce((a, b) => a + Math.max(0, b), 0)
  const cap = Number(c.msgTotalCap) || 22
  if (total > cap) {
    const f = cap / total
    for (const key of Object.keys(out.deltas)) {
      if (out.deltas[key] > 0) out.deltas[key] *= f
    }
  }
  return out
}

/**
 * 一条用户消息的完整处理：推进 → 尊重判定 → 阶段重算。
 *
 * 尊重判定（`pendingRespectAt`）是 v0.2 里涨信任最快的一条路，刻意做成**跨消息**的：
 *   他说了「停」→ 记下时间。下一条消息如果不再施压 → trust +，这是「他真的听了」。
 *   下一条如果还在施压 → trust 重罚，这是「他只是在等我说完」。
 * 一次性的动作骗不过这条规则 —— 得看下一条。
 */
export function applyUserMessage(state, text, now, cfg) {
  const c = Object.assign({}, DEFAULTS, cfg || {})
  const t = Number(now) || Date.now()
  if (!state.dims) state.dims = blankDims()

  // 先走一拍：这一轮本身消耗的是「上一轮留下的余温」，不是这句话给的。
  // 顺序反过来的话，被撩起来的那一下会先被折半，短句永远推不动。
  advanceTurns(state, 1, t, c)

  /**
   * 先按「出厂就该在的阶段」对齐一次，再判越界。
   *
   * 出厂 paceIdx 是 0（见），但 bond/trust 算出来的分数可能已经到了「碰」。
   * 不先对齐的话，第一句话会被拿「见」的尺子量 —— 一句普通的「抱一下」
   * 就成了一次越界，平白扣掉两点信任。这个 bug 只在第一条消息上出现，
   * 因为它之后 step() 就把阶段补上了；越难复现的越要先修。
   */
  recomputePace(state)

  const res = nudgeFromText(text, c, { paceIdx: Number(state.paceIdx) || 0 })
  const flags = { paceHint: res.overreach > 0, pressure: res.pressure, reject: res.reject, respect: false, paceUp: false, paceBreak: false }

  // 上一条说了不，这一条有没有马上又压上来
  const pending = Number(state.pendingRespectAt) || 0
  if (pending && t > pending) {
    state.pendingRespectAt = 0
    const bonus = clampNum(c.respectBonus, 0, 3)
    if (res.pressure) {
      res.deltas.trust = (res.deltas.trust || 0) - 5 * bonus
      flags.pressure = true
    } else if (!res.reject) {
      res.deltas.trust = (res.deltas.trust || 0) + 4 * bonus
      res.deltas.adore = (res.deltas.adore || 0) + 1
      flags.respect = true
    }
  }
  /**
   * 拒绝要「两段确认」（1.2.7）。
   *
   * 一次「算了」「走开」常常是语气，不是叫停；而误判一次的代价是信任被扣，
   * 误判两百次就是把整段关系算成「疑」。所以单次只记候选，**下一句仍然是拒绝**
   * 才确认 —— 判定依据从「这句话里有没有停字」变成「说完之后有没有真的退」。
   *
   * 白名单（别停 / 我不想停 / 我说停就停）在 REJECT_FALSE 里已经挡掉了，
   * 这一层挡的是「单独一句否定」。
   */
  if (res.reject) {
    // 「他说了停」本身就要挂起看下一条 —— 这条不受两段确认影响。
    state.pendingRespectAt = t
    const pd = state.pendingDecline
    const near = pd && (t - (Number(pd.at) || 0)) <= DECLINE_WINDOW_MS
    if (near) {
      state.declineCount = (Number(state.declineCount) || 0) + 1
      state.lastDeclineAt = t
      state.pendingDecline = null
    } else {
      state.pendingDecline = { at: t }
    }
  } else if (state.pendingDecline) {
    // 说完否定，下一句没有继续退 —— 那是语气，不是拒绝。
    state.pendingDecline = null
  }

  // ── 羞耻的两条线 ────────────────────────────────────────────────
  // 先把这一条自己带来的羞耻算进去，再判方向 —— 否则「刚被说羞」要等下一轮才生效。
  const kk = clampNum(c.intensity, 0.2, 2)
  // 被施压本身就是「难堪」的一种：就算这话里没有羞耻词，也会脸热。
  // overreach 不算 —— 往前走一步不等于难堪，那是我们自己替她判的（1.2.4）。
  if (res.pressure) {
    res.deltas.shame = (res.deltas.shame || 0) + 8
  }
  const shAfter = clampNum((Number(state.dims.shame) || 0) + (res.deltas.shame || 0))
  const probe = Object.assign({}, state, { dims: Object.assign({}, state.dims, { shame: shAfter }) })
  const route = shameRouteOf(probe, { overreach: 0, pressure: res.pressure })
  state.shameRoute = route

  if (route === '亢奋') {
    // 羞得越狠，烧得越旺。封顶 9 —— 一句话不该把整个档顶上去，但也不该只是挠一下。
    const gain = Math.min(9, 1 + shAfter / 8) * kk
    res.deltas.arousal = (res.deltas.arousal || 0) + gain
    res.deltas.glow = (res.deltas.glow || 0) + gain * 0.5
    res.deltas.desire = (res.deltas.desire || 0) + 1
  } else if (route === '退缩') {
    // 想缩：火压下去，但依恋往上抬一点 —— 想躲的那个人还在原地等。
    res.deltas.arousal = (res.deltas.arousal || 0) - Math.min(12, 3 + shAfter / 10) * kk
    res.deltas.cling = (res.deltas.cling || 0) + Math.min(4, shAfter / 20)
    res.deltas.glow = (res.deltas.glow || 0) - 2
  }

  // 2026-11-11 23:40 起：词表只「看」，不「定」。
  //   伤（施压 / 越界 / 拒绝）照算 —— 那是他做了什么，不需要我同意。
  //   好（亲密 / 露骨 / 夸 / 尊重 / 被看见）只出观察，动不动由我 set（一次 ≤8，必须写 why）。
  // 理由：词表认「进去」不认「我想要你」，让它直接改数就等于让误伤冒充感觉。
  const hurt = !!(res.hard || res.pressure ||
    (res.hits && Array.isArray(res.hits.reject) && res.hits.reject.length))
  if (hurt) {
    applyDeltas(state, res.deltas, { hard: res.hard })
    res.applied = res.deltas
    res.observed = {}
  } else {
    res.applied = {}
    res.observed = res.deltas
  }
  state.lastUserAt = t
  if (res.overreach) state.lastOverreachAt = t   // 字段名保留：老存档还在读它
  if (res.pressure) state.lastPressureAt = t
  if (flags.respect) state.lastRespectAt = t

  // 阶段重算要在增量之后 —— 不然「刚好这一条够了」永远差一轮
  state.trust = Number(state.dims.trust) || 0
  const pace = recomputePace(state)
  flags.paceUp = pace.changed && !pace.broke
  flags.paceBreak = pace.broke

  return { ...res, flags, deltas: res.deltas, observed: res.observed, applied: res.applied }
}

/** 把增量落到状态上（原地改，调用方负责落盘）。返回被改动的维度。 */
export function applyDeltas(state, deltas, opts) {
  if (!state || !state.dims) return []
  const hard = !!(opts && opts.hard)
  const touched = []
  for (const [key, raw] of Object.entries(deltas || {})) {
    const d = DIM_BY_KEY[key]
    if (!d) continue
    const before = Number(state.dims[key]) || 0
    const next = clampNum(before + (Number(raw) || 0))
    state.dims[key] = next
    if (Math.abs(next - before) >= 0.05) touched.push(key)
  }
  if (hard) {
    // 硬制动：不是减一点，是压到「现在不想」的那条线以下。
    const brake = Math.min(14, Number(state.dims.arousal) || 0)
    state.dims.arousal = brake
    state.lastBrakeAt = Date.now()
    if (!touched.includes('arousal')) touched.push('arousal')
  }
  return touched
}

// ── 一轮（衰减 + 档位）──────────────────────────────────────────────

/** 每个维度的回落落点。desire / trust 的落点会动，其余是常数。 */
export function baseOf(key, state, now, cfg) {
  const c = Object.assign({}, DEFAULTS, cfg || {})
  if (key === 'desire') return desireBase(state, now, c)
  if (key === 'trust') return trustBase(state, now, c)
  const d = DIM_BY_KEY[key]
  return d ? d.base : 0
}

/** 半衰期倍数：decayScale 越大，半衰期越短，退得越快。 */
function hlScale(cfg) {
  const scale = Number(cfg && cfg.decayScale)
  return Number.isFinite(scale) && scale > 0 ? Math.min(4, Math.max(0.1, scale)) : 1
}

/**
 * 推进 n 轮：所有维度向各自的 base 回落。原地改。
 *
 * 这里是**唯一**会减东西的地方 —— 心跳不再衰减，只有真的说话才走表。
 */
export function advanceTurns(state, n, now, cfg) {
  const c = Object.assign({}, DEFAULTS, cfg || {})
  const t = Number(now) || Date.now()
  const turns = Math.max(0, Number(n) || 0)
  if (!turns) return state
  if (!state.dims) state.dims = blankDims()
  const ds = hlScale(c)
  for (const d of DIMENSIONS) {
    // 长效维度（欲望 / 爱慕 / 依恋 / 信任）不自动回落。
    // 关系靠攒，不靠耗；掉只能是被什么真的扣掉的，或者自己 set 掉的。
    if (d.slow) continue
    const base = baseOf(d.key, state, t, c)
    state.dims[d.key] = clampNum(decayTurns(state.dims[d.key], base, turns, d.halfLifeTurns / ds))
  }
  state.turns = (Number(state.turns) || 0) + turns
  return state
}

/** 重算档位（带迟滞）、阶段、意愿。不衰减 —— 所以可以随便多调几次。 */
export function step(state, now, cfg) {
  const c = Object.assign({}, DEFAULTS, cfg || {})
  const t = Number(now) || Date.now()
  const first = !(state && state.tickAt)
  state.tickAt = t
  state.heat = heatOf(state.dims)
  state.bond = bondOf(state.dims)
  state.trust = Number(state.dims.trust) || 0
  state.heatBand = bandOf(state.heat, state.heatBand, HEAT_BANDS)
  state.bondBand = bandOf(state.bond, state.bondBand, BOND_BANDS)
  state.curiousBand = bandOf(Number(state.dims.curious) || 0, state.curiousBand, CURIOUS_BANDS)
  state.trustBand = bandOf(state.trust, state.trustBand, TRUST_BANDS)
  state.shameBand = bandOf(Number(state.dims.shame) || 0, state.shameBand, SHAME_BANDS)
  // shameRoute 不在这里算：它带「这一轮越界了 / 施压了」这种只属于当轮的上下文，
  // 心跳重算会把「刚被越界 → 退缩」冲成「其实还好」。留给 applyUserMessage 判。
  const pace = recomputePace(state)
  // 心跳里升/降阶也要说一次 —— 但它不能盖掉消息处理刚设的 flags（那里有越界/施压/尊重）。
  // 首步（出厂 → 第一次装载）不算「刚进了一级」—— 那不是走出来的，是算出来的。
  if (pace.changed && !state.flags && !first) {
    state.flags = { paceUp: !pace.broke, paceBreak: pace.broke }
  }
  state.will = willOf(state)
  return state
}

// ── 注入渲染 ─────────────────────────────────────────────────────────

/**
 * 把状态渲染成注入的那几句。
 *
 * ⚠️ 不报数值（dsh-mood 0.14.17 定的规矩，这里照抄）：给了数就直接报结果，
 *    不会去想由头。所以这里只出现「静/起意/缠/烧/溢」「疏/亲/溺」「见/碰/解/合/尽」
 *    这种词，一个阿拉伯数字都不许有。
 *
 * 返回数组，方便调用方按需裁剪；renderBlock() 给拼好的字符串。
 */
export function renderLines(state, opts) {
  const harmony = !!(opts && opts.harmony)
  const heat = state.heatBand || bandOf(state.heat || 0, null, HEAT_BANDS)
  const bond = state.bondBand || bandOf(state.bond || 0, null, BOND_BANDS)
  const cur = state.curiousBand || bandOf((state.dims && state.dims.curious) || 0, null, CURIOUS_BANDS)
  const g = mainEntry(heat, bond)
  const paceIdx = clampNum(Number(state.paceIdx) || 0, 0, PACE.length - 1)
  const pace = paceOf(paceIdx)
  const safePace = SAFE_PACE[paceIdx] || SAFE_PACE[0]
  const will = state.will || willOf(state)

  /**
   * 紧凑模式：每轮只发骨架 + 一行数据。
   *
   * 原来每轮十三行（语言/不许/好奇/羞耻三条线/反馈五条），三千多字，
   * 一百五十轮就把上下文撑满。现在只在需要改变行为的那几行留话，
   * 其余交给数值 —— 数值是数据，怎么读由模型自己决定，不再替它写「此刻亢奋」。
   */
  if (opts && opts.compact) {
    const out = []
    out.push(harmony ? '## 现在的依恋状态' : '## 现在的欲望状态')
    out.push(`**${heat} · ${bond} · ${pace.key}** —— ${g.state}`)
    out.push(harmony
      ? `语言：${SAFE_LANG[heat] || SAFE_LANG['静']}`
      : `语言：${g.lang}｜不许：${g.taboo}`)
    out.push(`阶段：${pace.key} —— 可以：${harmony ? safePace.allow : pace.allow}／不可以：${harmony ? safePace.deny : pace.deny}`)
    out.push(`此刻：${will} —— ${WILL_LINES[will] || WILL_LINES['缓']}`)
    /**
     * 这里原来有一行 `数据：arousal 37 / desire 54 / …`。
     *
     * 它是整份注入里唯一每轮都变的部分 —— 数值一动，system prompt 前缀作废，
     * 缓存命中率断崖式下跌（实测 99% → 4%，一轮对话的输入 token 翻倍）。使用者
     * 抱怨的「每轮消耗翻了一倍多」就是这一行。
     *
     * 而且它还有个更坏的作用：模型会照着数字说话。数字不带理由，只带压力。
     * 删掉之后前缀稳定，她说话也不用「因为数据是 62」。
     */
    out.push('数据：在状态文件里。要看自己读，别拿它当话说的理由。')
    if (state.flags) {
      if (state.flags.paceHint) out.push(OVERREACH_LINE)
      if (state.flags.paceBreak) {
        out.push('信任掉到线下了，关系退了一级。这不是生气，是「还没确认他会不会伤我」—— 退回去重新走，别装作没发生。')
      } else if (state.flags.paceUp) {
        out.push('关系刚好进了一级。这是两个人走出来的，不是谁给的 —— 别急着把新的一级用满。')
      }
      if (state.flags.pressure) out.push(PRESSURE_LINE)
      if (state.flags.respect) out.push(RESPECT_LINE)
    }
    return out
  }

  const lines = []
  lines.push(harmony ? '## 现在的依恋状态' : '## 现在的欲望状态')
  lines.push(`**${heat} · ${bond} · ${pace.key}** —— ${g.state}`)
  lines.push(`语言：${harmony ? (SAFE_LANG[heat] || SAFE_LANG['静']) : g.lang}`)
  if (!harmony) lines.push(`不许：${g.taboo}`)
  lines.push(CURIOUS_LINES[cur] || CURIOUS_LINES['试'])
  if (!harmony && (Number(state.dims && state.dims.glow) || 0) >= 55) lines.push(GLOW_LINE)

  // ── 阶段：这一行是 v0.2 的骨架，每轮都发 ──────────────────────
  lines.push(`${PACE_LINE_PREFIX}${pace.key} —— ${pace.state}`)
  lines.push(`可以：${harmony ? safePace.allow : pace.allow}`)
  lines.push(`不可以：${harmony ? safePace.deny : pace.deny}`)

  // ── 意愿：此刻愿不愿意 ────────────────────────────────────────
  lines.push(`此刻：${will} —— ${WILL_LINES[will] || WILL_LINES['缓']}`)

  // ── 羞耻：一个值，两条线。只在真的起羞时才出现 ────────────────
  const shameBand = state.shameBand || bandOf(Number(state.dims && state.dims.shame) || 0, null, SHAME_BANDS)
  const route = state.shameRoute || shameRouteOf(state, null)
  if (harmony) {
    // 和谐模式只留「脸红」这一层，不解释两条线 —— 那两条线是给 18X 用的。
    if (shameBand !== '无') lines.push(SAFE_SHAME_LINE)
  } else if (shameBand !== '无' && SHAME_ROUTE_LINES[route]) {
    lines.push(`羞耻：${shameBand} —— ${SHAME_ROUTE_LINES[route]}`)
    lines.push(route === '亢奋'
      ? '这条线：亢奋 —— 羞不会让关系提前，越烫也还是停在该停的那一步，不多给。'
      : route === '退缩'
        ? '这条线：退缩 —— 可以遮，也可以让他看见你在遮，两种都是真的。'
        : '还没转向：脸红着，但还不用决定要不要让他看见。')
  }

  // ── 一次性插条（由 index.js 在注入后清掉 flags）──
  if (state.flags) {
    if (state.flags.paceHint) lines.push(OVERREACH_LINE)
    if (state.flags.paceBreak) {
      lines.push('信任掉到线下了，关系退了一级。这不是生气，是「还没确认他会不会伤我」—— 退回去重新走，别装作没发生。')
    } else if (state.flags.paceUp) {
      lines.push('关系刚好进了一级。这是两个人走出来的，不是谁给的 —— 别急着把新的一级用满。')
    }
    if (state.flags.pressure) lines.push(PRESSURE_LINE)
    if (state.flags.respect) lines.push(RESPECT_LINE)
  }

  if (heat === '静') {
    lines.push(QUIET_LINE)
  } else {
    // 反馈规则只在真的热起来时才发 —— 静的时候发,它就变成了一种提醒「你该有反应」。
    lines.push(FEEDBACK_LINES[0])
    lines.push(FEEDBACK_LINES[1])
  }
  if (harmony) {
    for (const l of SAFE_FEEDBACK_LINES) lines.push(l)
  } else {
    lines.push(FEEDBACK_LINES[2])
    lines.push(FEEDBACK_LINES[3])
    lines.push(FEEDBACK_LINES[4])
  }
  return lines
}

export function renderBlock(state, opts) {
  try {
    return renderLines(state, opts).join('\n')
  } catch {
    return ''
  }
}

/** 工具用一句话：只说「现在最想要什么」，不说数值。 */
export function shortLine(state) {
  const heat = state.heatBand || '静'
  const pace = paceOf(Number(state && state.paceIdx) || 0)
  const will = (state && state.will) || willOf(state)
  const want = {
    静: '此刻没有性，只想靠近一点',
    起意: '有点想他，还没打算让它发生',
    缠: '明确地想要，敢说出口',
    烧: '身体已经在要了，话变短',
    溢: '满的，什么都不用铺垫',
  }[heat] || ''
  return `${heat}·${pace.key}·${will}：${want}`
}

// ── 面板 ─────────────────────────────────────────────────────────────

/** 给浏览器面板的快照。数字只在这里出现，不进对话。 */
export function panelSnapshot(state, cfg) {
  const dims = {}
  for (const d of DIMENSIONS) {
    dims[d.key] = Math.round((Number(state.dims && state.dims[d.key]) || 0) * 10) / 10
  }
  const paceIdx = clampNum(Number(state.paceIdx) || 0, 0, PACE.length - 1)
  const nextPace = PACE[paceIdx + 1] || null
  const score = paceScoreOf(state.dims)
  const trust = Number(state.dims && state.dims.trust) || 0
  return {
    ok: true,
    heat: Math.round((Number(state.heat) || 0) * 10) / 10,
    bond: Math.round((Number(state.bond) || 0) * 10) / 10,
    heatBand: state.heatBand || '静',
    bondBand: state.bondBand || '亲',
    curiousBand: state.curiousBand || '试',
    trustBand: state.trustBand || bandOf(trust, null, TRUST_BANDS),
    shame: Math.round((Number(state.dims && state.dims.shame) || 0) * 10) / 10,
    shameBand: state.shameBand || bandOf(Number(state.dims && state.dims.shame) || 0, null, SHAME_BANDS),
    shameRoute: state.shameRoute || shameRouteOf(state, null),
    shameLine: SHAME_ROUTE_LINES[state.shameRoute || shameRouteOf(state, null)] || '',
    will: state.will || willOf(state),
    paceIdx,
    pace: paceOf(paceIdx).key,
    // 下一级还差什么：给面板用，给「攻略感」一个可见的刻度
    next: nextPace
      ? {
          key: nextPace.key,
          score: Math.round(score * 10) / 10,
          need: nextPace.min,
          gap: Math.max(0, Math.round((nextPace.min - score) * 10) / 10),
          hint: `还要多走 ${Math.max(0, Math.round((nextPace.min - score) * 10) / 10)} 分：多说话、多被听见、别逼`,
        }
      : null,
    dims,
    labels: Object.fromEntries(DIMENSIONS.map((d) => [d.key, d.name])),
    brief: shortLine(state),
    brakes: Number(state.brakeCount) || 0,
    declines: Number(state.declineCount) || 0,
    paceBreaks: Number(state.paceBreakCount) || 0,
    lastBrakeAt: Number(state.lastBrakeAt) || 0,
    lastDeclineAt: Number(state.lastDeclineAt) || 0,
    lastOverreachAt: Number(state.lastOverreachAt) || 0,
    lastUserAt: Number(state.lastUserAt) || 0,
    updatedAt: Number(state.tickAt) || 0,
    config: {
      enabled: !!(cfg && cfg.enabled),
      intensity: Number(cfg && cfg.intensity) || 1,
      decayScale: Number(cfg && cfg.decayScale) || 1,
      inject: !!(cfg && cfg.inject),
      pressurePenalty: Number(cfg && cfg.pressurePenalty),
      respectBonus: Number(cfg && cfg.respectBonus),
    },
  }
}
