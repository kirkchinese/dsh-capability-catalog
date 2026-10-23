// Browser half of @kirkchinese/dsh-capability-catalog.
// Plain JavaScript loaded by the Harness client module loader: React and Cordis come from
// the module table, styles use only --dsw-alias-* theme tokens, and every Host call goes
// through the authenticated Typert Remote channel (`ctx.remote.capabilityCatalog`).
window.__ModuleLoader__.load({
  id: '@kirkchinese/dsh-capability-catalog',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    const PACKAGE = '@kirkchinese/dsh-capability-catalog'
    const BUNDLE_KEYS = [PACKAGE, '@kirkchinese/dsh-re-kit']
    const identity = { parse: (value) => value }
    const TYPERT_REMOTE = {
      package: PACKAGE,
      descriptors: [{
        id: `${PACKAGE}#capabilityCatalog/request`,
        service: 'capabilityCatalog',
        namespace: 'capabilityCatalog',
        method: 'request',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'rawRequest',
          wire: 'rawRequest',
          source: 'json',
          codec: { mode: 'strict', typeSymbol: `${PACKAGE}#CatalogRequest`, create: () => identity },
        }],
        cancellation: { parameter: 'signal' },
        result: { mode: 'strict', typeSymbol: `${PACKAGE}#CatalogOverview`, create: () => identity },
        sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 },
      }],
    }

    // ---------------------------------------------------------------- locale
    const DICT = {
      zh: {
        title: '能力目录',
        summary: '常驻索引约 {chars} 字符 · {tools} 个工具 · {skills} 个 skill',
        servers: 'MCP 服务器',
        skills: 'Skill',
        noServers: '没有配置 MCP 服务器。在 profile 的 cordis.patch.yml 中添加，或安装 dsh-rea。',
        noSkills: '没有可用的 skill，或 skill 来源未启用。',
        tools: '{n} 个工具',
        connected: '运行中',
        idle: '未运行',
        problem: '异常',
        search: '搜索 skill',
        filterAll: '全部',
        filterOn: '已开启',
        filterOff: '已关闭',
        allOn: '全开',
        allOff: '全关',
        globalNote: '这里的开关作用于所有会话，立即生效。单个会话可以在输入框左侧的「能力」按钮中覆盖。关闭的服务器会停止运行。',
        noTakeover: '未接管 skill 目录（skills.takeOverCatalog 为 false）：skill 开关不会影响 DSH 原生的 skill 目录。',
        loading: '加载中…',
        retry: '重试',
        button: '能力',
        sessionTitle: '本会话的能力',
        sessionNote: '「默认」跟随全局设置。改动从下一步开始生效。',
        reset: '恢复默认',
        stateDefault: '默认',
        stateOn: '开',
        stateOff: '关',
        offCount: '{n} 项已关闭',
        close: '关闭',
        error: '出错了：{message}',
      },
      en: {
        title: 'Capability Catalog',
        summary: 'Standing index about {chars} chars · {tools} tools · {skills} skills',
        servers: 'MCP servers',
        skills: 'Skills',
        noServers: 'No MCP servers configured. Add one in the profile cordis.patch.yml, or install dsh-rea.',
        noSkills: 'No skills available, or the skill source is off.',
        tools: '{n} tools',
        connected: 'Running',
        idle: 'Idle',
        problem: 'Problem',
        search: 'Search skills',
        filterAll: 'All',
        filterOn: 'On',
        filterOff: 'Off',
        allOn: 'All on',
        allOff: 'All off',
        globalNote: 'These switches apply to every session immediately. A session can override them from the Capabilities button left of the input box. A server switched off stops running.',
        noTakeover: 'The skill catalog is not taken over (skills.takeOverCatalog is false): skill switches do not affect the native skill catalog.',
        loading: 'Loading…',
        retry: 'Retry',
        button: 'Capabilities',
        sessionTitle: 'Capabilities in this session',
        sessionNote: '"Default" follows the global setting. Changes apply from the next step.',
        reset: 'Reset',
        stateDefault: 'Default',
        stateOn: 'On',
        stateOff: 'Off',
        offCount: '{n} off',
        close: 'Close',
        error: 'Something went wrong: {message}',
      },
    }

    function format(text, values) {
      return text.replace(/\{(\w+)\}/g, (_, key) => (values && key in values ? String(values[key]) : `{${key}}`))
    }

    // ---------------------------------------------------------------- styles
    const STYLE_ID = 'capability-catalog-style'
    const CSS = `
.cc-page{display:flex;flex-direction:column;gap:20px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.cc-summary{color:var(--dsw-alias-label-secondary)}
.cc-note{color:var(--dsw-alias-label-secondary);font-size:12px}
.cc-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px}
.cc-section{display:flex;flex-direction:column;gap:8px}
.cc-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.cc-section-title{font-size:14px;font-weight:600}
.cc-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.cc-row{display:flex;align-items:center;gap:12px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.cc-row:first-child{border-top:none}
.cc-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.cc-row-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-row-desc{color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-family{display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:var(--dsw-alias-bg-layer-2);border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary)}
.cc-family:first-child{border-top:none}
.cc-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.cc-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.cc-dot[data-state=on]{background:var(--dsw-alias-state-success-primary)}
.cc-dot[data-state=error]{background:var(--dsw-alias-state-error-primary)}
.cc-switch{position:relative;flex:none;width:34px;height:20px;border-radius:10px;border:none;padding:0;cursor:pointer;background:var(--dsw-alias-border-l2);transition:background .15s}
.cc-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.cc-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s}
.cc-switch[aria-checked=true]::after{transform:translateX(14px)}
.cc-switch:disabled{opacity:.5;cursor:default}
.cc-switch:focus-visible,.cc-btn:focus-visible,.cc-seg button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.cc-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cc-input{flex:1;min-width:160px;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.cc-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.cc-btn{height:26px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}
.cc-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.cc-btn[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.cc-seg{display:inline-flex;flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;overflow:hidden}
.cc-seg button{height:24px;padding:0 9px;border:none;border-left:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.cc-seg button:first-child{border-left:none}
.cc-seg button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
.cc-seg button[data-value=off][aria-pressed=true]{color:var(--dsw-alias-state-error-primary)}
.cc-seg button[data-value=on][aria-pressed=true]{color:var(--dsw-alias-state-success-primary)}
.cc-trigger{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.cc-trigger:hover,.cc-trigger[aria-expanded=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.cc-trigger-badge{color:var(--dsw-alias-state-warn-primary)}
.cc-anchor{position:relative;display:inline-flex}
.cc-popover{position:absolute;bottom:calc(100% + 8px);left:0;z-index:50;width:380px;max-width:calc(100vw - 32px);max-height:min(560px,70vh);display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 28px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary);font-size:13px}
.cc-popover-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:600}
.cc-popover-body{overflow:auto;display:flex;flex-direction:column;gap:12px;margin:0 -4px;padding:0 4px}
.cc-sub{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
.cc-mini-row{display:flex;align-items:center;gap:8px;padding:5px 0}
.cc-mini-row .cc-row-main{gap:0}
`

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return () => undefined
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.setAttribute('data-plugin', PACKAGE)
      style.textContent = CSS
      document.head.appendChild(style)
      return () => style.remove()
    }

    // ---------------------------------------------------------------- data
    function createApi(remoteCtx) {
      const listeners = new Set()
      return {
        async request(request, signal) {
          const response = await remoteCtx.remote.capabilityCatalog.request(request, signal)
          if (!response || response.ok !== true) throw new Error((response && response.error && response.error.message) || 'Remote call failed')
          if (request.action === 'set') for (const listener of [...listeners]) listener()
          return response.value
        },
        onChange(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    function useOverview(api, sessionId, active) {
      const [state, setState] = useState({ data: null, error: null, loading: true })
      const generation = useRef(0)
      const load = useCallback(() => {
        const current = ++generation.current
        const controller = new AbortController()
        setState((previous) => ({ ...previous, loading: true }))
        api.request(sessionId ? { action: 'overview', sessionId } : { action: 'overview' }, controller.signal)
          .then((data) => { if (current === generation.current) setState({ data, error: null, loading: false }) })
          .catch((error) => { if (current === generation.current) setState((previous) => ({ data: previous.data, error, loading: false })) })
        return () => controller.abort()
      }, [api, sessionId])
      useEffect(() => (active ? load() : undefined), [load, active])
      useEffect(() => api.onChange(() => { if (active) load() }), [api, load, active])
      const set = useCallback(async (request) => {
        const data = await api.request({ action: 'set', ...request, ...(sessionId ? { sessionId } : {}) })
        generation.current++
        setState({ data, error: null, loading: false })
      }, [api, sessionId])
      return { ...state, reload: load, set }
    }

    // ---------------------------------------------------------------- controls
    function Switch({ checked, onChange, label, disabled }) {
      return h('button', {
        type: 'button', role: 'switch', className: 'cc-switch', 'aria-checked': checked, 'aria-label': label, disabled,
        onClick: () => onChange(!checked),
      })
    }

    function Segmented({ value, onChange, t, label }) {
      const options = [['default', t.stateDefault, null], ['on', t.stateOn, true], ['off', t.stateOff, false]]
      return h('div', { className: 'cc-seg', role: 'group', 'aria-label': label },
        options.map(([key, text, next]) => h('button', {
          key, type: 'button', 'data-value': key, 'aria-pressed': value === next,
          onClick: () => onChange(next),
        }, text)))
    }

    function StatusPill({ server, t }) {
      const state = server.problem ? 'error' : server.connected ? 'on' : 'idle'
      return h('span', { className: 'cc-pill', title: server.problem || undefined },
        h('span', { className: 'cc-dot', 'data-state': state }),
        state === 'error' ? t.problem : state === 'on' ? t.connected : t.idle)
    }

    function groupByFamily(skills) {
      const groups = new Map()
      for (const skill of skills) {
        if (!groups.has(skill.family)) groups.set(skill.family, [])
        groups.get(skill.family).push(skill)
      }
      return [...groups.entries()].sort((a, b) => (a[0] === 'general') - (b[0] === 'general') || b[1].length - a[1].length || a[0].localeCompare(b[0]))
    }

    function matches(skill, query) {
      if (!query) return true
      const q = query.toLowerCase()
      return skill.name.toLowerCase().includes(q) || skill.summary.toLowerCase().includes(q) || skill.family.toLowerCase().includes(q)
    }

    // ---------------------------------------------------------------- settings page
    function SettingsPage({ api, t }) {
      const { data, error, loading, reload, set } = useOverview(api, undefined, true)
      const [query, setQuery] = useState('')
      const [filter, setFilter] = useState('all')
      const [busy, setBusy] = useState(false)
      const [actionError, setActionError] = useState(null)
      const run = useCallback(async (requests) => {
        setBusy(true)
        setActionError(null)
        try {
          for (const request of requests) await set({ scope: 'global', ...request })
        } catch (err) {
          setActionError(err)
        } finally {
          setBusy(false)
        }
      }, [set])

      if (!data) {
        return h('div', { className: 'cc-page' },
          error ? h('div', { className: 'cc-warn' }, format(t.error, { message: error.message }), ' ', h('button', { className: 'cc-btn', type: 'button', onClick: reload }, t.retry))
            : h('div', { className: 'cc-note' }, t.loading))
      }

      const visibleSkills = data.skills.filter((skill) => matches(skill, query) && (filter === 'all' || (filter === 'on') === skill.effective))
      const totalTools = data.servers.reduce((sum, server) => sum + (server.effective ? server.tools : 0), 0)
      const enabledSkills = data.skills.filter((skill) => skill.effective).length

      return h('div', { className: 'cc-page' },
        h('div', { className: 'cc-summary' }, format(t.summary, { chars: data.indexChars.toLocaleString(), tools: totalTools, skills: enabledSkills })),
        h('div', { className: 'cc-note' }, t.globalNote),
        actionError ? h('div', { className: 'cc-warn' }, format(t.error, { message: actionError.message })) : null,

        h('section', { className: 'cc-section' },
          h('div', { className: 'cc-section-head' }, h('div', { className: 'cc-section-title' }, t.servers)),
          data.servers.length === 0 ? h('div', { className: 'cc-note' }, t.noServers)
            : h('div', { className: 'cc-list' }, data.servers.map((server) => h('div', { className: 'cc-row', key: server.name },
              h('div', { className: 'cc-row-main' },
                h('div', { className: 'cc-row-name' }, server.title, server.title !== server.name ? h('span', { className: 'cc-row-desc' }, `  mcp:${server.name}`) : null),
                h('div', { className: 'cc-row-desc' }, format(t.tools, { n: server.tools }))),
              h(StatusPill, { server, t }),
              h(Switch, {
                checked: server.global ?? server.configured, label: server.title, disabled: busy,
                onChange: (next) => run([{ kind: 'server', name: server.name, value: next === server.configured ? null : next }]),
              }))))),

        h('section', { className: 'cc-section' },
          h('div', { className: 'cc-section-head' }, h('div', { className: 'cc-section-title' }, `${t.skills} (${enabledSkills}/${data.skills.length})`)),
          data.takeOverSkills ? null : h('div', { className: 'cc-warn' }, t.noTakeover),
          h('div', { className: 'cc-toolbar' },
            h('input', { className: 'cc-input', type: 'search', placeholder: t.search, value: query, onChange: (event) => setQuery(event.target.value), 'aria-label': t.search }),
            [['all', t.filterAll], ['on', t.filterOn], ['off', t.filterOff]].map(([key, text]) => h('button', {
              key, type: 'button', className: 'cc-btn', 'aria-pressed': filter === key, onClick: () => setFilter(key),
            }, text))),
          data.skills.length === 0 ? h('div', { className: 'cc-note' }, t.noSkills)
            : h('div', { className: 'cc-list' }, groupByFamily(visibleSkills).map(([family, skills]) => h(React.Fragment, { key: family },
              h('div', { className: 'cc-family' },
                h('span', null, `${family} (${skills.length})`),
                h('span', { className: 'cc-toolbar' },
                  h('button', { type: 'button', className: 'cc-btn', disabled: busy, onClick: () => run(skills.map((skill) => ({ kind: 'skill', name: skill.name, value: null }))) }, t.allOn),
                  h('button', { type: 'button', className: 'cc-btn', disabled: busy, onClick: () => run(skills.map((skill) => ({ kind: 'skill', name: skill.name, value: false }))) }, t.allOff))),
              skills.map((skill) => h('div', { className: 'cc-row', key: skill.name },
                h('div', { className: 'cc-row-main' },
                  h('div', { className: 'cc-row-name' }, skill.name),
                  h('div', { className: 'cc-row-desc', title: skill.summary }, skill.summary)),
                h(Switch, {
                  checked: skill.global ?? true, label: skill.name, disabled: busy,
                  onChange: (next) => run([{ kind: 'skill', name: skill.name, value: next ? null : false }]),
                }))))))),
        loading ? h('div', { className: 'cc-note' }, t.loading) : null)
    }

    // ---------------------------------------------------------------- session control
    function SessionControl({ api, t, sessionId }) {
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const anchor = useRef(null)
      const { data, error, set } = useOverview(api, sessionId, true)
      const [actionError, setActionError] = useState(null)

      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        const onPointer = (event) => { if (anchor.current && !anchor.current.contains(event.target)) setOpen(false) }
        document.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onPointer)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onPointer)
        }
      }, [open])

      if (!sessionId) return null
      const offCount = data ? data.servers.filter((server) => !server.effective).length + data.skills.filter((skill) => !skill.effective).length : 0
      const change = async (kind, name, value) => {
        setActionError(null)
        try {
          await set({ scope: 'session', kind, name, value })
        } catch (err) {
          setActionError(err)
        }
      }
      const reset = async () => {
        if (!data) return
        for (const server of data.servers) if (server.session !== null) await change('server', server.name, null)
        for (const skill of data.skills) if (skill.session !== null) await change('skill', skill.name, null)
      }
      const skills = data ? data.skills.filter((skill) => matches(skill, query)) : []

      return h('span', { className: 'cc-anchor', ref: anchor },
        h('button', {
          type: 'button', className: 'cc-trigger', 'aria-expanded': open, 'aria-haspopup': 'dialog',
          title: offCount > 0 ? format(t.offCount, { n: offCount }) : t.sessionTitle,
          onClick: () => setOpen((value) => !value),
        },
          h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 },
            h('rect', { x: 2, y: 2, width: 5, height: 5, rx: 1 }), h('rect', { x: 9, y: 2, width: 5, height: 5, rx: 1 }),
            h('rect', { x: 2, y: 9, width: 5, height: 5, rx: 1 }), h('rect', { x: 9, y: 9, width: 5, height: 5, rx: 1 })),
          t.button,
          offCount > 0 ? h('span', { className: 'cc-trigger-badge' }, `−${offCount}`) : null),
        open ? h('div', { className: 'cc-popover', role: 'dialog', 'aria-label': t.sessionTitle },
          h('div', { className: 'cc-popover-head' },
            h('span', null, t.sessionTitle),
            h('span', { className: 'cc-toolbar' },
              h('button', { type: 'button', className: 'cc-btn', onClick: reset }, t.reset),
              h('button', { type: 'button', className: 'cc-btn', onClick: () => setOpen(false) }, t.close))),
          h('div', { className: 'cc-note' }, t.sessionNote),
          error ? h('div', { className: 'cc-warn' }, format(t.error, { message: error.message })) : null,
          actionError ? h('div', { className: 'cc-warn' }, format(t.error, { message: actionError.message })) : null,
          !data ? h('div', { className: 'cc-note' }, t.loading) : h('div', { className: 'cc-popover-body' },
            data.servers.length > 0 ? h('div', null,
              h('div', { className: 'cc-sub' }, t.servers),
              data.servers.map((server) => h('div', { className: 'cc-mini-row', key: server.name },
                h('div', { className: 'cc-row-main' },
                  h('div', { className: 'cc-row-name' }, server.title),
                  h('div', { className: 'cc-row-desc' }, format(t.tools, { n: server.tools }))),
                h(Segmented, { t, label: server.title, value: server.session, onChange: (value) => change('server', server.name, value) })))) : null,
            data.skills.length > 0 ? h('div', null,
              h('div', { className: 'cc-sub' }, `${t.skills} (${data.skills.filter((skill) => skill.effective).length}/${data.skills.length})`),
              h('input', { className: 'cc-input', type: 'search', placeholder: t.search, value: query, onChange: (event) => setQuery(event.target.value), 'aria-label': t.search, style: { width: '100%', marginBottom: 6 } }),
              skills.map((skill) => h('div', { className: 'cc-mini-row', key: skill.name },
                h('div', { className: 'cc-row-main' },
                  h('div', { className: 'cc-row-name', title: skill.summary }, skill.name, skill.effective ? null : h('span', { className: 'cc-row-desc' }, `  · ${t.stateOff}`))),
                h(Segmented, { t, label: skill.name, value: skill.session, onChange: (value) => change('skill', skill.name, value) })))) : null)) : null)
    }

    // ---------------------------------------------------------------- plugin
    return {
      inject: ['slots', 'remote'],
      async apply(ctx) {
        ctx.effect(ensureStyle, 'capability-catalog: styles')
        const unmountRemote = await ctx.remote.$mount(TYPERT_REMOTE)
        ctx.effect(() => unmountRemote, 'capability-catalog: Remote contribution')

        const localeService = ctx.get('locale')
        const subscribe = (listener) => (localeService && localeService.subscribe ? localeService.subscribe(listener) : () => undefined)
        const snapshot = () => {
          const value = localeService && localeService.getSnapshot ? localeService.getSnapshot() : undefined
          const id = (value && value.active) || navigator.language || 'en'
          return String(id).toLowerCase().startsWith('zh') ? 'zh' : 'en'
        }
        const useT = () => DICT[useSyncExternalStore(subscribe, snapshot, snapshot)]

        ctx.inject(['remote.capabilityCatalog'], (remoteCtx) => {
          const api = createApi(remoteCtx)
          function BundleConfig(props) {
            const t = useT()
            if (props.view !== 'page') return t.title
            return h(SettingsPage, { api, t })
          }
          function ComposerControl(props) {
            const t = useT()
            return h(SessionControl, { api, t, sessionId: props.sessionId })
          }
          for (const key of BUNDLE_KEYS) {
            remoteCtx.slots.inject('plugins.bundle.config', () => remoteCtx.slots.register({ name: 'plugins.bundle.config', key }, BundleConfig))
          }
          remoteCtx.slots.inject('conversation.input.left', () => remoteCtx.slots.register({
            name: 'conversation.input.left', id: 'capability-catalog', order: 40, label: () => DICT[snapshot()].button,
          }, ComposerControl))
        })
      },
    }
  },
})
