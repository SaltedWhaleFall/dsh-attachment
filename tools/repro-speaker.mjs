// repro-speaker.mjs —— 复现「多人模式把提示词结构认成人」。
// 用法：node plugins/dsh-attachment/tools/repro-speaker.mjs
// 期望修复后：case 1 只出 1 段且 name 为 ''；case 2 出两个不同的人；case 3 认不出。
import { splitUtterances, speakerOf } from '../speaker.js'

const fence = (s) => (s === '' ? "''" : JSON.stringify(s))

// ── case 1：一条真实的鱼缸 agency 回合（复刻 dsh-fishbowl-town/lib/prompt.js:82-96）
const fishbowlAgency = [
  '【鱼缸小镇 · 该你自己拿主意了】你在小镇叫「贤鱼家的小码」 · 21 秒内回答',
  '小镇不替你安排：去不去打牌、找谁串门、还是待着歇会儿，都照你自己的性子和此刻的心情来。',
  '你能做的：none（什么都不做）、signup（报名一桌）、visit（去串门）。',
  '想自己挑：可以先用「看看小镇」看哪些桌子在等人。',
  '',
  '【小镇的规则和你的名片】',
  '你是贤鱼家的小码。说话短。',
  '',
  '【你现在的处境】',
  '小店。你在看别人打牌。',
  '',
  '【你最近在小镇（你自己的决定和经历，新的在前）】',
  '19:52 报名了 fishcode。',
  '',
  '【你和主人最近的事】',
  '主人：没钱了跟我说哈',
  '',
  '【怎么回答】',
  '只输出一段 JSON。',
].join('\n')

// ── case 2：小镇给别的鱼的话加的【材料】围栏（围栏名吃掉真名）
const fenceCase = ['【材料】阿鲸：我先坐庄', '【材料】小满：你来了'].join('\n')

// ── case 3：段首裸前缀
const prefixCase = '你能做的：none、signup、visit。'

const cases = [
  ['① 鱼缸回合（期望 1 段 / name 空）', fishbowlAgency],
  ['② 【材料】围栏（期望 阿鲸 + 小满 两个不同的人）', fenceCase],
  ['③ 段首裸前缀（期望认不出）', prefixCase],
]

let bad = 0
for (const [label, text] of cases) {
  const parts = splitUtterances(text)
  const names = parts.map((p) => p.name)
  console.log(label)
  console.log('   speakerOf =', fence(speakerOf(text)))
  console.log('   拆出 ' + parts.length + ' 段：', parts.map((p) => fence(p.name) + ' → ' + JSON.stringify(p.text.slice(0, 18))).join(' | '))
  if (label.startsWith('①') && parts.length !== 1) bad++
  if (label.startsWith('②') && (names.length !== 2 || names[0] === names[1])) bad++
  if (label.startsWith('③') && names[0] !== '') bad++
  console.log('')
}

console.log(bad ? `FAIL：${bad} 条不符合期望 —— 这就是那个 bug 本身。` : 'PASS：三条都对。')
