/**
 * speaker.js —— 从一条消息里认出「是谁在说」。
 *
 * 为什么需要这一层：插件的宿主只给一坨文本，不给发送者 id。接 QQ / TG 机器人时，
 * 「谁说的」是被编进正文里的。各家机器人的格式还不一样，所以这里不赌一种写法，
 * 而是逐层剥：装饰符 → 时间戳 → 前缀 → 名字合法性。剥到能认就认，认不出就老实返回 ''。
 *
 * 三条原则：
 *   ① 宁可漏认，不要错认。把「注意：」当成一个人，那条消息的好感度就记到不存在的人身上了。
 *   ② 系统事件不算人。入群、退群、撤回、禁言、公告——那是事件，不是谁在跟她说话。
 *   ③ 一条消息里可能塞了好几个人的话（机器人批量转发），要拆开，否则全记到第一个人头上。
 */

// ── 名字黑名单：这些「名字」其实是句子开头的普通词 ──────────────────

const SPEAKER_BLOCK = new Set([
  '注意', '提醒', '说明', '问题', '答案', '顺便', '另外', '其实', '不过', '所以', '但是', '因为',
  '然后', '最后', '总结', '补充', '备注', '例如', '比如', '前提', '背景', '结论', '原因', '目标',
  '任务', '需求', '步骤', '方法', '结果', '时间', '地点', '状态', '信息', '内容', '标题', '正文',
  '回复', '提示', '注', 'ps', 'p.s', 'tip', 'note', 'todo', 'fixme',
  '转发', '来自', '原文', '引用', '回复', '系统', '公告', '通知', '警告', '错误', '成功', '失败',
  // 代词不做人名：谁都会说「我：」，那不是身份，是语气
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '她们', '咱', '咱们',
  // 英文里高频的假名字
  'ok', 'okay', 'yes', 'no', 'hi', 'hey', 'hello', 're', 'fw', 'fwd', 'attached', 'subject',
])

/** 以这些词开头的括号内容，是注释不是名字（「（他说）这样不对」）。 */
const NOT_NAME_HEAD = /^(?:他说|她说|我说|它说|你们|我们|他们|这样|那样|这个|那个|这里|那里|其实|所以|但是|不过|因为|如果|就是|然后|另外|顺便|上面|下面|前面|后面|以上|以下|注意|提醒)/

/**
 * 系统事件行。整条丢掉 —— 它不含任何「谁对她说了什么」，只有事件流水。
 * 认成一个人的话，会凭空长出一个叫「系统」的对象，而且它永远停在第一段。
 */
const SYS_LINE = /^[ \t]*[【\[［(（]?[ \t]*(?:系统|群公告|群通知|群消息|公告|通知|管理员|群管|群主操作|机器人|bot|system|sys|notice|admin)[ \t]*[】\]］)）]?[ \t]*[:：]?[ \t]*(?=\S)/i

// ── 剥装饰：引用符、列表符、序号、编号 ────────────────────────────

const DECO = [
  /^[ \t]*>[ \t]*>?[ \t]*/,
  /^[ \t]*[-*+•·][ \t]+/,
  /^[ \t]*\d{1,2}[.)、][ \t]*/,
  /^[ \t]*[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳][ \t]*/,
  /^[ \t]*\[\d{1,2}\][ \t]*/,
]

// ── 剥时间戳：[2024-01-01] / [12:30] / 2024-01-01 12:30 ──────────

const STAMP = [
  /^[ \t]*\[\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?\][ \t]*/,
  /^[ \t]*\[\d{1,2}:\d{2}(?::\d{2})?\][ \t]*/,
  /^[ \t]*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}[ T]\d{1,2}:\d{2}(?::\d{2})?[ \t]+/,
  /^[ \t]*\d{1,2}:\d{2}(?::\d{2})?[ \t]+/,
]

/** 反复剥，直到不再变化（`> 1. [12:30] A：` 这种叠加也能剥干净）。 */
function stripLead(line) {
  let s = String(line || '')
  for (let i = 0; i < 5; i++) {
    const before = s
    for (const re of DECO) s = s.replace(re, '')
    for (const re of STAMP) s = s.replace(re, '')
    if (s === before) break
  }
  return s
}

// ── 前缀形态。顺序 = 优先级：包得越死的越先认 ────────────────────

const PATTERNS = [
  // 【小林】内容 / [小林] 内容 / ［小林］内容 —— 冒号可有可无
  { re: /^[【\[［]([^】\]］\n]{1,16})[】\]］][ \t]*[:：]?[ \t]*/ },
  // **小林**：内容 / *小林*：内容
  { re: /^\*{1,2}([^*\n]{1,16})\*{1,2}[ \t]*[:：]?[ \t]*/ },
  // 小林(12345678)：内容 —— 括号里是 QQ 号 / 群名片后缀，丢掉
  { re: /^([^\s:：()（）\n]{1,16})[ \t]*[（(][^）)\n]{0,24}[）)][ \t]*[:：][ \t]*/ },
  // 小林 12:30：内容 —— 名字后面挂时间
  { re: /^([^\s:：\n]{1,16})[ \t]+\d{1,2}:\d{2}(?::\d{2})?[ \t]*[:：][ \t]*/ },
  // 小林 说：内容 / 小林说道：内容
  { re: /^([^\s:：\n]{1,16})[ \t]*(?:说道|说|发言|写道)[ \t]*[:：][ \t]*/ },
  // （小林）内容 / (小林) 内容 —— 括号包着，后面不一定有冒号
  { re: /^[（(]([^）)\n]{1,16})[）)][ \t]*[:：]?[ \t]*/, needBody: true },
  // 小林：内容 / 小林: 内容 —— 最裸的一种，最后认
  { re: /^([^\s:：\n]{1,16})[ \t]*[:：][ \t]*/ },
]

/** 这段字像不像一个人的名字。 */
function looksLikeName(raw) {
  let name = String(raw || '').trim()
  name = name.replace(/^[「『"'“‘]+|[」』"'”’]+$/g, '').trim()
  if (!name || name.length > 16) return ''
  if (SPEAKER_BLOCK.has(name.toLowerCase())) return ''
  if (NOT_NAME_HEAD.test(name)) return ''
  if (/^\d+$/.test(name)) return ''                 // 纯数字：序号或时间
  if (/^\d/.test(name)) return ''                   // 数字开头：日期 / 编号
  if (!/[\w\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(name)) return ''  // 纯标点
  if (/[@#$%^&*+=|<>\\/{}[\]]/.test(name)) return '' // 这些符号不会出现在昵称前缀里
  return name
}

function isSystemLine(line) {
  return SYS_LINE.test(String(line || ''))
}

/**
 * 拆一行：返回 { name, body, system }。
 * name 为空表示「这行认不出是谁说的」，body 是剥掉前缀之后的正文。
 */
export function parseLine(line) {
  const raw = String(line || '')
  if (!raw.trim()) return { name: '', body: '', system: false }
  if (isSystemLine(raw)) return { name: '', body: '', system: true }
  const s = stripLead(raw)
  for (const p of PATTERNS) {
    const m = p.re.exec(s)
    if (!m) continue
    const name = looksLikeName(m[1])
    if (!name) continue
    const body = s.slice(m[0].length)
    // 只有名字没有内容（「小林：」单独一行）：这不是一句话，是下一条的开头。
    // 机器人换行输出时常这样（名字一行、正文另起一行），交给 bare 让调用方接住。
    if (!body.trim()) return { name: '', body: '', system: false, bare: name }
    return { name, body, system: false }
  }
  return { name: '', body: s, system: false }
}

/** 从一条消息里认第一个说话人。认不出返回 ''。 */
export function speakerOf(text) {
  const t = String(text || '')
  if (!t || t.length > 20000) return ''
  for (const line of t.split(/\r?\n/)) {
    if (!line.trim()) continue
    const p = parseLine(line)
    if (p.system) return ''
    if (p.name) return p.name
    // 「小林：」单独一行，正文在下一行 —— 说话人仍是小林
    if (p.bare) return p.bare
  }
  return ''
}

/**
 * 把一条消息拆成「谁说了什么」。
 *
 *   "A：我想要你\nB：别闹"
 *     → [{ name:'A', text:'我想要你' }, { name:'B', text:'别闹' }]
 *
 *   "今天好累\n小明：我也是"
 *     → [{ name:'', text:'今天好累' }, { name:'小明', text:'我也是' }]
 *
 * 没前缀的行接到上一段后面（续行）。开头就没有说话人的，单独成段、name 为空，
 * 由调用方决定它算谁的（通常是「这个会话上一位」）。
 *
 * max 是防刷屏的上限：超过的段落全部并进最后一段，不丢字，也不建第 9 个桶。
 */
export function splitUtterances(text, max = 8) {
  const src = String(text || '')
  if (!src) return []
  const lines = src.split(/\r?\n/)
  const out = []
  let cur = null
  let pending = ''          // 上一行只写了「名字：」，正文在下一行
  for (const line of lines) {
    if (!line.trim()) continue
    const p = parseLine(line)
    if (p.system) continue
    if (p.bare) { pending = p.bare; continue }   // 名字行，等正文
    if (pending && !p.name) {
      cur = { name: pending, text: p.body }
      out.push(cur)
      pending = ''
      continue
    }
    pending = ''
    if (p.name) {
      if (out.length >= Math.max(1, max) && cur) {
        cur.text += '\n' + p.body
        continue
      }
      cur = { name: p.name, text: p.body }
      out.push(cur)
      continue
    }
    if (cur) cur.text += '\n' + p.body
    else {
      cur = { name: '', text: p.body }
      out.push(cur)
    }
  }
  return out.filter((u) => u.text && u.text.trim())
}

export const _internals = { SPEAKER_BLOCK, PATTERNS, SYS_LINE, stripLead, looksLikeName, isSystemLine }
