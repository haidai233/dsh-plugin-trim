/**
 * dsh-plugin-trim — 按**会话**裁剪工具面，按 provider 自动套档。
 *
 * 设计（v0.2）：
 *   · 主键是会话。每个 agent 自己绑一个「档位」（profile），互相不影响。
 *   · provider 只负责**默认套档**：本地 provider 上的新会话套 local 档，
 *     云端套 full 档；切了 provider 就重算它自己的档，但不碰别的会话。
 *   · 档位就是一份工具白名单。`full` 是特例：不装限制、全部可见。
 *   · 插件层只能 profile 级（物理启停写 cordis.patch.yml，影响所有会话），
 *     所以单独放，不伪装成"按会话关插件"。
 *
 * 硬约束（源码实测）：
 *   · tools.restrict() 只接受 agent 作用域 —— 按会话裁是唯一正确的作用域
 *   · pluginManager.setPluginEnabled() 是 profile 作用域 —— 改全体
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BRIDGE_PREFIX = '/api/plugin-trim'
const MAX_BODY_BYTES = 64 * 1024
const STATE_PATH = join(homedir(), '.dsh', 'plugin-trim-state.json')

/** local 档的默认白名单。 */
const DEFAULT_LOCAL = [
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

  // ── 持久状态 ────────────────────────────────────────────────
  const loadState = () => {
    try {
      const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  const saved = loadState()
  const state = {
    localProvider: String(saved.localProvider ?? ''),
    /** sessionId → profileId */
    agentProfiles: saved.agentProfiles !== null && typeof saved.agentProfiles === 'object' ? { ...saved.agentProfiles } : {},
    /** profileId → string[]，面板改过的档位定义 */
    profiles: saved.profiles !== null && typeof saved.profiles === 'object' ? { ...saved.profiles } : {},
  }
  const saveState = () => {
    try {
      writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8')
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

  // ── provider ────────────────────────────────────────────────
  let lastProvider = ''
  const providerOf = (session) => {
    try {
      const projections = ctx.get('sessionProjections')
      if (projections === undefined || session === undefined) return ''
      const st = projections.stateOf(session, 'modelSelection')
      const picked = st?.pending ?? st?.lastUsed
      return typeof picked?.provider === 'string' ? picked.provider : ''
    } catch {
      return ''
    }
  }

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
      const fromService =
        hit?.baseURL ?? hit?.defaultBaseURL ?? hit?.baseUrl ?? hit?.profile?.baseURL ?? hit?.config?.baseURL
      if (typeof fromService === 'string' && fromService.length > 0) return fromService
    } catch {
      /* 没有 llm 服务时退回配置文件 */
    }
    return baseUrlFromConfig(provider)
  }

  const isLocalProvider = (provider) => {
    if (typeof provider !== 'string' || provider.length === 0) return false
    const cfg = read()
    if (state.localProvider.length > 0) return provider === state.localProvider
    const asked = Array.isArray(cfg.routes) ? cfg.routes.map(String) : []
    if (asked.length > 0) return asked.includes(provider)
    if (typeof cfg.localProvider === 'string' && cfg.localProvider.length > 0) return provider === cfg.localProvider
    if (looksLocalUrl(baseUrlOf(provider))) return true
    return looksLocalName(provider)
  }

  const listProviders = () => {
    const used = new Set()
    if (lastProvider.length > 0) used.add(lastProvider)
    for (const agent of agents()) {
      const id = providerOf(agent?.session)
      if (id.length > 0) used.add(id)
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
        .filter((row) => row.declared || used.has(row.id))
        .map((row) => ({ ...row, local: looksLocalUrl(row.baseURL) || looksLocalName(row.id), inUse: used.has(row.id) }))
    } catch {
      return []
    }
  }

  // ── 档位 ────────────────────────────────────────────────────
  const builtinProfiles = () => {
    const cfg = read()
    const declared = cfg.profiles !== null && typeof cfg.profiles === 'object' ? cfg.profiles : {}
    const localList = Array.isArray(declared.local) ? declared.local.map(String) : DEFAULT_LOCAL
    return {
      full: [],
      local: localList,
      custom: Array.isArray(declared.custom) ? declared.custom.map(String) : [],
    }
  }

  /** 档位定义：面板改过的优先。 */
  const profileDefs = () => {
    const base = builtinProfiles()
    for (const [id, list] of Object.entries(state.profiles)) {
      if (Array.isArray(list)) base[id] = list.map(String)
    }
    return base
  }

  const defaultProfileFor = () => {
    const cfg = read()
    const d = cfg.defaultProfileFor !== null && typeof cfg.defaultProfileFor === 'object' ? cfg.defaultProfileFor : {}
    return { local: String(d.local ?? 'local'), cloud: String(d.cloud ?? 'full') }
  }

  const agentKey = (agent) => String(agent?.id ?? '(anonymous)')

  /** 这个 agent 现在用哪个档：显式指定 > provider 默认。 */
  const profileIdOf = (agent) => {
    const explicit = state.agentProfiles[agentKey(agent)]
    if (typeof explicit === 'string' && explicit.length > 0) return explicit
    const provider = providerOf(agent?.session)
    const d = defaultProfileFor()
    return isLocalProvider(provider) ? d.local : d.cloud
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

  // ── 工具层（按会话） ────────────────────────────────────────
  /** agent → { off, allow, profile } */
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

  const releaseAgent = (agent) => {
    const record = toolRecords.get(agent)
    if (record === undefined) return false
    toolRecords.delete(agent)
    try {
      // dispose 是 ctx.effect 的句柄：调用它会撤掉 effect 并顺带调 off()
      record.dispose()
      return true
    } catch {
      return false
    }
  }

  /** 按 agent 自己的档位重装限制；full 档 = 撤掉限制。 */
  const applyProfile = (agent) => {
    const id = agentKey(agent)
    const provider = providerOf(agent?.session)
    const profileId = profileIdOf(agent)
    const defs = profileDefs()
    const list = defs[profileId]

    if (!Array.isArray(list)) {
      return { agent: id, provider, profile: profileId, ok: false, why: '没有这个档位：' + profileId }
    }
    if (profileId === 'full' || list.length === 0) {
      const off = releaseAgent(agent)
      return { agent: id, provider, profile: profileId, ok: true, unrestricted: true, released: off }
    }

    const tools = agent?.ctx?.tools
    if (tools === undefined || typeof tools.restrict !== 'function') {
      return { agent: id, provider, profile: profileId, ok: false, why: 'agent.ctx.tools.restrict 不可用' }
    }
    // 先撤掉自己装的旧限制，再读可见工具 —— 否则读到的是上一次裁过的集合，
    // 换到更宽的档位只会越裁越少（restrict 是求交集，不可逆）。
    releaseAgent(agent)
    const visible = visibleTools(agent)
    if (visible.length === 0) {
      return { agent: id, provider, profile: profileId, ok: false, why: '这个 agent 看不到任何工具' }
    }
    const allow = visible.filter((n) => list.includes(n))
    if (allow.length === 0) {
      return { agent: id, provider, profile: profileId, ok: false, why: '档位里没有任何当前可见的工具' }
    }
    try {
      const off = tools.restrict({ allow })
      // 注册到本插件的 ctx.effect 上：插件被停用/热重载时限制会跟着撤掉。
      // v0.1 没做这一步，导致每次重载都留下一条撤不掉的限制（表现为"已放开但工具还是少的"）。
      const dispose = ctx.effect(() => off, 'dsh-plugin-trim: restrict ' + id)
      toolRecords.set(agent, { dispose, allow, profile: profileId })
      return { agent: id, provider, profile: profileId, ok: true, kept: allow.length, cut: visible.length - allow.length }
    } catch (error) {
      return { agent: id, provider, profile: profileId, ok: false, why: String(error?.message ?? error) }
    }
  }

  const planSession = (session) => {
    const rows = []
    for (const agent of agents()) {
      if (session !== undefined && agent?.session !== session) continue
      rows.push(applyProfile(agent))
    }
    return rows
  }

  const planAll = () => planSession(undefined)

  // ── 事件：provider 变了就重算，但只算这条会话 ───────────────
  const followTools = () => read().followTools !== false

  try {
    ctx.on('agent/created', ({ agent }) => {
      if (followTools()) applyProfile(agent)
      return undefined
    })
  } catch (error) {
    report('agent/created 挂载失败：' + String(error?.message ?? error))
  }

  let autoBusy = false
  const runAutoPlugins = async (provider) => {
    const cfg = read()
    if (cfg.auto !== true || cfg.enabled === false || autoBusy) return
    autoBusy = true
    try {
      const local = isLocalProvider(provider)
      const entries = await listEntries()
      const targets = resolveTargets(entries, Array.isArray(cfg.localEntries) ? cfg.localEntries : [])
      const plugins = targets.length > 0 ? await setPlugins(targets, !local) : { done: [], skipped: [] }
      if (plugins.done.length > 0) remember(`${local ? '本地' : '云端'} ${provider}：插件 ${plugins.done.length} 个`, 'good')
    } catch (error) {
      remember('自动切插件失败：' + String(error?.message ?? error), 'bad')
    } finally {
      autoBusy = false
    }
  }

  try {
    ctx.on('session/event', (session, event) => {
      const provider = providerOf(session)
      if (provider.length > 0) lastProvider = provider
      if (event?.type !== 'model/selection') return undefined
      if (followTools()) {
        planSession(session)
        // 选择投影可能比事件晚一拍，补一次（仍然只碰这一条会话）。
        const timer = setTimeout(() => {
          try {
            planSession(session)
          } catch {
            /* agent 可能已销毁 */
          }
        }, 120)
        if (typeof timer?.unref === 'function') timer.unref()
      }
      void runAutoPlugins(provider)
      return undefined
    })
  } catch (error) {
    report('session/event 挂载失败：' + String(error?.message ?? error))
  }

  // ── 状态 ────────────────────────────────────────────────────
  const statusView = async () => {
    const cfg = read()
    const entries = await listEntries()
    const targets = resolveTargets(entries, Array.isArray(cfg.localEntries) ? cfg.localEntries : [])
    const defs = profileDefs()
    return {
      ok: true,
      enabled: cfg.enabled !== false,
      auto: cfg.auto === true,
      followTools: followTools(),
      lastProvider,
      localProvider: state.localProvider,
      /** 固定端口面板地址；面板起来之前是空串。 */
      panelUrl: panelPort > 0 ? 'http://127.0.0.1:' + panelPort + '/' : '',
      providers: listProviders(),
      defaultProfileFor: defaultProfileFor(),
      profiles: Object.entries(defs).map(([id, list]) => ({
        id,
        count: list.length,
        tools: list,
      })),
      agents: agents().map((agent) => {
        const id = agentKey(agent)
        const provider = providerOf(agent?.session)
        const record = toolRecords.get(agent)
        const visible = visibleTools(agent)
        return {
          id,
          provider,
          local: isLocalProvider(provider),
          profile: profileIdOf(agent),
          explicit: typeof state.agentProfiles[id] === 'string',
          tools: visible.length,
          restricted: record !== undefined,
          kept: record?.allow?.length ?? 0,
        }
      }),
      localEntries: targets,
      lastAction,
      /** 所有会话可见工具的并集，面板拿它渲染档位编辑器。 */
      visibleNames: [...new Set(agents().flatMap((agent) => visibleTools(agent)))].sort(),
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

  // ── 模型侧工具 ──────────────────────────────────────────────
  const toolDefinition = {
    name: 'tool_trim',
    description:
      '按会话裁剪工具面。action=list 列出当前会话可见的工具名；status 看本会话的档位和 provider；set 传 tool + enabled 单独开关一个工具（写进本会话当前档位）；profile 传 profile（full/local/custom）给本会话换档；apply 按当前档位重装；restore 撤掉限制恢复全部。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'status', 'set', 'profile', 'apply', 'restore'],
          description: 'list | status | set | profile | apply | restore',
        },
        tool: { type: 'string', description: 'action=set 时的工具名' },
        enabled: { type: 'boolean', description: 'action=set 时 true=保留、false=裁掉' },
        profile: { type: 'string', description: 'action=profile 时的档位名：full | local | custom' },
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
      const id = agentKey(agent)

      if (action === 'list') {
        const visible = visibleTools(agent)
        const defs = profileDefs()
        const profile = profileIdOf(agent)
        return JSON.stringify({
          profile,
          total: visible.length,
          keep: (defs[profile] ?? []).filter((n) => visible.includes(n)),
          tools: visible,
        })
      }
      if (action === 'status') {
        const visible = visibleTools(agent)
        const record = toolRecords.get(agent)
        return JSON.stringify({
          provider: providerOf(agent?.session),
          profile: profileIdOf(agent),
          explicit: typeof state.agentProfiles[id] === 'string',
          restricted: record !== undefined,
          visible: visible.length,
          keep: record?.allow ?? (profileDefs()[profileIdOf(agent)] ?? []).filter((n) => visible.includes(n)),
        })
      }
      if (action === 'profile') {
        const next = String(args?.profile ?? '').trim()
        const defs = profileDefs()
        if (!Object.prototype.hasOwnProperty.call(defs, next)) {
          return JSON.stringify({ ok: false, error: '没有这个档位：' + next, profiles: Object.keys(defs) })
        }
        state.agentProfiles[id] = next
        const persisted = saveState()
        const result = applyProfile(agent)
        remember(`会话 ${id} 换到 ${next} 档`, 'good')
        return JSON.stringify({ ok: result.ok, persisted, ...result })
      }
      if (action === 'set') {
        const tool = String(args?.tool ?? '').trim()
        if (tool.length === 0) return JSON.stringify({ ok: false, error: 'tool 必填' })
        const visible = visibleTools(agent)
        if (!visible.includes(tool)) return JSON.stringify({ ok: false, error: '当前不可见：' + tool, tools: visible })
        const profile = profileIdOf(agent)
        if (profile === 'full') {
          return JSON.stringify({ ok: false, error: '当前是 full 档（不限制），先换到 local 或 custom 再逐个开关' })
        }
        const defs = profileDefs()
        const current = new Set(defs[profile] ?? [])
        if (args?.enabled === false) current.delete(tool)
        else current.add(tool)
        state.profiles[profile] = [...current]
        const persisted = saveState()
        const result = applyProfile(agent)
        return JSON.stringify({ ok: result.ok, persisted, profile, keep: state.profiles[profile], ...result })
      }
      if (action === 'apply') {
        const rows = planAll()
        return JSON.stringify({ ok: true, rows })
      }
      if (action === 'restore') {
        const rows = []
        for (const a of agents()) rows.push({ agent: agentKey(a), off: releaseAgent(a) })
        return JSON.stringify({ ok: true, rows })
      }
      return JSON.stringify({ ok: false, error: 'unknown action: ' + action })
    },
  }

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

  const findAgent = (id) => agents().find((agent) => agentKey(agent) === id)


  // ── 端点表：DSH 自带 webServer 与固定端口面板共用这一份 ──────
  const handlers = {
    status: async () => statusView(),
    // 换档：只影响这一条会话
    setProfile: async (body) => {
      const agentId = String(body?.agent ?? '').trim()
      const next = String(body?.profile ?? '').trim()
      const defs = profileDefs()
      if (!Object.prototype.hasOwnProperty.call(defs, next)) {
        return { ok: false, error: '没有这个档位：' + next }
      }
      if (agentId.length === 0) return { ok: false, error: 'agent 必填' }
      state.agentProfiles[agentId] = next
      const persisted = saveState()
      const agent = findAgent(agentId)
      const result = agent === undefined ? { ok: false, why: '会话不在了' } : applyProfile(agent)
      remember(`会话 ${agentId} 换到 ${next} 档`, 'good')
      return { ok: true, persisted, result, lastAction }
    },
    // 清掉显式档位，回到"按 provider 自动套档"
    autoProfile: async (body) => {
      const agentId = String(body?.agent ?? '').trim()
      if (agentId.length === 0) return { ok: false, error: 'agent 必填' }
      delete state.agentProfiles[agentId]
      const persisted = saveState()
      const agent = findAgent(agentId)
      const result = agent === undefined ? { ok: false, why: '会话不在了' } : applyProfile(agent)
      remember(`会话 ${agentId} 回到自动套档`, 'good')
      return { ok: true, persisted, result, lastAction }
    },
    // 改档位定义里的工具
    setProfileTools: async (body) => {
      const profile = String(body?.profile ?? '').trim()
      const tools = Array.isArray(body?.tools) ? body.tools.map(String) : null
      const defs = profileDefs()
      if (!Object.prototype.hasOwnProperty.call(defs, profile)) return { ok: false, error: '没有这个档位：' + profile }
      if (tools === null) return { ok: false, error: 'tools 必须是数组' }
      if (profile === 'full') return { ok: false, error: 'full 档固定为不限，别改它' }
      state.profiles[profile] = tools
      const persisted = saveState()
      const rows = planAll()
      remember(`档位 ${profile} 改成 ${tools.length} 项`, 'good')
      return { ok: true, persisted, tools, rows, lastAction }
    },
    setProvider: async (body) => {
      const id = String(body?.provider ?? '').trim()
      state.localProvider = id
      const persisted = saveState()
      remember(id ? `本地 provider 设为 ${id}` : '本地 provider 恢复自动识别', 'good')
      return { ok: true, localProvider: state.localProvider, persisted, lastAction }
    },
    // 全部会话按各自档位重装
    applyAll: async () => ({ ok: true, rows: planAll(), lastAction }),
    // 全部会话撤掉限制
    restoreAll: async () => {
      const rows = []
      for (const agent of agents()) rows.push({ agent: agentKey(agent), off: releaseAgent(agent) })
      remember('全部会话放开', 'good')
      return { ok: true, rows, lastAction }
    },
    // 插件层（profile 级）
    set: async (body) => {
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
    },
    applyPlugins: async () => {
      const entries = await listEntries()
      const targets = resolveTargets(entries, Array.isArray(read().localEntries) ? read().localEntries : [])
      const plugins = await setPlugins(targets, false)
      remember(`插件：关掉 ${plugins.done.length} 个`, 'good')
      return { ok: true, plugins, lastAction }
    },
    restorePlugins: async () => {
      const entries = await listEntries()
      const targets = resolveTargets(entries, Array.isArray(read().localEntries) ? read().localEntries : [])
      const plugins = await setPlugins(targets, true)
      remember(`插件：开回 ${plugins.done.length} 个`, 'good')
      return { ok: true, plugins, lastAction }
    },
  }

  // 第一大入口：DSH 自带 webServer 上的路由（同源校验）
  try {
    ctx.inject(['webServer'], (sctx) => {
      if (typeof sctx.webServer?.register !== 'function') return
      sctx.effect(
        () =>
          [panelRoute, ...Object.entries(handlers).map(([name, fn]) => route(name, fn))].map((r) =>
            sctx.webServer.register(r),
          ),
        'dsh-plugin-trim: control panel bridge',
      )
      report('DSH 路由已挂载：' + BRIDGE_PREFIX + '/' + Object.keys(handlers).join(','))
    })
  } catch (error) {
    report('DSH 路由未挂载 —— ' + String(error?.message ?? error))
  }

  // 第二大入口：固定端口的自带面板。
  // DSH 端口每次启动都变，所以插件自己起一个固定端口，URL 永远是
  //   http://127.0.0.1:12256/
  // 只监听回环，且只服务自己的面板，所以不做 Origin 校验（浏览器直开也能用）。
  const wantedPort = Number(read().panelPort) > 0 ? Number(read().panelPort) : 12256
  let panelPort = 0
  const isLoopbackOrigin = (origin) => {
    if (typeof origin !== 'string' || origin.length === 0) return false
    try {
      const host = new URL(origin).hostname
      return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
    } catch {
      return false
    }
  }

  const panelServer = createServer(async (req, res) => {
    const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
    const method = String(req.method ?? 'GET').toUpperCase()
    const origin = typeof req.headers?.origin === 'string' ? req.headers.origin : ''

    // 预检：只给回环来源放行，别的站点的跨域请求一律拒（面板只服务本机）。
    // 不做这一步的话浏览器会先把 OPTIONS 打过来，拿 405 就直接报「读取失败」。
    if (method === 'OPTIONS') {
      if (!isLoopbackOrigin(origin)) {
        writeJson(res, 403, { ok: false, error: 'cross-origin denied' })
        return
      }
      res.writeHead(204, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
        vary: 'origin',
      })
      res.end()
      return
    }

    if (method === 'GET' || method === 'HEAD') {
      if (url.pathname === '/' || url.pathname === '/panel' || url.pathname === '/index.html') {
        try {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(method === 'HEAD' ? undefined : panelHtml())
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
        return
      }
      if (url.pathname === '/health') {
        writeJson(res, 200, { ok: true, port: panelPort })
        return
      }
      writeJson(res, 404, { ok: false, error: 'not found: ' + url.pathname })
      return
    }

    if (method !== 'POST' || !url.pathname.startsWith(BRIDGE_PREFIX + '/')) {
      writeJson(res, 405, { ok: false, error: 'method not allowed: ' + method + ' ' + url.pathname })
      return
    }
    // 带 Origin 的写请求也必须是回环来源。
    if (origin.length > 0 && !isLoopbackOrigin(origin)) {
      writeJson(res, 403, { ok: false, error: 'cross-origin denied' })
      return
    }
    const name = url.pathname.slice(BRIDGE_PREFIX.length + 1)
    const handler = handlers[name]
    if (typeof handler !== 'function') {
      writeJson(res, 404, { ok: false, error: 'unknown endpoint: ' + name })
      return
    }
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
  })

  const startPanelOn = (port, tries) => {
    const onError = (error) => {
      if (error?.code === 'EADDRINUSE' && tries < 12) {
        startPanelOn(port + 1, tries + 1)
        return
      }
      report('固定端口面板启动失败：' + String(error?.message ?? error))
    }
    panelServer.once('error', onError)
    panelServer.listen(port, '127.0.0.1', () => {
      panelServer.removeListener('error', onError)
      panelPort = port
      report('固定端口面板：http://127.0.0.1:' + port + '/')
    })
  }

  try {
    ctx.effect(
      () => () => {
        try {
          panelServer.close()
        } catch {
          /* 已经关了 */
        }
      },
      'dsh-plugin-trim: fixed-port panel',
    )
    startPanelOn(wantedPort, 0)
  } catch (error) {
    report('固定端口面板未启动 —— ' + String(error?.message ?? error))
  }
}
