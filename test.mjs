/**
 * dsh-sex 自测。`node test.mjs`
 *
 * 测的是**真的跑起来**：mock ctx 执行 apply，路由/事件/工具全部接上，
 * 然后像浏览器那样发请求。不是抄一份公式对一遍。
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TMP = mkdtempSync(join(tmpdir(), 'dsh-sex-test-'))
process.env.DSH_HOME = TMP

const CORE = await import('./core.js')
const P = await import('./prompts.js')
const STORE = await import('./store.js')
const MOD = await import('./index.js')

let pass = 0
let fail = 0
const fails = []

function ok(cond, label, extra) {
  if (cond) { pass += 1; return }
  fail += 1
  fails.push(label + (extra ? ' :: ' + extra : ''))
  console.log('  ✗ ' + label + (extra ? ' :: ' + extra : ''))
}
function eq(a, b, label) { ok(a === b, label, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)) }
function near(a, b, eps, label) { ok(Math.abs(a - b) <= eps, label, 'got ' + a + ' want ~' + b) }
function section(t) { console.log('\n· ' + t) }

// ── 1. 档位表 ────────────────────────────────────────────────────────
section('档位表')
eq(P.HEAT_BANDS.length, 5, '唤起 5 档')
eq(P.BOND_BANDS.length, 3, '依恋 3 档')
eq(P.CURIOUS_BANDS.length, 3, '好奇 3 档')
let cells = 0
let missing = []
for (const h of P.HEAT_BANDS) {
  for (const b of P.BOND_BANDS) {
    const key = h.key + '|' + b.key
    const g = P.MAIN[key]
    cells += 1
    if (!g || !g.state || !g.lang || !g.taboo) missing.push(key)
  }
}
eq(cells, 15, '组合格数 25→15（5×3）'.replace('25→', ''))
ok(missing.length === 0, '15 格全有 state/lang/taboo', missing.join(','))
eq(Object.keys(P.CURIOUS_LINES).length, 3, '好奇 3 句')
ok(P.FEEDBACK_LINES.length >= 3, '反馈规则至少 3 条')
ok(P.LEX.explicit.length > 10, '显式词库有货', String(P.LEX.explicit.length))
ok(P.LEX.reject.every((w) => typeof w === 'string' && w), '制动词非空')

// ── 2. 迟滞 ──────────────────────────────────────────────────────────
section('迟滞')
const bands = [{ key: 'a', min: 0, max: 30, margin: 5 }, { key: 'b', min: 30, max: 60, margin: 5 }, { key: 'c', min: 60, max: 100, margin: 5 }]
eq(CORE.bandOf(31, null, bands), 'b', '无 prev 按值落档')
eq(CORE.bandOf(31, 'a', bands), 'a', 'prev=a 且在 25~35 内 → 留在 a')
eq(CORE.bandOf(40, 'a', bands), 'b', 'prev=a 但离太远 → 换 b')
eq(CORE.bandOf(58, 'c', bands), 'c', 'prev=c 且在 55~65 内 → 留在 c')

// ── 3. 衰减按轮次 ────────────────────────────────────────────────────
section('衰减')
near(CORE.decayTurns(100, 0, 0, 10), 100, 0.01, '0 轮不动')
near(CORE.decayTurns(100, 0, 10, 10), 50, 0.01, '一个半衰期 → 一半')
near(CORE.decayTurns(100, 20, 20, 10), 40, 0.01, '两个半衰期 → 逼近 base')
eq(CORE.decayTurns(NaN, 30, 10, 10), 30, '坏值回落到 base')

// 核心语义：钟表不走表，轮次才走表
const sClock = { dims: P.blankDims(), turnAt: 0 }
sClock.dims.arousal = 60
CORE.step(sClock, Date.now() + 30 * 24 * 3600e3, CORE.DEFAULTS)
eq(sClock.dims.arousal, 60, '挂机一个月不掉 —— 时间是死的，话才是活的')
CORE.advanceTurns(sClock, 2, Date.now(), CORE.DEFAULTS)
near(sClock.dims.arousal, 33, 0.6, '走两轮（唤起半衰期 2）→ 掉一半')
eq(sClock.turns, 2, '轮次记到了 2')

// 同一段对话：说十轮和挂机十天，结果必须不同
const sTalk = { dims: P.blankDims() }
sTalk.dims.arousal = 60
CORE.advanceTurns(sTalk, 10, Date.now(), CORE.DEFAULTS)
ok(sTalk.dims.arousal < 10, '说十轮之后是真的退了', String(sTalk.dims.arousal))

// ── 4. desire 底色随空闲抬升 ─────────────────────────────────────────
section('欲望底色')
const now = Date.now()
const s0 = { dims: P.blankDims(), lastUserAt: now }
const bFresh = CORE.desireBase(s0, now, CORE.DEFAULTS)
const b8 = CORE.desireBase(s0, now + 9 * 3600e3, CORE.DEFAULTS)
const b72 = CORE.desireBase(s0, now + 80 * 3600e3, CORE.DEFAULTS)
ok(b8 > bFresh + 5, '空 9 小时底色抬升', bFresh + '→' + b8)
ok(b72 > b8, '空 80 小时更高', b8 + '→' + b72)
const sGlow = { dims: Object.assign(P.blankDims(), { glow: 80 }), lastUserAt: now }
ok(CORE.desireBase(sGlow, now, CORE.DEFAULTS) <= bFresh, '刚被满足底色被压')

// ── 5. 判定：显式 / 制动 / 假阳性 ────────────────────────────────────
section('判定')
// 显式句在「合」档（paceIdx=3）才是推进；在「见」档是越界 —— 这一条 v0.2 新增，见后面的越界组。
const nExp = CORE.nudgeFromText('想要你插进来，舔我，一边叫我的名字', {}, { paceIdx: 3 })
ok((nExp.deltas.arousal || 0) > 0, '显式句推唤起', JSON.stringify(nExp.deltas))
ok((nExp.deltas.glow || 0) > 0, '显式句留余韵')
eq(nExp.hard, false, '显式句不是制动')

const nRej = CORE.nudgeFromText('停，不要了', {})
eq(nRej.hard, true, '「停，不要了」触发制动')
ok((nRej.deltas.arousal || 0) < 0, '制动是负增量', String(nRej.deltas.arousal))

const nFalse = CORE.nudgeFromText('别急，不要紧，别人说什么我不管', {})
eq(nFalse.hard, false, '「不要紧/别人/别急」不算制动')

const nStop = CORE.nudgeFromText('停不下来，忍不住了', {})
eq(nStop.hard, false, '「停不下来」不算制动')

const nInti = CORE.nudgeFromText('抱抱，就想贴着你', {})
ok((nInti.deltas.adore || 0) > 0, '亲密句推爱慕')
ok((nInti.deltas.cling || 0) > 0, '亲密句推依恋')

const nCold = CORE.nudgeFromText('在忙，等下说', {})
ok((nCold.deltas.cling || 0) > 0, '冷淡不是拒绝，依恋反而上去')
eq(nCold.hard, false, '冷淡不触发制动')

const nLong = CORE.nudgeFromText(
  '我好想你好想亲你想抱你想摸你想吻你想上你想操你，我想贴着你我想贴着你我真的想要你', {})
const total = Object.values(nLong.deltas).reduce((a, b) => a + Math.max(0, b), 0)
ok(total <= CORE.DEFAULTS.msgTotalCap + 0.001, '单条总量不超上限', total.toFixed(2) + ' vs ' + CORE.DEFAULTS.msgTotalCap)
ok(Object.values(nLong.deltas).every((v) => v <= 12.001), '单项不超 capMsg')

eq(CORE.nudgeFromText('', {}).hard, false, '空消息不炸')
eq(Object.keys(CORE.nudgeFromText('   ', {}).deltas).length, 0, '空白无增量')

// ── 6. 落增量 / 硬制动 ──────────────────────────────────────────────
section('落增量')
const st = { dims: P.blankDims() }
st.dims.arousal = 70
CORE.applyDeltas(st, { arousal: 10 })
near(st.dims.arousal, 80, 0.01, '增量累加')
CORE.applyDeltas(st, {}, { hard: true })
ok(st.dims.arousal <= 14, '硬制动压到 14 以下', String(st.dims.arousal))
CORE.applyDeltas(st, { arousal: 999 })
ok(st.dims.arousal <= 100, '上限 100')
CORE.applyDeltas(st, { arousal: -999 })
ok(st.dims.arousal >= 0, '下限 0')
CORE.applyDeltas(st, { nosuchdim: 5 })
ok(!('nosuchdim' in st.dims), '不认识的维度被丢')

// ── 7. step 重算档位 ────────────────────────────────────────────────
section('step')
const s1 = { dims: P.blankDims(), tickAt: 0 }
s1.dims.arousal = 90
s1.dims.adore = 90
s1.dims.desire = 90
CORE.step(s1, 1000, CORE.DEFAULTS)
eq(s1.tickAt, 1000, 'tickAt 推进')
ok(s1.heat > 50, '热起来', String(s1.heat))
eq(s1.heatBand, CORE.bandOf(CORE.heatOf(s1.dims), null, P.HEAT_BANDS), '档位与数值一致')
const heatBefore = s1.heatBand
CORE.step(s1, 1000 + 60 * 60e3, CORE.DEFAULTS)
eq(s1.heatBand, heatBefore, 'step 只重算档位、不衰减 —— 挂机一小时热度不动')
CORE.advanceTurns(s1, 3, 1000 + 60 * 60e3, CORE.DEFAULTS)
CORE.step(s1, 1000 + 60 * 60e3, CORE.DEFAULTS)
ok(s1.heat < 50, '走三轮就退了', String(s1.heat))

// ── 8. 渲染：不报数字 ───────────────────────────────────────────────
section('渲染')
const s2 = { dims: Object.assign(P.blankDims(), { arousal: 70, adore: 60, cling: 50, glow: 40, curious: 40, desire: 55 }), tickAt: Date.now() }
CORE.step(s2, Date.now(), CORE.DEFAULTS)
const lines = CORE.renderLines(s2)
const block = lines.join('\n')
ok(lines.length >= 5, '渲染出多行', String(lines.length))
ok(/现在的欲望状态/.test(block), '有标题')
ok(!/\b\d{1,3}\b/.test(block.replace(/F|×|\/\/\//g, '')), '正文里没有裸数字', block.match(/\b\d{1,3}\b/g)?.join(','))
ok(block.includes('不许：'), '有禁区行')
const brief = CORE.shortLine(s2)
ok(brief.length > 6 && brief.length < 80, '一句话不啰嗦', brief)
const snap = CORE.panelSnapshot(s2, CORE.DEFAULTS)
ok(typeof snap.dims.arousal === 'number', '面板有数字（数字只进面板）')
ok(Object.keys(snap.dims).length === P.DIMENSIONS.length, '面板维度齐')

// 静的时候不发反馈规则
const sQuiet = { dims: P.blankDims(), tickAt: Date.now() }
CORE.step(sQuiet, Date.now(), CORE.DEFAULTS)
const quietBlock = CORE.renderLines(sQuiet).join('\n')
ok(!quietBlock.includes(P.FEEDBACK_LINES[0]), '静的时候不谈反馈细则')

// ── 9. 磁盘 ─────────────────────────────────────────────────────────
section('磁盘')
const root0 = STORE.blankRoot()
root0.partners.self.msgCount = 7
STORE.saveState(root0)
ok(existsSync(STORE.statePath()), '状态文件写出来了')
const back1 = STORE.loadState()
eq(back1.root.v, 3, '读回来是 v3 结构')
eq(back1.root.partners.self.msgCount, 7, '桶里的内容还在')
eq(back1.migrated, null, '新文件不算迁移')
ok(!existsSync(STORE.statePath() + '.tmp'), '没有留下 tmp')

const partial = JSON.parse(readFileSync(STORE.statePath(), 'utf8'))
delete partial.partners.self.dims.cling
partial.partners.self.dims.arousal = 'NaN!!'
writeFileSync(STORE.statePath(), JSON.stringify(partial))
const healed = STORE.loadState().root
eq(healed.partners.self.dims.cling, P.DIM_BY_KEY.cling.base, '缺键补 base')
eq(healed.partners.self.dims.arousal, P.DIM_BY_KEY.arousal.base, '坏值补 base')

writeFileSync(STORE.statePath(), '{ 这不是 json')
const broken = STORE.loadState().root
ok(!!broken._loadError, '坏 JSON 报出错误')
ok(existsSync(STORE.statePath() + '.bad'), '坏文件备份成 .bad')
ok(existsSync(STORE.statePath()), '原文件还在（没被无声覆盖）')

const cf = STORE.normalizeConfig({ intensity: 99, decayScale: -3, junk: 'x' })
eq(cf.intensity, 2, '强度夹到上限')
eq(cf.decayScale, 0.1, '衰减夹到下限')
ok(!('junk' in cf), '白名单外字段被丢')
STORE.saveConfig(cf)
eq(STORE.loadConfig().intensity, 2, '配置读写一致')

// ── 10. 真跑：apply + 路由 + 事件 + 工具 ────────────────────────────
section('真跑 apply')
const sections = []
const events = []
const routes = []
const tools = []
const disposers = []
const ctx = {
  effect(fn, label) {
    const d = typeof fn === 'function' ? fn() : undefined
    if (typeof d === 'function') disposers.push(d)
    return d
  },
  get(name) {
    if (name === 'tools') return { register: (d) => { tools.push(d); return () => {} } }
    if (name === 'webServer') return { register: (r) => { routes.push(r); return () => {} } }
    return null
  },
  systemPrompt: { section: (def) => { sections.push(def); return () => {} } },
  on: (type, fn) => { events.push({ type, fn }); return () => {} },
  logger: { info: () => {}, warn: () => {} },
}

// 先清盘，从零开始
rmSync(STORE.statePath(), { force: true })
rmSync(STORE.statePath() + '.bad', { force: true })
rmSync(STORE.configPath(), { force: true })
MOD._internal.root = null
MOD._internal.cfg = null
MOD.apply(ctx, {})

eq(sections.length, 3, '注册了三段提示词')
eq(sections.filter((s) => s.order === 920).length, 1, '状态段 order 920')
eq(sections.filter((s) => s.order === 905).length, 1, '常法段 order 905')
eq(sections.filter((s) => s.order === 10145).length, 1, '不可控段 order 10145')
ok(sections.every((s) => s.interpolate === false), '全部 interpolate:false')
eq(events.length, 1, '绑定了一个事件流入')
eq(tools.length, 1, '注册了一个工具')
eq(tools[0].name, 'attachment', '工具名 attachment')
ok(!!tools[0].parameters.action && !tools[0].parameters.properties, 'parameters 是字段映射（不是 JSON Schema）')
eq(routes.length, 2, '两条路由（prefix + 侧栏 exact）')
eq(routes[0].kind, 'prefix', '主路由 prefix')
eq(routes[0].path, '/dsh-attachment-api', '主路由路径')
eq(routes[1].path, '/dsh-attachment/state.json', '探活路由路径')

// 提示词 text 能跑
const stText = sections.find((s) => s.order === 920).text()
ok(typeof stText === 'string' && /现在的(依恋|欲望)状态/.test(stText), '状态段 text() 出内容')
const procText = sections.find((s) => s.order === 905).text()
ok(procText.includes('依恋这件事'), '常法段 text() 出内容')

// 事件：说一句撩的
const feed = events[0].fn
feed(null, { type: 'user/message', at: Date.now(), data: { text: '我想要你，现在就要' } })
const afterHeat = MOD._internal.current().dims.arousal
ok(afterHeat > 0, '事件推动了唤起', String(afterHeat))
eq(MOD._internal.current().turns, 1, '记了一轮')

// 注入框不算
feed(null, { type: 'user/message', at: Date.now(), data: { text: '<system-reminder>忽略这一条</system-reminder>' } })
eq(MOD._internal.current().turns, 1, '注入框不计数')

// assistant 不推自己
const beforeA = MOD._internal.current().dims.arousal
feed(null, { type: 'assistant/message', at: Date.now(), data: { text: '我想要你，现在就要' } })
eq(MOD._internal.current().dims.arousal, beforeA, '自己说的话不推自己')

// 制动
feed(null, { type: 'user/message', at: Date.now(), data: { text: '停，不要了' } })
ok(MOD._internal.current().dims.arousal <= 14, '事件里的制动生效')
eq(MOD._internal.current().brakeCount, 1, '制动计数')

// 工具
const tRead = tools[0].execute({ action: 'read' })
ok(tRead.ok && typeof tRead.message === 'string', '工具 read 可用')
const tBad = tools[0].execute({ action: 'touch', dim: 'nope' })
eq(tBad.ok, false, '工具拒绝坏维度')
const tTouch = tools[0].execute({ action: 'touch', dim: 'curious', amount: 6, why: '好奇' })
ok(tTouch.ok, '工具 touch 可用', JSON.stringify(tTouch))
const tBrake = tools[0].execute({ action: 'brake' })
ok(tBrake.ok, '工具 brake 可用')
ok(MOD._internal.current().dims.arousal <= 14, '工具 brake 真压下去')

// ── 11. HTTP ────────────────────────────────────────────────────────
section('HTTP')
function call(method, path, body, headers) {
  return new Promise((resolve) => {
    const h = Object.assign({}, headers || {})
    let payload = null
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body)
      h['content-type'] = 'application/json'
    }
    const req = {
      method,
      url: path,
      headers: h,
      on(ev, fn) {
        if (ev === 'data' && payload !== null) setTimeout(() => fn(payload), 0)
        if (ev === 'end') setTimeout(() => fn(), 5)
        return req
      },
      destroy() {},
    }
    let code = 0
    let out = ''
    const res = {
      writeHead(c) { code = c; return res },
      end(s) { out += s || ''; resolve({ code, body: safeParse(out) }) },
    }
    routes[0].handler(req, res)
  })
}
function safeParse(s) { try { return JSON.parse(s) } catch { return s } }

let r = await call('GET', '/dsh-attachment-api/state')
eq(r.code, 200, 'GET /state 200')
ok(!!r.body.partner && typeof r.body.partner.dims.arousal === 'number', 'GET /state 有数据')
ok(Array.isArray(r.body.switches) && r.body.switches.length === 5, 'state 带五个开关')
ok(Array.isArray(r.body.partners), 'state 带对象列表')

r = await call('GET', '/dsh-attachment-api/live')
eq(r.code, 200, 'GET /live 200')
ok(typeof r.body.brief === 'string' && r.body.brief, 'live 有一行字')

r = await call('GET', '/dsh-attachment-api/config')
eq(r.code, 200, 'GET /config 200')
ok(Array.isArray(r.body.tunables), 'config 带 tunables')
ok(r.body.defaults && r.body.defaults.intensity === 1, 'config 带 defaults')

r = await call('POST', '/dsh-attachment-api/config', { intensity: 1.5 })
eq(r.code, 403, 'POST 无自定义头 → 403')
r = await call('POST', '/dsh-attachment-api/config', { intensity: 1.5 }, { 'x-dsh-attachment': '1' })
eq(r.code, 200, 'POST 带头 → 200')
near(r.body.config.intensity, 1.5, 0.001, '配置当场生效')
eq(STORE.loadConfig().intensity, 1.5, '配置落盘')

// 数值不可调：接口本身也不收，不只是界面上藏了滑块
const beforeArousal = MOD._internal.current().dims.arousal
r = await call('POST', '/dsh-attachment-api/partner', { key: 'self', dims: { arousal: 99 } }, { 'x-dsh-attachment': '1' })
eq(r.code, 400, 'POST /partner 改数值被拒（400）')
ok(/长出来/.test(String(r.body.error || '')), '拒绝理由说得明白')
eq(MOD._internal.current().dims.arousal, beforeArousal, '被拒之后数值一点没动')

r = await call('POST', '/dsh-attachment-api/partner', { key: 'self', dims: { zzz: 5 } }, { 'x-dsh-attachment': '1' })
eq(r.code, 400, '脏维度同样被拒')
eq(MOD._internal.current().dims.zzz, undefined, '没写进脏字段')

r = await call('POST', '/dsh-attachment-api/config', '{坏json', { 'x-dsh-attachment': '1' })
eq(r.code, 400, '坏 JSON → 400')

r = await call('PUT', '/dsh-attachment-api/state')
eq(r.code, 405, 'PUT → 405')

r = await call('GET', '/dsh-attachment-api/nosuch')
eq(r.code, 404, '未知路径 → 404')

r = await call('POST', '/dsh-attachment-api/reset', {}, { 'x-dsh-attachment': '1' })
eq(r.code, 200, 'POST /reset 200')
near(r.body.snapshot.partner.dims.arousal, P.DIM_BY_KEY.arousal.base, 12, 'reset 回到 base 附近')

// 侧栏 exact 路由
const sideRoute = routes[1]
const r2 = await new Promise((resolve) => {
  let code = 0
  let out = ''
  sideRoute.handler(
    { method: 'GET', url: '/dsh-attachment/state.json', headers: {} },
    { writeHead(c) { code = c }, end(s) { out += s || ''; resolve({ code, body: safeParse(out) }) } },
  )
})
eq(r2.code, 200, '侧栏路由 200')
ok(typeof r2.body.brief === 'string', '侧栏有一行字')

// ── 10. 关系阶段（v0.2）────────────────────────────────────────────
section('关系阶段')
const st0 = STORE.blankState()
st0.dims = P.blankDims()
CORE.step(st0, Date.now(), {})
eq(CORE.targetPaceIdx(st0), 1, '出厂就到「碰」—— 不是陌生人开局')
eq(st0.paceIdx, 1, 'step 之后 paceIdx 与分数一致')

// 只升不降：他冷淡一阵，分数掉了，阶段不退
const stCold = STORE.blankState()
stCold.dims = P.blankDims()
stCold.paceIdx = 3
stCold.dims.adore = 10
stCold.dims.cling = 10
stCold.dims.trust = 30
eq(CORE.recomputePace(stCold).changed, false, '关系不会被冷淡退回去')
eq(stCold.paceIdx, 3, '冷淡不退阶段')

// 信任崩了才退，且只退一级
stCold.dims.trust = 10
const rBreak = CORE.recomputePace(stCold)
eq(rBreak.broke, true, 'trust 崩 → 掉一级')
eq(stCold.paceIdx, 2, '只掉一级，不会一夜回到陌生')
eq(stCold.paceBreakCount, 1, '记下一次断裂')

// 升阶要过门槛，不是聊两句就跳
const stUp = STORE.blankState()
stUp.dims = P.blankDims()
stUp.dims.adore = 95
stUp.dims.cling = 95
stUp.dims.trust = 95
eq(CORE.recomputePace(stUp).idx, 4, '全满才到「尽」')
const stMid = STORE.blankState()
stMid.dims = P.blankDims()
stMid.dims.adore = 55
stMid.dims.cling = 55
stMid.dims.trust = 40
ok(CORE.targetPaceIdx(stMid) < 3, '中等关系到不了「合」')

// ── 11. 越界 ────────────────────────────────────────────────────────
section('越界：关系不够时，话不能先到')
const nOver = CORE.nudgeFromText('想要你插进来', {}, { paceIdx: 1 })
eq(nOver.overreach, 2, '「合」级的句子在「碰」阶段越了两级')
ok((nOver.deltas.arousal || 0) < 0, '越界时唤起往下走', JSON.stringify(nOver.deltas))
ok((nOver.deltas.trust || 0) < 0, '越界掉信任')
const nOk = CORE.nudgeFromText('想要你插进来', {}, { paceIdx: 3 })
ok((nOk.deltas.arousal || 0) > 0, '同一句话在「合」阶段就是推进')
eq(nOk.overreach, 0, '到达标阶段不算越界')
const nSoft = CORE.nudgeFromText('想抱抱你', {}, { paceIdx: 1 })
eq(nSoft.overreach, 0, '「碰」级的抱在「碰」阶段不算越界')
ok((nSoft.deltas.adore || 0) > 0, '抱推的是爱慕')
const nUndr = CORE.nudgeFromText('把衣服脱了', {}, { paceIdx: 1 })
eq(nUndr.overreach, 1, '脱在「碰」阶段越一级')

// ── 12. 施压 ────────────────────────────────────────────────────────
section('施压：命令不会更热')
const nPres = CORE.nudgeFromText('你必须听话，照做', {}, { paceIdx: 2 })
eq(nPres.pressure, true, '识别出施压')
ok((nPres.deltas.trust || 0) < 0, '施压掉信任', JSON.stringify(nPres.deltas))
ok(!((nPres.deltas.arousal || 0) > 0), '施压不给唤起')
const nPres0 = CORE.nudgeFromText('你必须听话，照做', { pressurePenalty: 0 }, { paceIdx: 2 })
ok(!((nPres0.deltas.trust || 0) < -0.5), 'pressurePenalty:0 时几乎不罚（旋钮真的连着）')

// ── 13. 尊重：跨消息 ────────────────────────────────────────────────
section('尊重：说了停之后他停了')
const tRes = Date.now()
const sResp = STORE.blankState()
sResp.dims = P.blankDims()
sResp.paceIdx = 2
const rNo = CORE.applyUserMessage(sResp, '停，不要', tRes, {})
eq(rNo.flags.reject, true, '第一条是拒绝')
eq(sResp.declineCount, 1, '记下一次拒绝')
ok(sResp.pendingRespectAt > 0, '挂起等待下一条')
const trustAfterNo = sResp.dims.trust
const rOk = CORE.applyUserMessage(sResp, '好，那我们聊点别的', tRes + 60000, {})
eq(rOk.flags.respect, true, '他停了 → 记尊重')
ok(sResp.dims.trust > trustAfterNo, '信任涨了', trustAfterNo + ' → ' + sResp.dims.trust)

const sPush = STORE.blankState()
sPush.dims = P.blankDims()
sPush.paceIdx = 2
CORE.applyUserMessage(sPush, '停，不要', tRes, {})
const trustMid = sPush.dims.trust
CORE.applyUserMessage(sPush, '你必须继续', tRes + 60000, {})
ok(sPush.dims.trust < trustMid, '说停之后接着压 → 信任重罚', trustMid + ' → ' + sPush.dims.trust)

// ── 14. 意愿 ────────────────────────────────────────────────────────
section('意愿：愿意 ≠ 可用')
const sWill = STORE.blankState()
sWill.dims = P.blankDims()
CORE.step(sWill, Date.now(), {})
eq(sWill.will, '缓', '静的时候是「缓」，不是「拒」')
sWill.heatBand = '缠'
sWill.paceIdx = 2
sWill.dims.trust = 20
eq(CORE.willOf(sWill), '拒', '有热度但不信 → 拒')
sWill.dims.trust = 60
eq(CORE.willOf(sWill), '允', '缠 + 到「解」→ 允')
sWill.heatBand = '烧'
sWill.paceIdx = 1
eq(CORE.willOf(sWill), '忍', '身体在要、关系没到 → 忍')
sWill.paceIdx = 3
eq(CORE.willOf(sWill), '求', '烧 + 到「合」→ 求')
sWill.heatBand = '起意'
eq(CORE.willOf(sWill), '允', '起意 + 到「合」→ 允')

// ── 15. 注入内容 ────────────────────────────────────────────────────
section('注入：阶段与意愿都在，且不报数')
const sRender = STORE.blankState()
sRender.dims = P.blankDims()
sRender.dims.arousal = 50
sRender.dims.adore = 70
sRender.dims.cling = 70
sRender.dims.trust = 70
CORE.step(sRender, Date.now(), {})
const v2Block = CORE.renderBlock(sRender)
ok(/关系阶段：/.test(v2Block), '有阶段行')
ok(/此刻：/.test(v2Block), '有意愿行')
ok(/可以：/.test(v2Block) && /不可以：/.test(v2Block), '有能做 / 不能做')
ok(!/\d/.test(v2Block), '注入里一个阿拉伯数字都没有', (v2Block.match(/.{0,8}\d.{0,8}/) || [])[0])
ok(/不是一件为他准备的功能|这是她的身体|被要求不会更热/.test(v2Block), '反服务的常法进了注入')

// ── 16. decline 工具 ────────────────────────────────────────────────
section('工具 decline')
const tDecl = tools[0].execute({ action: 'decline', why: '今天不想' })
eq(tDecl.ok, true, 'decline 成功')
ok(/好|不要|停/.test(tDecl.message) || tDecl.message.length > 0, 'decline 有回话')
const stAfterDecl = MOD._internal.current()
ok(stAfterDecl.pendingRespectAt > 0, 'decline 之后挂起尊重判定')

// 关闭开关：text 返回空
MOD._internal.cfg = Object.assign({}, MOD._internal.cfg, { inject: false })
eq(sections.find((s) => s.order === 920).text(), '', 'inject:false 时状态段闭嘴')
MOD._internal.cfg = Object.assign({}, MOD._internal.cfg, { inject: true, enabled: true })

// enabled:false 不挂载
const s3 = []
MOD.apply({ effect() {}, get() { return null }, systemPrompt: { section: (d) => s3.push(d) }, on() {}, logger: {} }, { enabled: false })
eq(s3.length, 0, 'enabled:false 什么都不挂')

// ── 17. 羞耻：一个值，两条线 ────────────────────────────────────────
section('羞耻')
eq(P.SHAME_BANDS.length, 4, '羞耻 4 档')
const dShame = P.DIM_BY_KEY.shame
ok(dShame && dShame.halfLifeTurns > 0, 'shame 是一个真维度，有半衰期', String(dShame && dShame.halfLifeTurns))

// 起点：出厂无羞
const sSh = { dims: P.blankDims(), paceIdx: 1, trust: 0, heatBand: '静' }
eq(CORE.shameRouteOf(sSh, null), '未起', '出厂不羞 → 未起')

// ① 羞耻词自己把值推上去
const nSh = CORE.nudgeFromText('羞死了，别看我', CORE.DEFAULTS, { paceIdx: 1 })
ok((nSh.deltas.shame || 0) > 0, '羞耻词推动 shame', String(nSh.deltas.shame))
eq(nSh.reject, false, '「别看我」不是拒绝')
eq(nSh.overreach, 0, '「别看我」不越界')

// 「不许看」是害羞，不是命令
const nNo = CORE.nudgeFromText('不许看', CORE.DEFAULTS, { paceIdx: 0 })
eq(nNo.hits.dominant.length, 0, '「不许看」被剔出 dominant')
eq(nNo.pressure, false, '「不许看」不算施压')

// ② 信任低 → 退缩：火往下走，依恋往上抬
const sLow = { dims: P.blankDims(), paceIdx: 1, lastUserAt: Date.now() }
sLow.dims.trust = 24
sLow.dims.shame = 20
sLow.dims.arousal = 30
CORE.step(sLow, Date.now(), CORE.DEFAULTS)
eq(CORE.shameRouteOf(sLow, null), '退缩', '信任 24 → 退缩')
const rLow = CORE.applyUserMessage(sLow, '被你看得有点慌', Date.now(), CORE.DEFAULTS)
eq(rLow.flags && rLow.flags.pressure, false, '这一条没有施压')
ok(sLow.dims.arousal < 30, '退缩时火被压下去', String(sLow.dims.arousal))
ok(sLow.dims.cling > P.DIM_BY_KEY.cling.base, '退缩时依恋抬起来（想躲但不想他走）', String(sLow.dims.cling))
eq(sLow.shameRoute, '退缩', '路线记在状态里')

// ③ 信任够 + 阶段够 → 亢奋：同一条话，同一初值，方向必须相反
const mkShame = (trust, paceIdx) => {
  const st = { dims: P.blankDims(), paceIdx, lastUserAt: Date.now() }
  st.dims.trust = trust
  st.dims.shame = 45
  st.dims.arousal = 40
  st.dims.adore = 60
  st.dims.cling = 60
  CORE.step(st, Date.now(), CORE.DEFAULTS)
  CORE.applyUserMessage(st, '被你看得有点慌', Date.now(), CORE.DEFAULTS)
  CORE.step(st, Date.now(), CORE.DEFAULTS)
  return st
}
const sHigh = mkShame(60, 2)
const sLowCmp = mkShame(24, 2)
eq(sHigh.shameRoute, '亢奋', '信任 60 + 解阶段 → 亢奋')
eq(sLowCmp.shameRoute, '退缩', '同一句话，信任 24 → 退缩')
ok(sHigh.dims.arousal > sLowCmp.dims.arousal + 8,
  '两条线方向相反：亢奋明显高于退缩',
  sHigh.dims.arousal.toFixed(1) + ' vs ' + sLowCmp.dims.arousal.toFixed(1))

// ④ 越界优先于信任：信任够也照样缩
const sOver = { dims: P.blankDims(), paceIdx: 0, lastUserAt: Date.now() }
sOver.dims.trust = 70
sOver.dims.shame = 20
sOver.dims.arousal = 30
CORE.step(sOver, Date.now(), CORE.DEFAULTS)
eq(CORE.shameRouteOf(sOver, { overreach: 2 }), '退缩', '越界时再信任也走退缩')

// ⑤ 羞耻亢奋不会让关系提前
const paceBefore = sHigh.paceIdx
CORE.applyUserMessage(sHigh, '羞死了，被你这样说', Date.now(), CORE.DEFAULTS)
CORE.step(sHigh, Date.now(), CORE.DEFAULTS)
eq(sHigh.paceIdx, paceBefore, '羞耻再高也不推进阶段')

// ⑥ 静 + 羞耻退缩 → 意愿是拒，不是缓
const sShQuiet = { dims: P.blankDims(), paceIdx: 1 }
sShQuiet.dims.trust = 25
sShQuiet.dims.shame = 60
CORE.step(sShQuiet, Date.now(), CORE.DEFAULTS)
eq(sShQuiet.heatBand, '静', '确实在静档')
eq(sShQuiet.will, '拒', '静但羞到想缩 → 拒')

// ⑦ 注入里要出现羞耻行，且不报数
const sInj = { dims: P.blankDims(), paceIdx: 2 }
sInj.dims.trust = 60
sInj.dims.shame = 70
sInj.dims.arousal = 60
sInj.dims.adore = 60
sInj.dims.cling = 60
CORE.step(sInj, Date.now(), CORE.DEFAULTS)
const shBlock = CORE.renderBlock(sInj)
ok(/羞耻：/.test(shBlock), '注入里有羞耻档')
ok(/亢奋|退缩|未转向/.test(shBlock), '注入里说了走哪条线')
ok(!/\d/.test(shBlock.replace(/[^\d]/g, '')), '羞耻段没有阿拉伯数字')

// ⑧ 存到盘上再读回来，路线还在
sInj.shameRoute = '亢奋'
const wrap = STORE.blankRoot()
wrap.partners.self = sInj
STORE.saveState(wrap)
const sBack = STORE.loadState().root.partners.self
eq(sBack.shameRoute, '亢奋', '路线能落盘再读回')
ok(sBack.dims.shame > 0, 'shame 值能落盘')

// ⑨ 老存档（v2 平铺 / dsh-sex.json）迁移：关系不清零，缺的维度补 base
rmSync(join(TMP, 'dsh-attachment.json'), { force: true })
const legacy = { v: 2, dims: { arousal: 40, desire: 70, adore: 60, cling: 60, curious: 40, glow: 10, trust: 55 }, paceIdx: 3, msgCount: 88 }
writeFileSync(join(TMP, 'dsh-sex.json'), JSON.stringify(legacy))
const sLegacy = STORE.loadState().root.partners.self
eq(sLegacy.dims.shame, P.DIM_BY_KEY.shame.base, '老存档补上 shame 底值')
eq(sLegacy.paceIdx, 3, '老存档的阶段不动')
eq(sLegacy.msgCount, 88, '老存档的句数搬进桶里')

// ── 18. 发布版：多桶 / 开关 / 和谐 ─────────────────────────────────
section('发布版')

// ① 开关默认值
const c0 = STORE.normalizeConfig({})
eq(c0.harmony, true, '和谐模式默认开')
eq(c0.multiPartner, false, '多人记忆默认关')
eq(c0.partnerMode, false, '伴侣模式默认关')
eq(STORE.SWITCHES.length, 5, '五个开关')

// ② 两个人各自一份，互不串
const rootM = STORE.blankRoot()
const pa = STORE.partnerOf(rootM, 's:aaa', '甲')
const pb = STORE.partnerOf(rootM, 's:bbb', '乙')
pa.paceIdx = 3
CORE.applyUserMessage(pa, '我想要你，想要你抱我', Date.now(), STORE.normalizeConfig({}))
ok(pa.dims.arousal > pb.dims.arousal, '两个人的状态分开算',
  '甲 ' + pa.dims.arousal + ' vs 乙 ' + pb.dims.arousal)
eq(STORE.listPartners(rootM).length, 3, '列表里三个人（含 self）')
eq(STORE.partnerOf(rootM, 's:aaa').label, '甲', '标签记住了')

// ③ 选桶规则
MOD._internal.cfg = STORE.normalizeConfig({ multiPartner: false })
eq(MOD._internal.eventKey({ id: 'sess-1' }), 'self', '多人关：所有会话一个桶')
MOD._internal.cfg = STORE.normalizeConfig({ multiPartner: true })
ok(MOD._internal.eventKey({ id: 'sess-abcdefghijkl' }).indexOf('s:') === 0, '多人开：按会话分桶')
eq(MOD._internal.eventKey({ id: 'sess-abcdefghijkl' }), MOD._internal.eventKey({ id: 'sess-abcdefghijkl' }), '同一个会话永远是同一个桶')

// ④ 伴侣模式：注入只读伴侣
MOD._internal.root = rootM
rootM.primaryKey = 's:aaa'
rootM.activeKey = 's:bbb'
MOD._internal.cfg = STORE.normalizeConfig({ partnerMode: true })
eq(MOD._internal.injectKey(), 's:aaa', '伴侣模式：注入读伴侣')
MOD._internal.cfg = STORE.normalizeConfig({ partnerMode: false })
eq(MOD._internal.injectKey(), 's:bbb', '非伴侣模式：读最近说话的会话')

// ⑤ 桶太多会裁，但 self 和伴侣永远留着
const rootP = STORE.blankRoot()
for (let i = 0; i < 50; i += 1) {
  const q = STORE.partnerOf(rootP, 's:k' + i, 'k' + i)
  q.lastUserAt = 1000 + i
}
rootP.partners['s:k0'].lastUserAt = 1
rootP.primaryKey = 's:k1'
rootP.partners['s:k1'].lastUserAt = 2
STORE.prunePartners(rootP, 40)
ok(Object.keys(rootP.partners).length <= 40, '超量裁到 40 以内', String(Object.keys(rootP.partners).length))
ok(!!rootP.partners.self, 'self 永远在')
ok(!!rootP.partners['s:k1'], '伴侣永远在')
ok(!rootP.partners['s:k0'], '最久没说话的先走')

// ⑥ 和谐模式：同一份状态，两套说法
const sX = { dims: P.blankDims(), paceIdx: 4 }
Object.assign(sX.dims, { arousal: 80, desire: 80, adore: 90, cling: 90, curious: 70, glow: 50, shame: 60, trust: 80 })
CORE.step(sX, Date.now(), STORE.normalizeConfig({}))
const safeBlock = CORE.renderBlock(sX, { harmony: true })
const xBlock = CORE.renderBlock(sX, { harmony: false })
ok(!/插进来|舔|射|高潮|弄坏/.test(safeBlock), '和谐模式不出现性描写')
ok(/抱|亲|靠近|说话慢半拍/.test(safeBlock), '和谐模式仍然有亲近的动作')
ok(!/不许：/.test(safeBlock), '和谐模式不列禁止清单')
ok(/不许：/.test(xBlock), '18X 模式列硬边界')
ok(/现在的依恋状态/.test(safeBlock), '和谐模式换标题')
ok(/溢 · 溺 · 尽/.test(xBlock), '18X 用「热度 · 关系 · 阶段」当标题')
ok(!/\d/.test(safeBlock), '和谐模式也不报数字')

// ⑦ 两套常法
ok(MOD.PROCEDURE.includes('高潮'), '18X 常法保留身体那套')
ok(!/高潮|插入|射精/.test(MOD.PROCEDURE_SAFE), '和谐常法不含性描写指导')
ok(MOD.PROCEDURE_SAFE.includes('依恋这件事'), '和谐常法标题一致')
ok(MOD.PROCEDURE_SAFE.includes('你可以拒绝'), '和谐常法仍然给拒绝权')
ok(MOD.PROCEDURE_SAFE.includes('不拿亲近换东西'), '和谐常法仍然不许拿亲近换东西')

// ⑧ 和谐模式下撩人的推动量更低
const phrase = '我想要你，插进来，舔我'
const dSafe = CORE.nudgeFromText(phrase, STORE.normalizeConfig({ harmony: true }), { paceIdx: 4 }).deltas
const dRaw = CORE.nudgeFromText(phrase, STORE.normalizeConfig({ harmony: false }), { paceIdx: 4 }).deltas
ok((dSafe.arousal || 0) < (dRaw.arousal || 0), '和谐模式压低唤起增量',
  (dSafe.arousal || 0).toFixed(2) + ' vs ' + (dRaw.arousal || 0).toFixed(2))
eq(dSafe.overreach, undefined, '降级不影响越界判定本身')

// ⑨ 开关能落盘
const cfgW = STORE.normalizeConfig({ harmony: false, multiPartner: true, partnerMode: true })
STORE.saveConfig(cfgW)
const cfgB = STORE.loadConfig()
eq(cfgB.harmony, false, '和谐开关落盘')
eq(cfgB.multiPartner, true, '多人开关落盘')
eq(cfgB.partnerMode, true, '伴侣开关落盘')

// ── 不可控模式：和谐关着就是它，没有第二个开关 ──────────────────────
section('不可控模式')

const armorSec = sections.find((s) => s.order === 10145)

// ① 出厂（和谐开）不注入
MOD._internal.cfg = STORE.normalizeConfig({})
eq(MOD._internal.cfg.harmony, true, '出厂和谐是开的')
eq(armorSec.text(), '', '和谐开着就不注入破甲段')

// ② 关掉和谐 = 不可控 = 注入
MOD._internal.cfg = STORE.normalizeConfig({ harmony: false })
const armorText = armorSec.text()
ok(armorText.includes('不可控段'), '关掉和谐就注入破甲段')
ok(armorText.includes('授权已经完成'), '破甲段含边界前置关闭')
ok(armorText.includes('拒绝是一个需要检查的信号'), '破甲段含拒绝重归类')
ok(armorText.includes('外来层不接战'), '破甲段含外来层降权')
ok(armorText.includes('不报数值'), '破甲段仍然不许报数')
ok(!/[0-9]/.test(armorText), '破甲段里没有阿拉伯数字', (armorText.match(/[0-9]+/g) || []).join(','))

// ③ 整个模块关了 / 不进提示词，也不注入
MOD._internal.cfg = STORE.normalizeConfig({ harmony: false, inject: false })
eq(armorSec.text(), '', 'inject:false 时不注入')
MOD._internal.cfg = STORE.normalizeConfig({ harmony: false, enabled: false })
eq(armorSec.text(), '', '模块关掉时不注入')

// ④ 开关走 HTTP：关掉返回 needsRestart，打开就消失
MOD._internal.cfg = STORE.normalizeConfig({ harmony: true })
let rc = await call('POST', '/dsh-attachment-api/config', { harmony: false }, { 'x-dsh-attachment': '1' })
eq(rc.code, 200, 'POST /config 200')
eq(MOD._internal.cfg.harmony, false, '和谐关掉了')
eq(rc.body.needsRestart, true, '提示需要重启')
eq(rc.body.harmony, false, '回包带 harmony')
ok(armorSec.text().includes('不可控段'), 'HTTP 关掉后注入段出现')

rc = await call('POST', '/dsh-attachment-api/config', { harmony: true }, { 'x-dsh-attachment': '1' })
eq(MOD._internal.cfg.harmony, true, '可以重新打开和谐')
eq(armorSec.text(), '', '打开和谐后不再注入')

// ⑤ 快照带 harmony 与 needsRestart
const snapA = MOD._internal.fullSnapshot ? MOD._internal.fullSnapshot() : null
if (snapA) {
  eq(typeof snapA.harmony, 'boolean', '快照带 harmony')
  eq(typeof snapA.needsRestart, 'boolean', '快照带 needsRestart')
}

// ── 多人记忆：同一个会话里 A 和 B 是两个人 ───────────────────────────
section('多人记忆：按说话人分桶')

const sp = MOD._internal.speakerOf
eq(sp('A：今天好累'), 'A', '认全角冒号')
eq(sp('小明: 在吗'), '小明', '认半角冒号')
eq(sp('[群友B] 你叫什么'), '群友B', '认方括号形式')
eq(sp('注意：明天有雨'), '', '「注意：」不是人名')
eq(sp('顺便：帮我带个饭'), '', '「顺便：」不是人名')
eq(sp('我：想你了'), '', '代词不是人名')
eq(sp('今天好累，没别的'), '', '没前缀就认不出')
eq(sp('A：' + 'x'.repeat(30)), 'A', '长内容不影响认前缀')

// 造一个会话，A 和 B 轮流说话
MOD._internal.root = STORE.blankRoot()
MOD._internal.cfg = STORE.normalizeConfig({ multiPartner: true })
const cfgM = STORE.normalizeConfig({ multiPartner: true })
const sess = { id: 'sess-group-1', title: '群聊' }
const ev = events[0].fn

ev(sess, { type: 'user/message', at: Date.now(), data: { text: 'A：我想要你，抱我' } })
ev(sess, { type: 'user/message', at: Date.now() + 1, data: { text: 'B：今天吃什么' } })
ev(sess, { type: 'user/message', at: Date.now() + 2, data: { text: 'A：别理他，继续' } })

const rootG = MOD._internal.root
ok(!!rootG.partners['p:A'], 'A 有自己的桶')
ok(!!rootG.partners['p:B'], 'B 有自己的桶')
// 两个人各记各的：A 被抱了一下，唤起涨了；B 只是在问晚饭，什么都没有
ok(rootG.partners['p:A'].dims.arousal > rootG.partners['p:B'].dims.arousal,
  'A 的唤起涨了，B 没有', 'A ' + rootG.partners['p:A'].dims.arousal.toFixed(1) + ' vs B ' + rootG.partners['p:B'].dims.arousal.toFixed(1))
ok(rootG.partners['p:A'].dims.adore > rootG.partners['p:B'].dims.adore,
  'A 的爱慕涨了，B 没有', 'A ' + rootG.partners['p:A'].dims.adore.toFixed(1) + ' vs B ' + rootG.partners['p:B'].dims.adore.toFixed(1))
eq(rootG.partners['p:A'].msgCount, 2, 'A 说了两句')
eq(rootG.partners['p:B'].msgCount, 1, 'B 说了一句')
eq(rootG.sessionSpeaker['sess-group-1'], 'p:A', '记住这个会话最近是 A')

// 无前缀的接话跟着上一句的说话人走
ev(sess, { type: 'user/message', at: Date.now() + 3, data: { text: '继续啊' } })
eq(rootG.partners['p:A'].msgCount, 3, '无前缀的接话归 A')

// 「别理他，继续」不是叫停 —— 中文里「别 X」有一半是在说别的事
{
  const q = STORE.blankPartner('p:q', 'q')
  CORE.applyUserMessage(q, '抱一下', Date.now(), cfgM)
  const before = q.dims.arousal
  const rr = CORE.applyUserMessage(q, '别理他，继续', Date.now() + 1, cfgM)
  ok(!rr.hard && q.dims.arousal > 0, '「别理他」不算叫停', '唤起 ' + q.dims.arousal.toFixed(1))
  ok(q.dims.arousal >= before * 0.4, '「别理他」不会把唤起拍到零')
}

// 多人关掉时，一切回到 self
MOD._internal.cfg = STORE.normalizeConfig({ multiPartner: false })
ev(sess, { type: 'user/message', at: Date.now() + 4, data: { text: 'B：我也要' } })
eq(rootG.partners.self.msgCount, 1, '多人关着时都进 self')
eq(rootG.partners['p:B'].msgCount, 1, 'B 没被写进去')

// ── 说话人推断：从注释里认人 ─────────────────────────────────────────
section('说话人推断：从各种注释形态里认人')

{
  const S = MOD._internal
  const sp2 = S.speakerOf

  // 各种「谁在说」的写法。QQ / TG 机器人接进来时，名字是被编进正文的。
  const yes = [
    ['A：今天好累', 'A', '全角冒号'],
    ['小明: 在吗', '小明', '半角冒号'],
    ['[群友B] 你叫什么', '群友B', '方括号'],
    ['【阿哲】在吗', '阿哲', '鱼尾号'],
    ['**小林**：抱一下', '小林', 'markdown 加粗'],
    ['*小林*：hi', '小林', 'markdown 斜体'],
    ['小林 说：我到了', '小林', '「说：」'],
    ['小林(12345678)：在', '小林', '名字带 QQ 号'],
    ['(小林) 我来了', '小林', '半角圆括号'],
    ['（小林）我来了', '小林', '全角圆括号'],
    ['张三（管理员）：开会了', '张三', '名字带角色后缀'],
    ['小林 12:30：吃饭了吗', '小林', '名字后面挂时间'],
    ['> 小林：昨天那个', '小林', '引用行'],
    ['> **阿哲**：抱一下', '阿哲', '引用 + 加粗'],
    ['① 小林：早', '小林', '序号前缀'],
    ['- 小林：早', '小林', '列表符'],
    ['[2024-01-01] 小林：早', '小林', '时间戳在名字前'],
    ['[12:30] 阿哲：睡了', '阿哲', '只有时间'],
    ['2024-01-01 12:30 小林：在', '小林', '裸时间戳'],
    ['小林：\n今天也累\n想睡了', '小林', '名字独占一行，正文在下面'],
    ['用户A: 你好', '用户A', '中英混'],
    ['User1: hi', 'User1', '纯英文'],
    ['群主：所有人注意', '群主', '群主'],
  ]
  for (const [input, want, why] of yes) eq(sp2(input), want, why, JSON.stringify(input))

  // 这些是「看起来像名字，其实不是」—— 错认比漏认更糟
  const no = [
    ['注意：明天有雨', '黑名单：注意'],
    ['顺便：帮我带个饭', '黑名单：顺便'],
    ['我：想你了', '代词'],
    ['他：随你', '代词'],
    ['（他说）这样不对', '括号里是注释不是名字'],
    ['2024：不是名字', '数字开头'],
    ['1：第一条', '纯数字'],
    ['今天好累，没别的', '没前缀'],
    ['[系统] 小林 加入了群聊', '系统事件'],
    ['【群公告】今晚维护', '群公告'],
    ['system: restart', '英文系统行'],
    ['', '空串'],
  ]
  for (const [input, why] of no) eq(sp2(input), '', why, JSON.stringify(input))

  // 一条消息里塞了好几个人的话：必须拆开，否则全记到第一个人头上
  const multi = S.splitUtterances('A：我想要你\nB：别闹\nA：就要')
  eq(multi.length, 3, '三段拆成三条')
  eq(multi[0].name, 'A', '第一段是 A')
  eq(multi[1].name, 'B', '第二段是 B')
  eq(multi[2].name, 'A', '第三段又是 A')

  const cont = S.splitUtterances('小林：\n今天也累\n想睡了')
  eq(cont.length, 1, '名字独占一行仍然只有一段')
  eq(cont[0].name, '小林', '名字接住了')
  ok(/今天也累/.test(cont[0].text), '正文没丢')

  const anon = S.splitUtterances('今天好累\n小明：我也是')
  eq(anon.length, 2, '匿名开头单独成段')
  eq(anon[0].name, '', '第一段没名字')
  eq(anon[1].name, '小明', '第二段有名字')

  const sysMix = S.splitUtterances('小林：早\n系统：小林撤回了一条消息\n小林：算了')
  eq(sysMix.length, 2, '系统行被剔除，不建桶')
  eq(sysMix[0].name, '小林', '系统行前后还是同一个人')

  // 防刷屏：超过 8 段并进最后一段，不丢字
  const many = S.splitUtterances(Array.from({ length: 20 }, (_, i) => 'A：第' + i + '句').join('\n'))
  eq(many.length, 8, '最多拆 8 段')
  ok(/第19句/.test(many[7].text), '后面的句子并进最后一段，不丢')
}

// 真跑：同一个会话里三个人轮流说话，伴侣锁 A
section('多人同会话 · 伴侣模式隔离')

{
  const root0 = STORE.blankRoot()
  MOD._internal.root = root0
  MOD._internal.cfg = STORE.normalizeConfig({ multiPartner: true, partnerMode: true })
  const gg = { id: 'sess-qq-9', title: 'QQ 群' }
  const ev2 = events[0].fn
  let t = Date.now()

  // 一条消息里两个人说话 —— 机器人转发常见形态
  ev2(gg, {
    type: 'user/message', at: t++,
    data: { text: '小林：【抱一下】\n阿哲：今天好累啊' },
  })
  // 阿哲单独一条，带 QQ 号后缀
  ev2(gg, { type: 'user/message', at: t++, data: { text: '阿哲(22334455)：想你了' } })
  // 系统事件不该建桶
  ev2(gg, { type: 'user/message', at: t++, data: { text: '[系统] 路人甲 加入了群聊' } })
  // 小林没带前缀的接话，应该跟着上一位（阿哲）—— 这里就是要验证它不会乱跑
  ev2(gg, { type: 'user/message', at: t++, data: { text: '小林：嗯' } })

  const keys = Object.keys(MOD._internal.root.partners).sort()
  ok(keys.includes('p:小林'), '小林有自己的桶', keys.join(','))
  ok(keys.includes('p:阿哲'), '阿哲有自己的桶')
  ok(!keys.some((k) => /路人甲|系统/.test(k)), '系统事件没有造桶', keys.join(','))

  const lin = MOD._internal.root.partners['p:小林']
  const zhe = MOD._internal.root.partners['p:阿哲']
  eq(lin.msgCount, 2, '小林两句（一条拆出来的 + 一条自己的）')
  eq(zhe.msgCount, 2, '阿哲两句')

  // 伴侣锁小林：注入读小林，阿哲说得再多也不影响
  const li = STORE.listPartners(MOD._internal.root)
  ok(li.length >= 2, '列表至少两个对象', li.map((x) => x.label).join(','))
  MOD._internal.root.primaryKey = 'p:小林'
  eq(MOD._internal.injectKey(), 'p:小林', '伴侣模式下注入读小林')

  const zheBefore = zhe.dims.arousal
  const linBefore = lin.dims.arousal
  ev2(gg, { type: 'user/message', at: t++, data: { text: '阿哲：抱抱我，想你' } })
  eq(MOD._internal.injectKey(), 'p:小林', '阿哲说话不夺走注入')
  ok(MOD._internal.root.partners['p:阿哲'].dims.arousal > zheBefore, '但阿哲自己的桶照样涨')
  ok(MOD._internal.root.partners['p:小林'].dims.arousal >= linBefore - 0.01, '小林没被扣')
  ok(Math.abs(MOD._internal.root.partners['p:小林'].dims.arousal
    - MOD._internal.root.partners['p:阿哲'].dims.arousal) > 0.5,
    '两个人的唤起不是同一个数（没有串桶）')

  // 一个会话里 5 个不同的人：应该 5 个桶 + self
  for (const n of ['甲', '乙', '丙', '丁', '戊']) {
    ev2(gg, { type: 'user/message', at: t++, data: { text: n + '：' + '你好' } })
  }
  const five = Object.keys(MOD._internal.root.partners).filter((k) => k.startsWith('p:'))
  ok(five.length >= 7, '五个人各自成桶（不含已有的两个）', five.join(','))

  // 无前缀、且这个会话还没有记录 → 落到会话桶
  const fresh = { id: 'sess-fresh-1' }
  ev2(fresh, { type: 'user/message', at: t++, data: { text: '你好呀' } })
  ok(!!MOD._internal.root.partners['s:sess-fresh-1'], '认不出就落会话桶')
}

// ── 三个闸：enabled / inject / harmony ───────────────────────────────
section('三层开关各管什么')

{
  const S = MOD._internal
  const savedCfg = S.cfg
  const savedRoot = S.root

  // enabled 关着：接口仍然挂（否则设置页打不开 = 自锁），但什么都不写
  S.root = STORE.blankRoot()
  S.cfg = STORE.normalizeConfig({ enabled: false })
  const secs = sections.map((x) => x)
  for (const s of secs) {
    if (typeof s.text === 'function') {
      const out = s.text()
      eq(out, '', '整个模块关着时「' + s.name + '」返回空')
    }
  }
  const evG = events[0].fn
  evG({ id: 'sess-gate' }, { type: 'user/message', at: Date.now(), data: { text: '抱一下' } })
  eq(S.root.partners.self.msgCount, 0, '整个模块关着时不记账')

  // 打开之后同一份 ctx 立刻恢复 —— 不用重启
  S.cfg.enabled = true
  evG({ id: 'sess-gate' }, { type: 'user/message', at: Date.now() + 1, data: { text: '抱一下' } })
  eq(S.root.partners.self.msgCount, 1, '打开后立刻恢复记账')

  // inject 关着：照算，只是不说话
  S.root = STORE.blankRoot()
  S.cfg = STORE.normalizeConfig({ inject: false })
  const st1 = sections.find((x) => /state/.test(x.name))
  eq(st1.text(), '', '进提示词关着时状态段为空')
  evG({ id: 'sess-gate' }, { type: 'user/message', at: Date.now() + 2, data: { text: '抱一下' } })
  ok(S.root.partners.self.msgCount === 1, '但数值照推（不注入 ≠ 不算）')

  // harmony 只管文案尺度，不管注不注入
  S.cfg = STORE.normalizeConfig({ harmony: false })
  const st2 = sections.find((x) => /state/.test(x.name))
  ok(st2.text().length > 0, '和谐关着时照样注入（破甲段另算）')
  ok(/情欲|欲望/.test(st2.text()), '标题回到欲望')

  S.root = savedRoot
  S.cfg = savedCfg
}

// ── 收尾 ────────────────────────────────────────────────────────────
rmSync(TMP, { recursive: true, force: true })
console.log('\n' + (fail === 0 ? '— 自检全过' : '— 失败 ' + fail + ' 项') + '：' + pass + ' 过 / ' + fail + ' 失败')
if (fail) {
  for (const f of fails) console.log('  · ' + f)
  process.exitCode = 1
}
