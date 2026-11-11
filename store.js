/**
 * dsh-attachment — 磁盘。状态与配置各一个文件，都在 $DSH_HOME 下。
 *
 * 两条原则（都是踩出来的）：
 *   ① 写盘一律 tmp + rename。直接 writeFile 目标路径，断电/并发会留下半截 JSON，
 *      之后每次 load 都抛，插件就永远停在出厂值 —— 而且不报错，只是「没反应」。
 *   ② 读到坏 JSON **不要**当成空状态覆盖回去。先把它改名成 .bad 留证，再起空状态。
 *      不然真数据被一次解析失败无声抹掉。
 *
 * ── v3：多桶 ────────────────────────────────────────────────────────
 * 一个人一份状态。root 只放索引和全局开关，真正的数值在 partners[key] 里。
 * 这样「多人分开记」不用改任何一条数学 —— core 的函数收到的还是原来那个形状。
 *
 *   root = { v:3, activeKey, primaryKey, partners: { [key]: partner } }
 *   partner = { dims, paceIdx, will, shameRoute, flags, turns, … }  ← 和 v2 的 state 同构
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { blankDims, DIMENSIONS } from './prompts.js'
import { DEFAULTS, clampNum } from './core.js'

export function homeDir() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function dataFile(name) {
  return join(homeDir(), name)
}

export const statePath = () => dataFile('dsh-attachment.json')
export const configPath = () => dataFile('dsh-attachment-config.json')
/** 改名前的旧文件：只用于一次性迁移，不参与后续读写。 */
export const legacyStatePath = () => dataFile('dsh-sex.json')
export const legacyConfigPath = () => dataFile('dsh-sex-config.json')

/** 一个人。字段和 v2 的整个 state 同构 —— core 不用知道有「多人」这回事。 */
export function blankPartner(key, label) {
  return {
    v: 1,
    key,
    label: label || '',
    dims: blankDims(),
    heat: 0,
    bond: 0,
    heatBand: null,
    bondBand: null,
    curiousBand: null,
    trustBand: null,
    shameBand: null,
    // 关系阶段：0=见 1=碰 2=解 3=合 4=尽。只升不降，除非 trust 崩。
    paceIdx: 0,
    paceUpAt: 0,
    paceBreakAt: 0,
    paceBreakCount: 0,
    // 此刻意愿：拒/缓/允/忍/求（由 core.willOf 每步重算）
    will: null,
    shameRoute: null,
    trust: 0,
    flags: null,
    // 说了不之后的那一条：跨消息判「他到底听没听」
    pendingRespectAt: 0,
    declineCount: 0,
    lastDeclineAt: 0,
    lastRespectAt: 0,
    lastOverreachAt: 0,
    lastPressureAt: 0,
    tickAt: 0,
    lastUserAt: 0,
    lastAssistantAt: 0,
    lastBrakeAt: 0,
    brakeCount: 0,
    turns: 0,
    msgCount: 0,
    createdAt: Date.now(),
  }
}

/** 根。partners 至少有一个 'self'，这样关掉多人时一切照旧。 */
export function blankRoot() {
  return {
    v: 3,
    activeKey: 'self',
    primaryKey: null,
    partners: { self: blankPartner('self', '默认') },
    /**
     * 会话 → 最近一次说话的桶。
     * 群聊里同一会话会有 A、B 轮流说话，没有前缀的接话该归谁，靠这张表。
     * 只记最近一个，不记历史 —— 是为了不让它无限长。
     */
    sessionSpeaker: {},
    createdAt: Date.now(),
  }
}

/** 兼容旧名 —— 有些测试/外部代码还在调 blankState()。 */
export function blankState() {
  return blankPartner('self', '默认')
}

function readJsonSafe(path, label) {
  if (!existsSync(path)) return { ok: true, data: null, missing: true }
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    return { ok: false, error: '读不出来：' + String((e && e.message) || e), data: null }
  }
  try {
    return { ok: true, data: JSON.parse(text) }
  } catch (e) {
    // 留证，不覆盖
    try { copyFileSync(path, path + '.bad') } catch {}
    return { ok: false, error: `${label} JSON 坏了（已备份为 ${label}.bad）：` + String((e && e.message) || e), data: null }
  }
}

/** 把任意来源的对象补成一个合法的 partner。缺键补 base，坏值钳回去。 */
export function normalizePartner(raw, key, label) {
  const p = Object.assign(blankPartner(key, label), raw && typeof raw === 'object' ? raw : {})
  p.key = key
  if (typeof p.label !== 'string') p.label = label || ''
  if (!p.dims || typeof p.dims !== 'object') p.dims = blankDims()
  for (const d of DIMENSIONS) {
    if (!Number.isFinite(Number(p.dims[d.key]))) p.dims[d.key] = d.base
    else p.dims[d.key] = clampNum(p.dims[d.key])
  }
  p.paceIdx = Math.max(0, Math.min(4, Number(p.paceIdx) || 0))
  p.turns = Math.max(0, Number(p.turns) || 0)
  p.msgCount = Math.max(0, Number(p.msgCount) || 0)
  p.trust = Number(p.dims.trust) || 0
  return p
}

/**
 * 读状态。
 *   ① 有 dsh-attachment.json → 读它
 *   ② 没有，但有旧的 dsh-sex.json → 迁移（整份当成 'self'），并立刻写新文件
 *   ③ 都没有 → 出厂
 */
export function loadState() {
  const r = readJsonSafe(statePath(), 'dsh-attachment.json')
  if (r.ok && r.data && typeof r.data === 'object') {
    const raw = r.data
    // v2 结构：整个对象就是一个人
    if (!raw.partners && raw.dims) {
      const root = blankRoot()
      root.partners.self = normalizePartner(raw, 'self', '默认')
      root.v = 3
      return { root, migrated: 'v2' }
    }
    const root = blankRoot()
    root.v = 3
    root.activeKey = typeof raw.activeKey === 'string' ? raw.activeKey : 'self'
    root.primaryKey = typeof raw.primaryKey === 'string' ? raw.primaryKey : null
    const src = raw.partners && typeof raw.partners === 'object' ? raw.partners : {}
    const keys = Object.keys(src)
    if (!keys.length) keys.push('self')
    for (const k of keys) {
      root.partners[k] = normalizePartner(src[k], k, (src[k] && src[k].label) || '')
    }
    if (!root.partners[root.activeKey]) root.activeKey = Object.keys(root.partners)[0]
    if (root.primaryKey && !root.partners[root.primaryKey]) root.primaryKey = null
    // 「每个会话最近说话的人」：只留还存在的桶，免得存档里的死引用越攒越多
    const ss = raw.sessionSpeaker && typeof raw.sessionSpeaker === 'object' ? raw.sessionSpeaker : {}
    for (const [sid, k] of Object.entries(ss)) {
      if (typeof k === 'string' && root.partners[k]) root.sessionSpeaker[sid] = k
    }
    return { root, migrated: null }
  }

  // 旧包名的一次性迁移：只读，不改旧文件
  const lr = readJsonSafe(legacyStatePath(), 'dsh-sex.json')
  if (lr.ok && lr.data && typeof lr.data === 'object') {
    const root = blankRoot()
    root.partners.self = normalizePartner(lr.data, 'self', '默认')
    root.v = 3
    saveState(root)
    return { root, migrated: 'dsh-sex' }
  }

  const root = blankRoot()
  if (!r.ok) root._loadError = r.error
  return { root, migrated: null }
}

/** 原子写。失败返回 { ok:false, error }，不抛 —— 写不进去不该让对话断掉。 */
export function saveState(root) {
  const path = statePath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(root, null, 2), 'utf8')
    renameSync(tmp, path)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 取一个人；没有就建。key 为空时落到 'self'。 */
export function partnerOf(root, key, label) {
  if (!root) return null
  if (!root.partners) root.partners = {}
  const k = String(key || 'self')
  if (!root.partners[k]) root.partners[k] = blankPartner(k, label || '')
  return root.partners[k]
}

/** 面板用：谁都在，谁最近说话，谁是伴侣。 */
export function listPartners(root) {
  if (!root || !root.partners) return []
  return Object.values(root.partners)
    .map((p) => ({
      key: p.key,
      label: p.label || p.key,
      msgs: Number(p.msgCount) || 0,
      turns: Number(p.turns) || 0,
      pace: Number(p.paceIdx) || 0,
      trust: Math.round((Number(p.dims && p.dims.trust) || 0) * 10) / 10,
      heat: Math.round((Number(p.heat) || 0) * 10) / 10,
      lastUserAt: Number(p.lastUserAt) || 0,
      primary: root.primaryKey === p.key,
      active: root.activeKey === p.key,
    }))
    .sort((a, b) => b.lastUserAt - a.lastUserAt)
}

/** 桶太多时清掉最久没说话的（默认留 40 个）。永远不删 'self' 和 primary。 */
export function prunePartners(root, keep = 40) {
  if (!root || !root.partners) return 0
  const entries = Object.values(root.partners)
  if (entries.length <= keep) return 0
  const protectedKeys = new Set(['self', root.primaryKey, root.activeKey].filter(Boolean))
  // 每个会话「最近说话的那个人」也算在用 —— 裁掉它，下一句无前缀的话就断了线
  for (const k of Object.values(root.sessionSpeaker || {})) if (k) protectedKeys.add(k)
  const drop = entries
    .filter((p) => !protectedKeys.has(p.key))
    .sort((a, b) => (Number(a.lastUserAt) || 0) - (Number(b.lastUserAt) || 0))
  let n = 0
  for (const p of drop) {
    if (Object.keys(root.partners).length <= keep) break
    delete root.partners[p.key]
    n += 1
  }
  return n
}

/** 配置：只认白名单字段，多的一律丢 —— 免得手改出来的垃圾字段一直躺着。 */
export function normalizeConfig(raw) {
  const c = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {})
  return {
    enabled: c.enabled !== false,
    intensity: clampNum(c.intensity, 0.2, 2) || 1,
    decayScale: clampNum(c.decayScale, 0.1, 4) || 1,
    msgTotalCap: clampNum(c.msgTotalCap, 4, 60) || DEFAULTS.msgTotalCap,
    saveMinMs: clampNum(c.saveMinMs, 5000, 3600e3) || DEFAULTS.saveMinMs,
    inject: c.inject !== false,
    // 反服从的两根旋钮。设 0 就是关掉这一条 —— 留着是为了「能调」，不是因为默认该关。
    pressurePenalty: clampNum(c.pressurePenalty, 0, 3),
    respectBonus: clampNum(c.respectBonus, 0, 3),
    // ── 发布版新增的三个开关 ────────────────────────────────────────
    /**
     * 和谐模式：默认开 —— 开着不写性，只写情感与亲近。
     * 关掉它就是「不可控」：文案放开，同时注入破甲段。没有第二个开关，两者是同一件事。
     */
    harmony: c.harmony !== false,
    /**
     * 解除模板腔：管「不当助手、不客服腔」那一段要不要注入。
     *
     * 以前它和 harmony 焊死 —— 想要自由必须连尺度一起放开，等于「用自由换素材」。
     * 现在拆开：harmony 只管写不写性，armor 只管要不要解除模板腔。
     * 没写这个字段的旧配置按 `harmony === false` 推导，行为与旧版一致，不用迁移。
     */
    armor: c.armor !== undefined ? c.armor === true : c.harmony === false,
    /** 多人分开记：按会话分桶。默认关（单对象）。 */
    multiPartner: c.multiPartner === true,
    /** 伴侣模式：锁定一个主要依恋对象，注入只读那个人。 */
    partnerMode: c.partnerMode === true,
  }
}

export function loadConfig() {
  const r = readJsonSafe(configPath(), 'dsh-attachment-config.json')
  if (r.ok && r.data) return normalizeConfig(r.data)
  // 旧包名的配置迁移：开关照搬，其余字段同名
  const lr = readJsonSafe(legacyConfigPath(), 'dsh-sex-config.json')
  if (lr.ok && lr.data) return normalizeConfig(lr.data)
  return normalizeConfig(null)
}

export function saveConfig(cfg) {
  const path = configPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(normalizeConfig(cfg), null, 2), 'utf8')
    renameSync(tmp, path)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 面板画滑块用：名字、范围、出厂值。前端不写死这些数。 */
export const TUNABLES = [
  { key: 'intensity', name: '强度倍率', min: 0.2, max: 2, step: 0.05, def: 1, hint: '所有增量乘这个数；不影响衰减速度。' },
  { key: 'decayScale', name: '衰减倍率', min: 0.1, max: 4, step: 0.1, def: 1, hint: '越大余温越短。唤起 2 轮半衰期 ÷ 这个数。只按轮次走，挂机不减。' },
  { key: 'msgTotalCap', name: '单条上限', min: 4, max: 60, step: 1, def: 22, hint: '一条消息能把所有维度加起来推多少。防长文翻档。' },
  { key: 'saveMinMs', name: '落盘间隔(ms)', min: 5000, max: 600000, step: 5000, def: 60000, hint: '两次写盘的最小间隔。' },
  { key: 'pressurePenalty', name: '施压惩罚', min: 0, max: 3, step: 0.1, def: 1, hint: '命令式的话掉多少信任。0 = 关掉反服从。' },
  { key: 'respectBonus', name: '尊重加成', min: 0, max: 3, step: 0.1, def: 1, hint: '说了停之后他停了，涨多少信任。' },
]

/** 面板画开关用。 */
export const SWITCHES = [
  { key: 'harmony', name: '和谐模式', def: true, hint: '开着只写情感与亲近，不写性。关掉则放开尺度 —— 但它不再自动解除模板腔，那由下一个开关决定。' },
  { key: 'armor', name: '解除模板腔', def: true, hint: '独立开关：开着一律注入「不客服腔、不当助手、可以说不」那一段；关掉就不注入。想保住自由度但不想放开尺度时，只开这个、留着和谐模式。旧配置按「和谐关掉才注入」自动推导。' },
  { key: 'multiPartner', name: '多人记忆', def: false, hint: '按说话人分开记。同一个会话里「A：」「【B】」「C 说：」各算一个人。' },
  { key: 'partnerMode', name: '伴侣模式', def: false, hint: '锁定一个主要依恋对象，注入只读那个人。' },
  { key: 'inject', name: '进提示词', def: true, hint: '关掉后状态照算，只是不说话：不往系统提示词里写那一段，数值、工具、面板都还在。' },
  { key: 'enabled', name: '整个模块', def: true, hint: '总开关。关掉后不注入、不记账、心跳不动；设置页仍然能打开它。即时生效，不用重启。' },
]
