/**
 * dsh-plugin-trim — 按「当前用的是哪个模型」裁掉没用的插件和工具。
 *
 * 两层控制：
 *   1. 插件层：把整组插件关掉（走 DSH 自己的 pluginManager，和手点一样）
 *   2. 工具层：对当前 agent 调 tools.restrict({ allow })，只留白名单里的工具
 *      —— 不关插件、不写配置、立刻生效，切回云端时 dispose 掉限制即可
 *
 * 本地模型的判定照抄 dsh-local-trim 的做法（三条判据任一命中）：
 *   1) config.localProvider 写死的 provider 名
 *   2) provider 的 baseURL 指向回环 / 私有网段（127.0.0.1、10.x、192.168.x、172.16-31.x）
 *   3) provider 名字本身带 local / ollama / llama / vllm / lmstudio / sglang 等标记
 *
 * 给模型用的工具：tool_trim（list / set / apply / restore / status）
 * 给面板用的接口：POST /api/plugin-trim/{status,apply,restore,set,setTool,toolsApply,toolsRestore}
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BRIDGE_PREFIX = '/api/plugin-trim'
const MAX_BODY_BYTES = 64 * 1024
/** 面板里选的「哪个 provider 算本地」存这里，不改 cordis.patch.yml。 */
const STATE_PATH = join(homedir(), '.dsh', 'plugin-trim-state.json')
/** 这些工具是 agent 干活的最小集合，白名单默认值。 */
const DEFAULT_KEEP = [
  'pwsh',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'working_directory',
  'job_output',
  'job_list',
  'job_kill',
  'todo_write',
  'present',
  'read_image',
  'ask_user_question',
]

export const name = 'dsh-plugin-trim'
export const inject = ['tools', 'pluginManager']

function resolveConfig(config) {
  const out = {}
  for (const [key, value] of Object.entries(config ?? {})) {
    out[key] = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  }
  return out
}

const LOCAL_HOST_PATTERN =
  /^https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|host\.docker\.internal|10\.\d|192\.168\.\d|172\.(?:1[6-9]|2\d|3[01])\.)/i
const LOCAL_NAME_PATTERN = /(?:^|[-_])(?:local|ollama|llama|vllm|lmstudio|lm-studio|sglang|kobold|tabby|jan)(?:$|[-_])/i

function looksLocalUrl(value) {
  return typeof value === 'string' && value.trim().length > 0 && LOCAL_HOST_PATTERN.test(value.trim())
}
function looksLocalName(provider) {
  const id = String(provider ?? '')
  return id.length > 0 && (LOCAL_NAME_PATTERN.test(id) || /^ollama/i.test(id))
}

export function apply(ctx, config = {}) {
  const read = () => resolveConfig(config)
  const manager = () => ctx.get('pluginManager')

  /** 面板写的持久状态（只存「哪个 provider 算本地」这类小东西）。 */
  const loadState = () => {
    try {
      const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  const providerState = { localProvider: String(loadState().localProvider ?? '') }
  const saveState = () => {
    try {
      writeFileSync(STATE_PATH, JSON.stringify({ localProvider: providerState.localProvider }, null, 2), 'utf8')
      return true
    } catch {
      return false
    }
  }

  const report = (line) => {
    try {
      ctx.logger?.info?.('[plugin-trim] ' + line)
    } catch {
      /* 没有 logger 就算了 */
    }
  }

  const lastAction = { at: 0, text: '（还没动作）', tone: 'muted' }
  const remember = (text, tone = 'good') => {
    lastAction.at = Date.now()
    lastAction.text = text
    lastAction.tone = tone
    report(text)
  }

  const shortId = (entryId) => String(entryId ?? '').replace(/^include:/, '')

  // ── provider 判定 ───────────────────────────────────────────
  let lastProvider = ''
  const providerOf = (session) => {
    try {
      const projections = ctx.get('sessionProjections')
      if (projections === undefined || session === undefined) return ''
      const state = projections.stateOf(session, 'modelSelection')
      const picked = state?.pending ?? state?.lastUsed
      return typeof picked?.provider === 'string' ? picked.provider : ''
    } catch {
      return ''
    }
  }

  /**
   * llm.listConfigurableProviders() 只给 settingsNs / settingsPath，不给 baseURL。
   * 所以这里退一步：直接扫 profile 的 patch 文件，按 provider 名找 baseURL。
   * 带 5 秒缓存，文件改了下一轮就跟着变。
   */
  const CONFIG_FILES = [
    join(homedir(), '.dsh', 'cordis.patch.yml'),
    join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
  ]
  const configCache = { at: 0, map: new Map() }
  const baseUrlFromConfig = (provider) => {
    if (typeof provider !== 'string' || provider.length === 0) return undefined
    if (Date.now() - configCache.at > 5000) {
      configCache.at = Date.now()
      configCache.map = new Map()
      for (const file of CONFIG_FILES) {
        let text = ''
        try {
          text = readFileSync(file, 'utf8')
        } catch {
          continue
        }
        let current = null
        for (const line of text.split(/\r?\n/)) {
          const key = /^\s{2,}([A-Za-z0-9_.-]+):\s*$/.exec(line)
          if (key !== null) {
            current = key[1]
            continue
          }
          if (current === null) continue
          const base = /^\s+baseURL:\s*['"]?([^'"\s#]+)['"]?/.exec(line)
          if (base !== null) configCache.map.set(current, base[1])
        }
      }
    }
    return configCache.map.get(provider)
  }

  const baseUrlOf = (provider) => {
    try {
      const llm = ctx.get('llm')
      const rows = llm?.listConfigurableProviders?.() ?? []
      const hit = rows.find((row) => row?.provider === provider)
      const fromService = hit?.baseURL ?? hit?.defaultBaseURL ?? hit?.baseUrl ?? hit?.profile?.baseURL ?? hit?.config?.baseURL
      if (typeof fromService === 'string' && fromService.length > 0) return fromService
    } catch {
      /* 没有 llm 服务时退回配置文件 */
    }
    return baseUrlFromConfig(provider)
  }

  /** 三条判据，和 dsh-local-trim 一致；面板里选过的 provider 优先。 */
  const isLocalProvider = (provider) => {
    if (typeof provider !== 'string' || provider.length === 0) return false
    const cfg = read()
    const picked = providerState.localProvider
    if (typeof picked === 'string' && picked.length > 0) return provider === picked
    const asked = Array.isArray(cfg.routes) ? cfg.routes.map(String) : []
    if (asked.length > 0) return asked.includes(provider)
    if (typeof cfg.localProvider === 'string' && cfg.localProvider.length > 0) return provider === cfg.localProvider
    if (looksLocalUrl(baseUrlOf(provider))) return true
    return looksLocalName(provider)
  }

  /** 当前配置里所有 provider，面板用来选「哪个算本地」。 */
  const listProviders = () => {
    // 正在被会话用到的 provider 一定要留下（比如 deepseek-official 就不在 patch 里声明）。
    const used = new Set()
    if (typeof lastProvider === 'string' && lastProvider.length > 0) used.add(lastProvider)
    for (const agent of agents()) {
      const id = providerOf(agent?.session)
      if (typeof id === 'string' && id.length > 0) used.add(id)
    }
    try {
      const llm = ctx.get('llm')
      const rows = llm?.listConfigurableProviders?.() ?? []
      return rows
        .map((row) => ({
          id: String(row?.provider ?? ''),
          displayName: String(row?.displayName ?? row?.name ?? ''),
          baseURL: String(baseUrlOf(String(row?.provider ?? '')) ?? ''),
          error: typeof row?.error === 'string' ? row.error : '',
          declared: row?.declared === true,
        }))
        .filter((row) => row.id.length > 0)
        // 只留「这个 profile 里真配了」+「当前正在用」的；内置的几十个云端模板全滤掉。
        .filter((row) => row.declared || used.has(row.id))
        .map((row) => ({ ...row, local: looksLocalUrl(row.baseURL) || looksLocalName(row.id) }))
    } catch {
      return []
    }
  }

  // ── 插件层 ──────────────────────────────────────────────────
  const listEntries = async () => {
    const m = manager()
    if (m === undefined || typeof m.listPlugins !== 'function') {
      throw new Error('pluginManager 服务不可用（listPlugins 不存在）')
    }
    const raw = await m.listPlugins()
    const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : []
    return rows.map((row) => ({
      entryId: String(row.entryId ?? ''),
      moduleName: String(row.moduleName ?? ''),
      enabled: row.enabled !== false,
      readOnly: typeof row.readOnlyReason === 'string' && row.readOnlyReason.length > 0,
      readOnlyReason: String(row.readOnlyReason ?? ''),
    }))
  }

  const resolveTargets = (entries, wanted) => {
    const byId = new Map(entries.map((entry) => [entry.entryId, entry]))
    const seen = new Set()
    const rows = []
    for (const raw of wanted) {
      const entryId = String(raw ?? '').trim()
      if (entryId.length === 0 || seen.has(entryId)) continue
      seen.add(entryId)
      const entry = byId.get(entryId)
      rows.push({
        entryId,
        found: entry !== undefined,
        enabled: entry?.enabled ?? false,
        readOnly: entry?.readOnly ?? false,
        moduleName: entry?.moduleName ?? '',
      })
    }
    return rows
  }

  const setPlugins = async (targets, enabled) => {
    const m = manager()
    if (m === undefined || typeof m.setPluginEnabled !== 'function') {
      throw new Error('pluginManager 服务不可用（setPluginEnabled 不存在）')
    }
    const done = []
    const skipped = []
    for (const row of targets) {
      if (row.readOnly) {
        skipped.push({ entryId: row.entryId, why: row.readOnlyReason || 'read-only' })
        continue
      }
      if (row.found && row.enabled === enabled) {
        skipped.push({ entryId: row.entryId, why: 'already' })
        continue
      }
      try {
        const result = await m.setPluginEnabled(row.entryId, enabled)
        const application = String(result?.application ?? 'unknown')
        if (application === 'applied' || result?.changed === true) {
          done.push({ entryId: row.entryId, application })
        } else {
          const code = String(result?.error?.code ?? application)
          // 整条 bundle 停用后它脱离组合，DSH 自己也认不回来（unknown-plugin）。
          // 这不是本插件的 bug，是 pluginManager 的行为；只能改 patch 文件删掉 disabled 覆盖。
          skipped.push({
            entryId: row.entryId,
            why: code === 'unknown-plugin' ? 'needs-patch-edit' : code,
            hint:
              code === 'unknown-plugin'
                ? '这条已脱离组合，只能去 profile 的 cordis.patch.yml 删掉「- id: ' +
                  shortId(row.entryId) +
                  ' / disabled: true」那两行再重载'
                : undefined,
          })
        }
      } catch (error) {
        skipped.push({ entryId: row.entryId, why: String(error?.message ?? error) })
      }
    }
    return { done, skipped }
  }

  // ── 工具层（agent 作用域） ──────────────────────────────────
  /** agent → { off }：装上的限制，还原时 dispose。 */
  const toolRecords = new Map()

  const agents = () => {
    try {
      const service = ctx.get('agents')
      return typeof service?.list === 'function' ? service.list() : []
    } catch {
      return []
    }
  }

  const visibleTools = (agent) => {
    try {
      const list = agent?.ctx?.tools?.schemas?.(agent)
      if (!Array.isArray(list)) return []
      return list.map((schema) => String(schema?.name ?? '')).filter((n) => n.length > 0)
    } catch {
      return []
    }
  }

  const keepList = () => {
    const cfg = read()
    const raw = Array.isArray(cfg.keep) && cfg.keep.length > 0 ? cfg.keep : DEFAULT_KEEP
    return raw.map(String).filter((n) => n.length > 0)
  }

  /** 对单个 agent 装限制；返回结果说明，不抛。 */
  const restrictAgent = (agent) => {
    const tools = agent?.ctx?.tools
    if (tools === undefined || typeof tools.restrict !== 'function') {
      return { ok: false, why: 'agent.ctx.tools.restrict 不可用' }
    }
    const visible = visibleTools(agent)
    if (visible.length === 0) return { ok: false, why: '这个 agent 看不到任何工具' }
    const allow = visible.filter((n) => keepListEffective().includes(n))
    if (allow.length === 0) return { ok: false, why: '白名单里没有任何一个当前可见的工具' }
    const existing = toolRecords.get(agent)
    if (existing !== undefined) {
      try {
        existing.off()
      } catch {
        /* 旧限制释放失败不影响新限制 */
      }
      toolRecords.delete(agent)
    }
    try {
      const off = tools.restrict({ allow })
      toolRecords.set(agent, { off, allow, total: visible.length })
      return { ok: true, kept: allow.length, cut: visible.length - allow.length }
    } catch (error) {
      return { ok: false, why: String(error?.message ?? error) }
    }
  }

  const unrestrictAgent = (agent) => {
    const record = toolRecords.get(agent)
    if (record === undefined) return false
    toolRecords.delete(agent)
    try {
      record.off()
      return true
    } catch {
      return false
    }
  }

  const restrictAll = (onlyLocal = false) => {
    const rows = []
    for (const agent of agents()) {
      const id = String(agent?.id ?? '(anonymous)')
      const provider = providerOf(agent?.session)
      if (onlyLocal && !isLocalProvider(provider)) {
        rows.push({ agent: id, provider, ok: false, skipped: true, why: '不是本地 provider，跳过' })
        continue
      }
      rows.push({ agent: id, provider, ...restrictAgent(agent) })
    }
    return rows
  }

  const unrestrictAll = (onlyLocal = false) => {
    const rows = []
    for (const agent of agents()) {
      const id = String(agent?.id ?? '(anonymous)')
      const provider = providerOf(agent?.session)
      if (onlyLocal && !isLocalProvider(provider)) {
        rows.push({ agent: id, provider, off: false, skipped: true })
        continue
      }
      rows.push({ agent: id, provider, off: unrestrictAgent(agent) })
    }
    return rows
  }

  // ── 面板数据 ────────────────────────────────────────────────
  const statusView = async () => {
    const cfg = read()
    const entries = await listEntries()
    const targets = resolveTargets(entries, Array.isArray(cfg.localEntries) ? cfg.localEntries : [])
    const agentRows = agents().map((agent) => ({
      id: String(agent?.id ?? '(anonymous)'),
      provider: providerOf(agent?.session),
      tools: visibleTools(agent).length,
      restricted: toolRecords.has(agent),
      kept: toolRecords.get(agent)?.allow?.length ?? 0,
    }))
    return {
      ok: true,
      enabled: cfg.enabled !== false,
      auto: cfg.auto === true,
      lastProvider,
      providerIsLocal: isLocalProvider(lastProvider),
      localProvider: providerState.localProvider,
      providers: listProviders(),
      keep: keepListEffective(),
      agents: agentRows,
      localEntries: targets,
      lastAction,
      counts: {
        total: entries.length,
        enabled: entries.filter((entry) => entry.enabled).length,
        disabled: entries.filter((entry) => !entry.enabled).length,
      },
      candidates: entries
        .filter((entry) => !entry.readOnly)
        .map((entry) => ({
          entryId: entry.entryId,
          short: shortId(entry.entryId),
          moduleName: entry.moduleName,
          enabled: entry.enabled,
          inList: targets.some((row) => row.entryId === entry.entryId),
        })),
    }
  }

  // ── 实时跟随：每个 agent 按它自己的 provider 单独决定裁不裁 ──
  const followTools = () => read().followTools !== false

  /** 只重排一个 agent：本地 → 装限制；云端 → 撤限制。 */
  const planAgent = (agent) => {
    const id = String(agent?.id ?? '(anonymous)')
    const provider = providerOf(agent?.session)
    if (provider.length > 0) lastProvider = provider
    if (!followTools()) return { agent: id, provider, skipped: true, why: 'followTools 已关闭' }
    if (isLocalProvider(provider)) return { agent: id, provider, ...restrictAgent(agent) }
    return { agent: id, provider, off: unrestrictAgent(agent) }
  }

  const planSession = (session) => {
    const rows = []
    for (const agent of agents()) {
      if (session !== undefined && agent?.session !== session) continue
      rows.push(planAgent(agent))
    }
    return rows
  }

  // ── 自动模式：切到本地就裁插件，切回云端就开回来 ──────────────
  let autoBusy = false
  const runAuto = async (provider) => {
    const cfg = read()
    if (cfg.auto !== true || cfg.enabled === false || autoBusy) return
    autoBusy = true
    try {
      const local = isLocalProvider(provider)
      const entries = await listEntries()
      const targets = resolveTargets(entries, Array.isArray(cfg.localEntries) ? cfg.localEntries : [])
      const plugins = targets.length > 0 ? await setPlugins(targets, !local) : { done: [], skipped: [] }
      remember(
        `${local ? '本地' : '云端'} ${provider}：插件 ${plugins.done.length} 个`,
        'good',
      )
    } catch (error) {
      remember('自动切换失败：' + String(error?.message ?? error), 'bad')
    } finally {
      autoBusy = false
    }
  }

  try {
    ctx.on('agent/created', ({ agent }) => {
      planAgent(agent)
      return undefined
    })
  } catch (error) {
    report('agent/created 挂载失败：' + String(error?.message ?? error))
  }

  try {
    ctx.on('session/event', (session, event) => {
      const provider = providerOf(session)
      if (provider.length > 0) lastProvider = provider
      if (event?.type !== 'model/selection') return undefined
      // 模型选择投影可能比这条事件晚一拍，所以立刻排一次、再补一次。
      planSession(session)
      const timer = setTimeout(() => {
        try {
          planSession(session)
        } catch {
          /* agent 可能已经销毁 */
        }
      }, 120)
      if (typeof timer?.unref === 'function') timer.unref()
      void runAuto(provider)
      return undefined
    })
  } catch (error) {
    report('session/event 挂载失败：' + String(error?.message ?? error))
  }

  // ── 给模型用的工具 ──────────────────────────────────────────
  const toolDefinition = {
    name: 'tool_trim',
    description:
      '按模型裁剪工具与插件。action=list 列出当前 agent 可见的工具名；status 看当前 provider 是本地还是云端、限制装没装上；set 传 tool 与 enabled 单独开或关一个工具（改成 deny 白名单之外的都被裁掉）；apply 立刻只保留白名单里的工具；restore 撤掉限制恢复全部工具。白名单在插件配置的 keep 里。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'status', 'set', 'apply', 'restore'],
          description: 'list | status | set | apply | restore',
        },
        tool: { type: 'string', description: 'action=set 时的工具名' },
        enabled: { type: 'boolean', description: 'action=set 时 true=保留、false=裁掉' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const agent = exec?.agent
      const action = String(args?.action ?? 'status')
      if (action === 'list') {
        const visible = visibleTools(agent)
        return JSON.stringify({
          total: visible.length,
          keep: keepListEffective().filter((n) => visible.includes(n)),
          tools: visible,
        })
      }
      if (action === 'status') {
        const visible = visibleTools(agent)
        return JSON.stringify({
          provider: lastProvider,
          local: isLocalProvider(lastProvider),
          restricted: toolRecords.has(agent),
          visible: visible.length,
          keep: toolRecords.get(agent)?.allow ?? keepListEffective().filter((n) => visible.includes(n)),
        })
      }
      if (action === 'set') {
        const tool = String(args?.tool ?? '').trim()
        if (tool.length === 0) return JSON.stringify({ ok: false, error: 'tool 必填' })
        const visible = visibleTools(agent)
        if (!visible.includes(tool)) return JSON.stringify({ ok: false, error: '当前不可见：' + tool, tools: visible })
        const current = new Set(keepListEffective())
        if (args?.enabled === false) current.delete(tool)
        else current.add(tool)
        // 配置是 volatile 活引用；没有写入口时只影响本进程这次限制。
        cfgOverride = [...current]
        // 只有已经装了限制才重装，否则只改白名单，不动当前工具面。
        if (!toolRecords.has(agent)) {
          return JSON.stringify({ ok: true, keep: cfgOverride, note: '已记下白名单；限制还没启用，apply 之后生效' })
        }
        const result = restrictAgent(agent)
        return JSON.stringify({ ok: result.ok, ...result, keep: cfgOverride })
      }
      if (action === 'apply') {
        const rows = restrictAll()
        return JSON.stringify({ ok: true, rows })
      }
      if (action === 'restore') {
        const rows = unrestrictAll()
        return JSON.stringify({ ok: true, rows })
      }
      return JSON.stringify({ ok: false, error: 'unknown action: ' + action })
    },
  }

  /** tool_trim set 改出来的临时白名单（进程内）。 */
  let cfgOverride = null
  const keepListEffective = () => (cfgOverride !== null ? cfgOverride : keepList())

  try {
    ctx.effect(() => ctx.tools.register(toolDefinition), 'dsh-plugin-trim: tool_trim')
    report('工具已注册：tool_trim')
  } catch (error) {
    report('tool_trim 注册失败 —— ' + String(error?.message ?? error))
  }

  // ── HTTP bridge ─────────────────────────────────────────────
  const readJsonBody = (req) =>
    new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          resolve(undefined)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        if (text.length === 0) return resolve({})
        try {
          resolve(JSON.parse(text))
        } catch {
          resolve(undefined)
        }
      })
      req.on('error', () => resolve(undefined))
    })

  const writeJson = (res, code, payload) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  const guard = (req, res) => {
    if (String(req.method ?? '').toUpperCase() !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'method not allowed' })
      return false
    }
    const host = String(req.headers?.host ?? '')
    const origin = String(req.headers?.origin ?? '')
    if (origin.length > 0 && host.length > 0) {
      try {
        if (new URL(origin).host !== host) {
          writeJson(res, 403, { ok: false, error: 'cross-origin denied' })
          return false
        }
      } catch {
        writeJson(res, 403, { ok: false, error: 'bad origin' })
        return false
      }
    }
    return true
  }

  const route = (name, handler) => ({
    kind: 'exact',
    path: BRIDGE_PREFIX + '/' + name,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      try {
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { ok: false, error: 'body must be JSON under ' + MAX_BODY_BYTES + ' bytes' })
          return
        }
        writeJson(res, 200, await handler(body))
      } catch (error) {
        writeJson(res, 200, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  /**
   * 自带面板页。侧栏的插件列表来自插件市场目录，本地 link: 包不会出现在那里，
   * 所以面板不能只挂 plugins.detail.section —— 这里再加一个浏览器直连的页面。
   */
  const panelPath = join(dirname(fileURLToPath(import.meta.url)), 'panel.html')
  const panelHtml = () => readFileSync(panelPath, 'utf8')
  const panelRoute = {
    kind: 'exact',
    path: BRIDGE_PREFIX + '/panel',
    handler: async (req, res) => {
      const method = String(req.method ?? 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      try {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(method === 'HEAD' ? undefined : panelHtml())
      } catch (error) {
        writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }

  try {
    ctx.inject(['webServer'], (sctx) => {
      if (typeof sctx.webServer?.register !== 'function') return
      sctx.effect(
        () =>
          [
            panelRoute,
            route('status', async () => statusView()),
            // 面板上选「哪个 provider 算本地」，存到 ~/.dsh/plugin-trim-state.json
            route('setProvider', async (body) => {
              const id = String(body?.provider ?? '').trim()
              providerState.localProvider = id
              const persisted = saveState()
              remember(id ? `本地 provider 设为 ${id}` : '本地 provider 恢复自动识别', 'good')
              return { ok: true, localProvider: providerState.localProvider, persisted, lastAction }
            }),
            route('apply', async (body) => {
              const entries = await listEntries()
              const targets = resolveTargets(entries, Array.isArray(read().localEntries) ? read().localEntries : [])
              const onlyLocal = body?.onlyLocal !== false
              const plugins = await setPlugins(targets, false)
              const tools = restrictAll(onlyLocal)
              remember(`本地模式：插件 ${plugins.done.length} 个、工具 ${tools.filter((r) => r.ok).length} 个 agent`, 'good')
              return { ok: true, plugins, tools, lastAction }
            }),
            route('restore', async (body) => {
              const entries = await listEntries()
              const targets = resolveTargets(entries, Array.isArray(read().localEntries) ? read().localEntries : [])
              const onlyLocal = body?.onlyLocal !== false
              const plugins = await setPlugins(targets, true)
              const tools = unrestrictAll(onlyLocal)
              remember(`还原：插件 ${plugins.done.length} 个、工具 ${tools.filter((r) => r.off).length} 个 agent`, 'good')
              return { ok: true, plugins, tools, lastAction }
            }),
            route('set', async (body) => {
              const entryId = String(body?.entryId ?? '').trim()
              if (entryId.length === 0) return { ok: false, error: 'entryId 必填' }
              const enabled = body?.enabled === true
              const m = manager()
              const result = await m.setPluginEnabled(entryId, enabled)
              const application = String(result?.application ?? 'unknown')
              if (application !== 'applied' && result?.changed !== true) {
                return { ok: false, error: '没生效：' + String(result?.error?.code ?? application), result }
              }
              remember(`${enabled ? '启用' : '停用'} ${shortId(entryId)}`, 'good')
              return { ok: true, result, lastAction }
            }),
            // 工具层：面板用。列出现在可见的工具 + 限制状态
            route('tools', async () => {
              const rows = []
              for (const agent of agents()) {
                rows.push({
                  agent: String(agent?.id ?? '(anonymous)'),
                  visible: visibleTools(agent),
                  restricted: toolRecords.has(agent),
                  keep: toolRecords.get(agent)?.allow ?? null,
                })
              }
              return { ok: true, agents: rows, keep: keepListEffective(), lastAction }
            }),
            route('toolsApply', async (body) => ({ ok: true, rows: restrictAll(body?.onlyLocal === true), lastAction })),
            route('toolsRestore', async (body) => ({ ok: true, rows: unrestrictAll(body?.onlyLocal === true), lastAction })),
            route('setTool', async (body) => {
              const tool = String(body?.tool ?? '').trim()
              if (tool.length === 0) return { ok: false, error: 'tool 必填' }
              const enabled = body?.enabled === true
              const next = new Set(keepListEffective())
              if (enabled) next.add(tool)
              else next.delete(tool)
              cfgOverride = [...next]
              // 只有已经装了限制才重装；否则改动白名单不该顺手把工具裁掉。
              const wasRestricted = agents().some((agent) => toolRecords.has(agent))
              const rows = wasRestricted ? restrictAll() : []
              remember(`${enabled ? '保留' : '裁掉'}工具 ${tool}${wasRestricted ? '（已重装限制）' : '（限制未启用）'}`, 'good')
              return { ok: true, keep: cfgOverride, rows, lastAction }
            }),
          ].map((r) => sctx.webServer.register(r)),
        'dsh-plugin-trim: control panel bridge',
      )
      report('bridge 已挂载：' + BRIDGE_PREFIX + '/{status,apply,restore,set,tools,toolsApply,toolsRestore,setTool}')
    })
  } catch (error) {
    report('bridge 未挂载 —— ' + String(error?.message ?? error))
  }
}
