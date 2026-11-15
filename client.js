/**
 * dsh-plugin-trim 控制面板（client 半边）。
 *
 * 挂在插件详情页的 `plugins.detail.section` 槽位上：DSH 的「插件」列表里点开
 * dsh-plugin-trim，详情页底部就是这块面板。
 *
 * 两块内容：
 *   插件 —— 清单里的插件整组开关（走 pluginManager）
 *   工具 —— 当前 agent 可见的工具，逐个「保留 / 裁掉」（走 tools.restrict）
 *
 * 浏览器拿不到 cordis 服务，全部读写走宿主侧 HTTP bridge。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-trim',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const BRIDGE = '/api/plugin-trim'

    async function call(name, body) {
      const response = await fetch(BRIDGE + '/' + name, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload?.error ?? 'HTTP ' + response.status)
      if (payload?.ok === false) throw new Error(payload?.error ?? '操作被拒绝')
      return payload
    }

    const MUTED = 'var(--dsw-alias-label-secondary, #666)'
    const BORDER = '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12))'
    const TONE = { good: '#1e8449', warn: '#b9770e', bad: '#c0392b', muted: '#8a8a8a' }
    const S = {
      card: { border: BORDER, borderRadius: 10, padding: '14px 16px', marginTop: 12, fontSize: 13, lineHeight: 1.6 },
      title: { fontSize: 14, fontWeight: 600, margin: '16px 0 6px' },
      row: { display: 'flex', alignItems: 'center', gap: 8, margin: '5px 0', flexWrap: 'wrap' },
      label: { flex: '0 0 120px', color: MUTED },
      pill: { fontSize: 11, padding: '0 6px', borderRadius: 999, border: BORDER, color: MUTED },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12 },
      btn: { fontSize: 12, padding: '3px 10px', borderRadius: 6, border: BORDER, background: 'transparent', color: 'inherit', cursor: 'pointer' },
      btnOn: { fontSize: 12, padding: '3px 10px', borderRadius: 6, border: BORDER, background: 'rgba(30,132,73,.12)', color: 'inherit', cursor: 'pointer' },
      btnOff: { fontSize: 12, padding: '3px 10px', borderRadius: 6, border: BORDER, background: 'rgba(192,57,43,.10)', color: 'inherit', cursor: 'pointer' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '4px 10px', marginTop: 6 },
      tool: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 },
    }

    function Panel() {
      const [status, setStatus] = React.useState(null)
      const [tools, setTools] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState(null)
      const [showAll, setShowAll] = React.useState(false)

      const refresh = React.useCallback(async () => {
        try {
          const [nextStatus, nextTools] = await Promise.all([call('status'), call('tools')])
          setStatus(nextStatus)
          setTools(nextTools)
        } catch (error) {
          setMessage({ tone: 'bad', text: String(error?.message ?? error) })
        }
      }, [])

      React.useEffect(() => {
        void refresh()
      }, [refresh])

      const run = async (label, fn) => {
        setBusy(label)
        setMessage(null)
        try {
          const result = await fn()
          await refresh()
          setMessage({ tone: 'good', text: label + ' 完成 · ' + describe(result) })
        } catch (error) {
          setMessage({ tone: 'bad', text: label + ' 失败：' + String(error?.message ?? error) })
        } finally {
          setBusy('')
        }
      }

      const describe = (result) => {
        const parts = []
        if (Array.isArray(result?.plugins?.done)) parts.push('插件生效 ' + result.plugins.done.length + ' 个')
        if (Array.isArray(result?.plugins?.skipped) && result.plugins.skipped.length) {
          const hint = result.plugins.skipped.find((row) => row.hint)?.hint
          parts.push('插件跳过 ' + result.plugins.skipped.length + (hint ? '（' + hint + '）' : ''))
        }
        if (Array.isArray(result?.tools)) {
          const ok = result.tools.filter((row) => row.ok === true || row.off === true).length
          parts.push('工具 ' + ok + ' 个 agent')
          const failed = result.tools.filter((row) => row.ok === false && row.why)
          if (failed.length) parts.push('失败 ' + failed.length + '（' + failed[0].why + '）')
        }
        if (Array.isArray(result?.rows)) {
          const ok = result.rows.filter((row) => row.ok === true || row.off === true).length
          parts.push('工具 ' + ok + ' 个 agent')
          const failed = result.rows.filter((row) => row.ok === false && row.why)
          if (failed.length) parts.push('失败 ' + failed.length + '（' + failed[0].why + '）')
        }
        return parts.join(' · ') || '已刷新'
      }

      if (status === null) return h('div', { style: S.card }, message === null ? '读取中…' : message.text)

      const list = Array.isArray(status.localEntries) ? status.localEntries : []
      const agentRow = Array.isArray(tools?.agents) ? tools.agents[0] : undefined
      const visible = Array.isArray(agentRow?.visible) ? agentRow.visible : []
      const keep = new Set(Array.isArray(tools?.keep) ? tools.keep : Array.isArray(status.keep) ? status.keep : [])
      const restricted = agentRow?.restricted === true

      return h(
        'div',
        { style: S.card },
        h('div', { style: { fontSize: 14, fontWeight: 600 } }, '本地模型裁剪 · 插件 + 工具'),

        h(
          'div',
          { style: S.row },
          h('span', { style: S.label }, '当前 provider'),
          h('span', { style: S.mono }, status.lastProvider || '（还没看到会话）'),
          h('span', { style: { ...S.pill, color: status.providerIsLocal ? TONE.warn : MUTED } }, status.providerIsLocal ? '本地' : '云端'),
          h('span', { style: { flex: 1 } }),
          h('span', { style: S.pill }, '自动跟随 ' + (status.auto ? '开' : '关')),
        ),

        h(
          'div',
          { style: S.row },
          h(
            'button',
            { style: S.btnOff, disabled: busy !== '', onClick: () => void run('本地模式', () => call('apply')) },
            busy === '本地模式' ? '处理中…' : '本地模式（裁插件 + 裁工具）',
          ),
          h(
            'button',
            { style: S.btnOn, disabled: busy !== '', onClick: () => void run('还原', () => call('restore')) },
            busy === '还原' ? '处理中…' : '还原（全开）',
          ),
          h('button', { style: S.btn, disabled: busy !== '', onClick: () => void refresh() }, '刷新'),
        ),

        h('div', { style: S.title }, '工具层'),
        h(
          'div',
          { style: S.row },
          h('span', { style: S.label }, '限制状态'),
          h('span', { style: { ...S.mono, color: restricted ? TONE.good : MUTED } }, restricted ? '已装上（只保留白名单）' : '未装（全部工具可见）'),
          h('span', { style: S.pill }, visible.length + ' 个可见'),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            { style: S.btnOff, disabled: busy !== '', onClick: () => void run('裁工具', () => call('toolsApply')) },
            '只留白名单',
          ),
          h(
            'button',
            { style: S.btnOn, disabled: busy !== '', onClick: () => void run('放开工具', () => call('toolsRestore')) },
            '放开全部',
          ),
        ),
        visible.length === 0
          ? h('div', { style: { color: MUTED, fontSize: 12 } }, '这个 agent 当前看不到工具（或还没有会话）。')
          : h(
              'div',
              { style: S.grid },
              visible.map((tool) =>
                h(
                  'label',
                  { key: tool, style: S.tool, title: keep.has(tool) ? '在白名单里' : '不在白名单' },
                  h('input', {
                    type: 'checkbox',
                    checked: keep.has(tool),
                    disabled: busy !== '',
                    onChange: (event) =>
                      void run('工具 ' + tool, () =>
                        call('setTool', { tool, enabled: event.target.checked }),
                      ),
                  }),
                  h('span', { style: S.mono }, tool),
                ),
              ),
            ),

        h('div', { style: S.title }, '插件层'),
        list.length === 0
          ? h('div', { style: { color: MUTED, fontSize: 12 } }, '清单是空的（cordis.patch.yml 的 localEntries）。')
          : h(
              'div',
              null,
              list.map((row) =>
                h(
                  'div',
                  { key: row.entryId, style: S.row },
                  h('span', { style: { ...S.mono, color: row.enabled ? TONE.warn : TONE.good } }, row.enabled ? '开' : '关'),
                  h('span', { style: S.mono }, row.entryId),
                  h('span', { style: { flex: 1 } }),
                  h(
                    'button',
                    {
                      style: S.btn,
                      disabled: busy !== '',
                      onClick: () => void run('切换 ' + row.entryId, () => call('set', { entryId: row.entryId, enabled: !row.enabled })),
                    },
                    row.enabled ? '停用' : '启用',
                  ),
                ),
              ),
            ),

        h('div', { style: S.row }, h('button', { style: S.btn, onClick: () => setShowAll(!showAll) }, showAll ? '收起全部插件' : '展开全部插件')),
        showAll
          ? h(
              'div',
              null,
              (status.candidates ?? []).map((row) =>
                h(
                  'div',
                  { key: row.entryId, style: S.row },
                  h('span', { style: { ...S.mono, color: row.enabled ? TONE.good : MUTED } }, row.enabled ? '开' : '关'),
                  h('span', { style: S.mono }, row.short || row.entryId),
                  row.inList ? h('span', { style: S.pill }, '在清单') : null,
                  h('span', { style: { flex: 1 } }),
                  h(
                    'button',
                    {
                      style: S.btn,
                      disabled: busy !== '',
                      onClick: () => void run('切换 ' + row.short, () => call('set', { entryId: row.entryId, enabled: !row.enabled })),
                    },
                    row.enabled ? '停用' : '启用',
                  ),
                ),
              ),
            )
          : null,

        h('div', { style: S.title }, '最近动作'),
        h(
          'div',
          { style: { fontSize: 12, color: TONE[status.lastAction?.tone] ?? MUTED } },
          status.lastAction?.text ?? '—',
          status.lastAction?.at ? ' · ' + new Date(status.lastAction.at).toLocaleTimeString() : '',
        ),

        message === null
          ? null
          : h(
              'pre',
              {
                style: {
                  marginTop: 10,
                  padding: 8,
                  borderRadius: 6,
                  border: BORDER,
                  whiteSpace: 'pre-wrap',
                  color: message.tone === 'bad' ? TONE.bad : TONE.good,
                  fontSize: 12,
                },
              },
              message.text,
            ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.detail.section', () =>
          ctx.slots.register(
            { name: 'plugins.detail.section', id: 'dsh-plugin-trim-panel', order: 210, label: '本地模型裁剪' },
            Panel,
          ),
        )
      },
    }
  },
})
