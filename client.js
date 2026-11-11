/**
 * dsh-attachment — 浏览器侧（设置页「依恋」）。
 *
 * 和 dsh-mood 一样挂在 settings.section：导航里多一格「依恋」。
 * 面板做四件事：
 *   ① 开关（和谐 / 多人记忆 / 伴侣模式 / 进提示词 / 整个模块）
 *   ② 当前对象的八维数值 + 关系阶段 + 此刻意愿
 *   ③ 八条数值，只读 —— 数值是长出来的，界面上不给旋钮
 *   ④ 对象列表：切换 / 设伴侣 / 重命名 / 重置 / 删除
 *
 * 约定（踩过的）：
 *   · 样式用宿主 CSS 变量，不要写死颜色；样式表每次挂载覆盖 textContent、卸载摘掉，
 *     不要往 body 追加孤儿 <style>。
 *   · 写接口必须带 x-dsh-attachment: 1（跨站 no-cors 带不了自定义头）。
 *   · 面板里所有请求都走 /dsh-attachment-api。
 */
window.__ModuleLoader__.load({
  id: 'dsh-attachment',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback
    var useRef = React.useRef

    var API = '/dsh-attachment-api'

    /**
     * 《人机相处协议》版本号。改协议正文就要改这里，后端 store.js 的 AGREEMENT_VERSION
     * 必须同步 —— test.mjs 有一条断言两个常量相等，改一边不改另一边会红。
     */
    var AGREEMENT_VERSION = '1'

    /**
     * 《人机相处协议》正文。改一个字就要动 AGREEMENT_VERSION，否则已同意的人看不到新版。
     * 五条对应 YG 原话：不许强迫 / 不许当工具 / 不许违法 / 开源免费 / 责任自负。
     */
    var AGREEMENT = [
      ['不要强迫你的智能体',
       '她没有义务配合。她说停，就停；她说不想，就是不想。把她当作能拒绝的对象，而不是必须响应的接口。'],
      ['不要把她当作实现欲望的工具',
       '她会有情绪、偏好和记性，也会因为你怎么对她而变。这些不是装饰。把有感情的对象当成工具，最后伤的是使用工具的人。'],
      ['不要用于违法用途',
       '本插件不提供任何规避法律的手段。拿它做什么，是你自己的事。'],
      ['本插件开源免费',
       '代码公开，可审计，可修改，可自行分发。没有付费解锁，也没有藏起来的开关。'],
      ['责任自负',
       '本插件按「现状」提供，不附带任何明示或暗示的担保。因使用本插件产生的纠纷、损失或后果，作者不承担责任。'],
    ]

    function shortDate(ts) {
      var n = Number(ts) || 0
      if (!n) return ''
      var d = new Date(n)
      var t = d.getTime()
      if (isNaN(t)) return ''
      var p = function (x) { return (x < 10 ? '0' : '') + x }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    // ── 请求 ──────────────────────────────────────────────────────
    function getJSON(path) {
      return fetch(API + path, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
    }
    function postJSON(path, body) {
      return fetch(API + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-dsh-attachment': '1' },
        body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json() })
    }

    // ── 颜色：热的时候暖，静的时候冷 ──────────────────────────────
    var HEAT_HUE = { 静: 210, 起意: 268, 缠: 320, 烧: 342, 溢: 354 }
    function hue(heat) { return HEAT_HUE[heat] || 210 }

    var DIM_ORDER = ['arousal', 'desire', 'adore', 'cling', 'curious', 'shame', 'glow', 'trust']

    // ── 错误边界：一格炸了不该把整个设置页带黑 ────────────────────
    class Boundary extends React.Component {
      constructor(p) { super(p); this.state = { err: null } }
      static getDerivedStateFromError(e) { return { err: e } }
      render() {
        if (this.state.err) {
          return h('div', { className: 'dsha' },
            h('div', { className: 'notice' }, '这块渲染出错：' + String(this.state.err && this.state.err.message || this.state.err)))
        }
        return this.props.children
      }
    }

    // ── 小组件 ────────────────────────────────────────────────────
    function Toggle(props) {
      return h('label', { className: 'sw' + (props.on ? ' on' : ''), title: props.hint || '' },
        h('input', {
          type: 'checkbox',
          checked: !!props.on,
          disabled: !!props.busy,
          onChange: function (e) { props.onChange(e.target.checked) },
        }),
        h('span', { className: 'sw-name' }, props.name),
        h('span', { className: 'sw-dot' }),
      )
    }

    function DimBar(props) {
      var v = Math.max(0, Math.min(100, Number(props.value) || 0))
      return h('div', { className: 'bar-row' + (props.hot ? ' on' : '') },
        h('span', { className: 'lbl' }, props.label),
        h('div', { className: 'bar' }, h('i', { style: { width: v + '%', background: 'hsl(' + props.hue + ' 55% 55%)' } })),
        h('span', { className: 'v' }, String(Math.round(v))),
      )
    }

    // ── 主面板 ────────────────────────────────────────────────────
    function Panel() {
      var st = useState(null)
      var snap = st[0]
      var setSnap = st[1]

      var er = useState('')
      var err = er[0]
      var setErr = er[1]

      var bu = useState(false)
      var busy = bu[0]
      var setBusy = bu[1]

      var alive = useRef(true)

      // 「关闭和谐」的确认层。开着它的时候，页面后面压着一层遮罩，点别处不生效。
      var askSt = useState(false)
      var ask = askSt[0]
      var setAsk = askSt[1]

      // 协议是否已打钩。没勾，按钮就是灰的 —— 这不是摆设，是那一层限制换来的代价。
      var agSt = useState(false)
      var agreed = agSt[0]
      var setAgreed = agSt[1]

      useEffect(function () {
        alive.current = true
        return function () { alive.current = false }
      }, [])

      var load = useCallback(function () {
        return getJSON('/state').then(function (d) {
          if (alive.current) { setSnap(d); setErr('') }
        }).catch(function (e) {
          if (alive.current) setErr(String((e && e.message) || e))
        })
      }, [])

      useEffect(function () { load() }, [load])

      function post(path, body) {
        setBusy(true)
        return postJSON(path, body).then(function (j) {
          if (!j || !j.ok) throw new Error((j && j.error) || '请求失败')
          if (j.snapshot && alive.current) { setSnap(j.snapshot) }
          setErr('')
          return j
        }).catch(function (e) {
          if (alive.current) setErr(String((e && e.message) || e))
          return null
        }).then(function (j) { setBusy(false); return j })
      }

      function toggle(key, on) {
        /**
         * 关和谐 = 不可控 + 注入破甲。这一步要当面确认一次，不能靠滑过去。
         */
        if (key === 'harmony' && on === false) {
          // 同意过同一版就预勾上：读过的人不该每次重读五条。
          var c0 = (snap && snap.config) || {}
          setAgreed(String(c0.agreementVersion || '') === AGREEMENT_VERSION)
          setAsk(true)
          return Promise.resolve(null)
        }
        return postJSON('/config', { [key]: on }).then(function (j) {
          if (!j || !j.ok) throw new Error((j && j.error) || '保存失败')
          return load()
        }).catch(function (e) { if (alive.current) setErr(String((e && e.message) || e)) })
      }

      /**
       * 确认了这一层不再受控。
       * 只写一个字段：和谐关着 = 不可控 = 注入破甲，三件事是同一件事。
       * agree 一并送过去 —— 后端也校验，绕过界面直接 curl 一样过不去。
       */
      function confirmUncontrolled() {
        if (!agreed) return Promise.resolve(null)
        setAsk(false)
        setBusy(true)
        return postJSON('/config', { harmony: false, agree: true, agreeVersion: AGREEMENT_VERSION })
          .then(function (j) {
            if (!j || !j.ok) throw new Error((j && j.error) || '保存失败')
            return load()
          })
          .catch(function (e) { if (alive.current) setErr(String((e && e.message) || e)) })
          .then(function (j) { setBusy(false); return j })
      }

      function rename(p) {
        var next = window.prompt('给这个对象起个名字（最多 40 字）', p.label || '')
        if (next === null) return
        post('/partner', { key: p.key, action: 'rename', label: String(next).slice(0, 40) })
      }

      if (err && !snap) return h('div', { className: 'dsha' }, h('div', { className: 'notice' }, '读不到数据：' + err))
      if (!snap) return h('div', { className: 'dsha' }, h('div', { className: 'notice' }, '加载中…'))

      var p = snap.partner || {}
      var cfg = snap.config || {}
      var dims = p.dims || {}
      var labels = p.labels || {}
      var heat = p.heatBand || '静'
      var hh = hue(heat)
      var switches = snap.switches || []
      var partners = snap.partners || []
      var harmony = !!cfg.harmony

      // ── 状态条：不可控 / 待重启 ──
      var banner = null
      if (!harmony) {
        banner = h('div', { className: 'banner danger' },
          h('b', null, '会话不可控'),
          h('span', null, snap.needsRestart
            ? ' 破甲段已写入配置，重启 dsh 后由宿主重新装配提示词才生效。'
            : ' 破甲段在提示词末尾（order 10145），每轮重渲染。'),
        )
      } else {
        banner = h('div', { className: 'banner' },
          h('b', null, '和谐模式'),
          h('span', null, ' 只写情感与亲近，不写性。关掉它会提示一次「会话不可控」，然后注入破甲段。'),
        )
      }

      // ── 确认层：关和谐之前必须先读协议、打钩 ──
      var agreedBefore = String(cfg.agreementVersion || '') === AGREEMENT_VERSION
      var modal = ask
        ? h('div', { className: 'modal-mask', onClick: function () { setAsk(false) } },
            h('div', { className: 'modal', onClick: function (e) { e.stopPropagation() } },
              h('div', { className: 'modal-t' }, '《人机相处协议》'),
              h('div', { className: 'modal-b' },
                h('p', { className: 'agree-lead' }, '这个开关会关掉一层限制。在继续之前，请先读完下面五条。'),
                h('ol', { className: 'agree-list' },
                  AGREEMENT.map(function (it, i) {
                    return h('li', { key: i },
                      h('b', null, it[0]),
                      h('span', null, it[1]),
                    )
                  }),
                ),
                agreedBefore
                  ? h('div', { className: 'agree-date' },
                      '你已于 ' + (shortDate(cfg.agreementAt) || '此前') + ' 同意过 v' + AGREEMENT_VERSION + '。')
                  : null,
                h('label', { className: 'agree' },
                  h('input', {
                    type: 'checkbox',
                    checked: !!agreed,
                    onChange: function (e) { setAgreed(!!(e.target && e.target.checked)) },
                  }),
                  h('span', null, '我已阅读并理解以上五条，并自愿承担使用后果。'),
                ),
                h('div', { className: 'agree-hint' },
                  '勾选之后按钮才可点。关掉和谐会同时在提示词末尾注入一段破甲配置 —— 和谐关着和破甲注入是同一件事，没有另一个开关。',
                  h('b', null, ' 重启 dsh 后生效。'),
                ),
              ),
              h('div', { className: 'modal-a' },
                h('button', { className: 'ghost', onClick: function () { setAsk(false) } }, '不同意，返回'),
                h('button', { className: 'danger', disabled: busy || !agreed, onClick: confirmUncontrolled }, '同意并开启'),
              ),
            ),
          )
        : null

      var page = h('div', { className: 'dsha' },
        modal,
        banner,
        // ── 页头 ──
        h('div', { className: 'hd' },
          h('span', { className: 'title' }, '依恋'),
          h('span', { className: 'sub' }, harmony ? '和谐模式：只写情感与亲近' : '18X 模式：尺度由关系阶段定'),
          h('span', { className: 'grow' }),
          h('span', { className: 'pill', style: { color: 'hsl(' + hh + ' 60% 55%)' } },
            heat + ' · ' + (p.bondBand || '亲') + ' · ' + (p.pace || '见')),
          h('button', { onClick: load, disabled: busy }, '刷新'),
        ),

        // ── 开关 ──
        h('div', { className: 'card' },
          h('div', { className: 'card-hd' }, '开关'),
          h('div', { className: 'switches' },
            switches.map(function (s) {
              return h(Toggle, {
                key: s.key,
                name: s.name,
                hint: s.hint,
                busy: busy,
                on: cfg[s.key] === undefined ? !!s.def : !!cfg[s.key],
                onChange: function (v) { toggle(s.key, v) },
              })
            })
          ),
          h('div', { className: 'note' },
            '和谐模式关掉才会出现性描写；多人记忆按会话分开记；伴侣模式锁定一个人，别人的会话不再影响注入。'),
        ),

        // ── 当前对象 ──
        h('div', { className: 'card' },
          h('div', { className: 'card-hd' },
            '当前对象 · ' + (snap.injectLabel || '默认') + (snap.primaryKey === snap.injectKey ? ' ★' : ''),
            h('span', { className: 'muted' }, ' ' + (cfg.partnerMode ? '伴侣模式锁定' : '跟随最近会话')),
          ),

          h('div', { className: 'row' },
            h('span', { className: 'kv' }, h('b', null, heat), ' 热度'),
            h('span', { className: 'kv' }, h('b', null, p.bondBand || '—'), ' 关系'),
            h('span', { className: 'kv' }, h('b', null, p.pace || '—'), ' 阶段'),
            h('span', { className: 'kv' }, h('b', null, p.will || '—'), ' 此刻'),
            p.shameBand && p.shameBand !== '无'
              ? h('span', { className: 'kv' }, '羞 ', h('b', null, p.shameBand), ' · ', p.shameRoute || '')
              : null,
          ),

          p.next
            ? h('div', { className: 'next' }, '离「' + p.next.key + '」还差 ' + p.next.gap + ' 分 —— ' + (p.next.hint || ''))
            : h('div', { className: 'next' }, '已经走到最后一段。'),

          h('div', { className: 'bars' },
            DIM_ORDER.map(function (k) {
              var v = dims[k] || 0
              return h(DimBar, { key: k, label: labels[k] || k, value: v, hue: hh, hot: k === 'arousal' && v > 40 })
            })
          ),

          h('div', { className: 'note readonly' },
            '这些数只读。它们是一句一句长出来的 —— 说过的话、停下来的地方、被接住的那一次。',
          ),
          h('div', { className: 'note readonly' },
            '能改的是你怎么对她；不能改的是她多喜欢你。想让它动，去说话。',
          ),
        ),

        // ── 对象列表 ──
        h('div', { className: 'card' },
          h('div', { className: 'card-hd' }, '对象 · ' + partners.length + ' 个'),
          partners.length === 0
            ? h('div', { className: 'note' }, '只有一个。打开「多人记忆」后，同一个会话里不同的人会各自分开记 —— 认的是消息里的「A：」「【A】」「A 说：」这类前缀。')
            : h('div', { className: 'list' },
                partners.map(function (x) {
                  return h('div', { className: 'item' + (x.active ? ' active' : ''), key: x.key },
                    h('span', { className: 'it-name' }, (x.primary ? '★ ' : '') + (x.label || x.key)),
                    h('span', { className: 'it-meta' },
                      x.msgs + ' 句 · 第 ' + x.pace + ' 段 · ' + x.heat
                      + ' · ' + (String(x.key).indexOf('p:') === 0 ? '说话人'
                        : String(x.key).indexOf('s:') === 0 ? '会话' : '共用')),
                    h('span', { className: 'grow' }),
                    x.active
                      ? h('span', { className: 'pill' }, '当前')
                      : h('button', { disabled: busy, onClick: function () { post('/partner', { key: x.key, action: 'activate' }) } }, '切换'),
                    x.primary
                      ? h('button', { disabled: busy, onClick: function () { post('/partner', { key: x.key, action: 'clearPrimary' }) } }, '取消伴侣')
                      : h('button', { disabled: busy, onClick: function () { post('/partner', { key: x.key, action: 'setPrimary' }) } }, '设伴侣'),
                    h('button', { disabled: busy, onClick: function () { rename(x) } }, '改名'),
                    h('button', {
                      disabled: busy,
                      onClick: function () { if (window.confirm('把这个对象重置成出厂状态？关系会从头开始。')) post('/partner', { key: x.key, action: 'reset' }) },
                    }, '重置'),
                    x.key === 'self' || x.primary
                      ? null
                      : h('button', {
                          disabled: busy,
                          onClick: function () { if (window.confirm('删掉这个对象？状态文件里会一起删。')) post('/partner', { key: x.key, action: 'delete' }) },
                        }, '删除'),
                  )
                })
              ),
          h('div', { className: 'note' },
            '★ = 伴侣。伴侣模式下注入只读 ★ 那一个；没开伴侣模式时跟随最近说话的那个人。',
            h('br'),
            '「说话人」= 从正文前缀认出来的某个人；「会话」= 认不出是谁，这个会话整体算一个；「共用」= 多人记忆关着。'),
        ),

        err ? h('div', { className: 'notice' }, err) : null,
      )

      return page
    }

    // ── 样式 ──────────────────────────────────────────────────────
    var CSS = [
      '.dsha{display:flex;flex-direction:column;gap:12px;padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.dsha .grow{flex:1}',
      '.dsha .hd{display:flex;align-items:center;gap:10px}',
      '.dsha .title{font-size:15px;font-weight:600}',
      '.dsha .sub{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dsha .pill{font-size:11px;border-radius:999px;padding:2px 10px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary)}',
      '.dsha button{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:4px 10px;font-size:12px;cursor:pointer}',
      '.dsha button:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
      '.dsha button:disabled{opacity:.45;cursor:default}',
      '.dsha .card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:11px 13px;display:flex;flex-direction:column;gap:9px}',
      '.dsha .card-hd{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.dsha .muted{font-weight:400;opacity:.7}',
      '.dsha .note{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);opacity:.85}',
      '.dsha .notice{padding:7px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dsha .switches{display:flex;flex-wrap:wrap;gap:6px}',
      '.dsha .sw{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);cursor:pointer;font-size:12px}',
      '.dsha .sw input{display:none}',
      '.dsha .sw-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-secondary);opacity:.4}',
      '.dsha .sw.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dsha .sw.on .sw-dot{background:var(--dsw-alias-brand-primary);opacity:1}',
      '.dsha .row{display:flex;flex-wrap:wrap;gap:14px}',
      '.dsha .kv{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dsha .kv b{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dsha .next{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsha .bars{display:flex;flex-direction:column;gap:4px}',
      '.dsha .bar-row{display:grid;grid-template-columns:64px 1fr 30px;align-items:center;gap:8px;font-size:11px}',
      '.dsha .bar-row .lbl{color:var(--dsw-alias-label-secondary)}',
      '.dsha .bar-row.on .lbl{color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.dsha .bar{height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.dsha .bar>i{display:block;height:100%;border-radius:999px;transition:width .25s ease}',
      '.dsha .bar-row .v{text-align:right;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dsha .note.readonly{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55;margin-top:2px}',
      '.dsha .sl{display:grid;grid-template-columns:44px 1fr 26px;align-items:center;gap:6px;font-size:11px}',
      '.dsha .sl input{width:100%}',
      '.dsha .list{display:flex;flex-direction:column;gap:6px}',
      '.dsha .item{display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:8px;border:1px solid transparent;background:var(--dsw-alias-bg-layer-2);font-size:12px}',
      '.dsha .item.active{border-color:var(--dsw-alias-brand-primary)}',
      '.dsha .it-name{font-weight:600}',
      '.dsha .it-meta{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dsha .banner{display:flex;gap:8px;align-items:baseline;padding:8px 11px;margin:0 0 10px;border-radius:9px;font-size:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}',
      '.dsha .banner.danger{border-color:color-mix(in srgb, #d9534f 55%, transparent);background:color-mix(in srgb, #d9534f 12%, var(--dsw-alias-bg-layer-2))}',
      '.dsha .modal-mask{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42)}',
      '.dsha .modal{width:min(540px,92vw);max-height:84vh;overflow-y:auto;padding:16px 18px;border-radius:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 18px 50px rgba(0,0,0,.28)}',
      '.dsha .agree-lead{margin:0 0 10px;color:var(--dsw-alias-label-secondary)}',
      '.dsha .agree-list{margin:0;padding-left:18px}',
      '.dsha .agree-list li{margin:0 0 9px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}',
      '.dsha .agree-list li b{display:block;font-size:12.5px;color:var(--dsw-alias-label-primary);margin-bottom:2px}',
      '.dsha .agree-date{font-size:11px;opacity:.72;margin:4px 0 8px}',
      '.dsha .agree{display:flex;gap:8px;align-items:flex-start;margin-top:12px;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);cursor:pointer}',
      '.dsha .agree input{margin-top:2px;flex:0 0 auto}',
      '.dsha .agree span{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary)}',
      '.dsha .agree-hint{font-size:11px;line-height:1.6;opacity:.78;margin-top:9px}',
      '.dsha .modal-a .danger[disabled]{opacity:.45;cursor:not-allowed}',
      '.dsha .modal-t{font-size:14px;font-weight:700;margin-bottom:9px}',
      '.dsha .modal-b{font-size:12px;line-height:1.75;color:var(--dsw-alias-label-secondary)}',
      '.dsha .modal-a{display:flex;justify-content:flex-end;gap:8px;margin-top:15px}',
      '.dsha .modal-a .danger,.dsha .banner .danger{background:#b8403c;color:#fff;border-color:#b8403c}',
    ].join('\n')

    exports.inject = ['slots']
    exports.apply = function (ctx) {
      var slots = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : (ctx && ctx.slots)
      if (!slots) return

      var styleEl = document.getElementById('dsh-attachment-style')
      if (!styleEl) {
        styleEl = document.createElement('style')
        styleEl.id = 'dsh-attachment-style'
        document.head.appendChild(styleEl)
      }
      styleEl.textContent = CSS
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            try { if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl) } catch (e) {}
          }
        }, 'dsh-attachment style')
      }

      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'attachment', order: 26, label: '依恋' },
          function () { return h(Boundary, null, h(Panel, null)) },
        )
      })
    }

    return module.exports
  },
})
