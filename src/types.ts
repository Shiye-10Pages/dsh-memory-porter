/**
 * 记忆搬家 · 核心数据模型
 *
 * 字段严格对齐 MemoryHub 主库的《保真契约 v1》(CONTRACT.md)——将来接主库
 * memory.db 时不需要做迁移。改字段 = 改地基，要同步升版本号。
 */

/** 记忆原子的来源通道。 */
export type SourceKind =
  /** 本机 ~/.claude/projects 的 Claude Code transcript */
  | 'claude-code'
  /** claude.ai 账号级导出里的 conversations.json */
  | 'claude-web'
  /** claude.ai 账号级导出里的 memories.json（Claude 对你的 AI 推断记忆） */
  | 'claude-memory'
  /** ChatGPT 账号级导出里的 conversations.json */
  | 'chatgpt'

/** 归一化后的一条对话消息——连接器层的最小输出单位。 */
export interface RawTurn {
  /**
   * 稳定的消息 id，用于跨次导入幂等去重。
   * 生成规则各连接器自定，但必须对同一条消息稳定复现。
   */
  id: string
  role: 'user' | 'assistant'
  /** 已去除工具调用/思维链噪声的纯对话正文。 */
  text: string
  /** ISO 8601；源侧拿不到时为空串（不猜、不填当前时间）。 */
  ts: string
  /** 该消息在会话内的序号，用于溯源指针。 */
  seq: number
}

/** 一个会话及其全部对话消息。 */
export interface RawConversation {
  source: SourceKind
  /** 源侧的会话 id；源侧缺失时由标题 + 创建时间哈希而来。 */
  convId: string
  title?: string
  /**
   * 溯源指针：本机源是文件绝对路径，导出源是导出文件名。
   * 写进记忆的 sources[].uri，让每条记忆都能回到原文。
   */
  uri?: string
  /** 会话所属项目/工作目录（Claude Code 有，其余源无）。 */
  project?: string
  turns: RawTurn[]
}

/** 一次扫描/导入的统计，直接喂给面板进度条。 */
export interface ScanResult {
  source: SourceKind
  /** 扫到的会话数 */
  conversations: number
  /** 归一化出的消息数 */
  turns: number
  /** 跳过的非对话行（tool_use / thinking / 元数据等） */
  skipped: number
  /** 逐文件的解析失败，不中断整轮，如实报给用户 */
  errors: { uri: string; message: string }[]
}

/** 保真契约 v1 的记忆类型。 */
export type MemoryType =
  | '方法论' | '决策' | '经验' | 'SOP' | '认知' | '反馈' | '事实' | '偏好' | '关系'

/** 保真契约 v1 的状态机。 */
export type MemoryStatus = '待验证' | '已应用' | '已归档' | '已失效'

/** 溯源指针——每条记忆至少一条，缺失即拒收。 */
export interface SourcePointer {
  source: SourceKind
  convId: string
  /** 回到原文的位置：文件路径 + 消息序号 */
  uri?: string
  seq?: number
  ts?: string
}

/**
 * 记忆原子（保真契约 v1）。
 *
 * `evidence` 是硬闸门：**没有逐字原文就拒收**，这是整个产品的信任基础，
 * 也是与生态里其他记忆插件唯一的硬区别。任何时候都不要给它默认值。
 */
export interface MemoryItem {
  id: string
  type: MemoryType
  /** 一句话结论，自包含——脱离上下文也能读懂。 */
  claim: string
  /** 逐字原文证据。空 → 溯源闸拒收。 */
  evidence: string
  /** 证据所处的情境，可选。 */
  context?: string
  sources: SourcePointer[]
  /** 复合置信度 0..1，算法见 confidence.ts。 */
  confidence: number
  /** 何时开始为真（ISO 8601）。 */
  validFrom: string
  /** 何时失效；null = 现行。被新结论取代时由矛盾闸填。 */
  validUntil: string | null
  status: MemoryStatus
  /** 再审日期，默认 validFrom + 14 天。 */
  reviewDate: string
  /** 关联原子 id（矛盾闸互链用）。 */
  links: string[]
  /** 内容哈希，去重合并闸的第一层。 */
  contentHash: string
  /**
   * 这条为什么自动入库、或为什么需要你看一眼。
   *
   * **每条记忆都必须能说清自己是怎么进来的**——用户凭这句话决定要不要调档位，
   * 也凭它判断这个库值不值得信。面板直接把它显示出来，不做二次翻译。
   */
  gateReason: GateReason
}

/**
 * 过闸判据。`auto-` 前缀是自动入库，`human-` 前缀要人看。
 *
 * **刻意用稳定的机器键而不是中文字面量**：它既要落进 JSONL 长期存着，
 * 又要在中英两种界面里显示。存键、渲染时再翻译，换语言不用迁移数据。
 */
export type GateReason =
  /** 置信度达标，直接入库 */
  | 'auto-confidence'
  /** 与已有记忆同结论，已并源 */
  | 'auto-multi-source'
  /** 来源是 AI 推断（Claude 云端记忆），按契约绝不自动入库 */
  | 'human-ai-inferred'
  /** 动到了资源 / 方向 / 收入 */
  | 'human-high-impact'
  /** 与库里已有结论同主题但不同，谁对由你判 */
  | 'human-conflict'
  /** 置信度低于阈值 */
  | 'human-low-confidence'
  /** 用户把档位调到了"全部人工确认" */
  | 'human-user-choice'

/**
 * 宿主 LLM 服务的切面（对应 @deepseek-ai/dsh-llm 的 `ctx.llm`）。
 *
 * 故意**不 import 官方包**，只声明我们真正调用的那几个字段——与
 * dsh-whale-meter 同一策略：插件零运行时依赖，就不会被上游 rc 版本的
 * 类型变动波及；真出问题也只坏在这一层，好定位。
 */
export interface LlmStreamSlice {
  stream(options: {
    provider: string
    model: string
    messages: { id: string; role: 'user' | 'assistant'; content: { type: 'text'; text: string }[] }[]
    system?: string
    temperature?: number
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<LlmStreamChunk>
}

/**
 * 完整的 llm 切面 = 流式调用 + 模型发现。
 *
 * 拆成两个是有意的：提纯只需要 `stream`，不该因为多了两个发现方法而被迫依赖它们
 * （测试里的假 llm 也就不用凭空实现两个用不到的函数）。
 */
export interface LlmSlice extends LlmStreamSlice {
  /** 已注册的 provider 路由，供面板列选项。 */
  listProviders(): { id: string; name: string }[]
  /** 某个 provider 当前对外提供的模型。可能走网络发现，调用方要容错。 */
  listModels(provider: string): Promise<{ provider: string; id: string; name: string; description?: string }[]>
}

/** 我们只关心文本增量与用量两种 chunk，其余（reasoning/tool-call）一律忽略。 */
export type LlmStreamChunk =
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number } }
  | { type: string; [key: string]: unknown }

/** 宿主当前默认模型（对应 `ctx.agentDefaultModel`）——借它就等于借用户已配好的 key。 */
export interface DefaultModelSlice {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
}

/**
 * 宿主工具注册表切面（对应 `ctx.tools`）。
 *
 * `output` 是官方必填项：注册时就要声明这个工具的规范返回值长什么样、
 * 以及怎么渲染给模型看。同样只声明我们用到的字段。
 */
export interface ToolsSlice {
  register(definition: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: {
      schema: Record<string, unknown>
      render(args: unknown, value: unknown): { type: 'text'; text: string }[]
    }
    execute(args: unknown, exec: { signal?: AbortSignal }): Promise<unknown>
    timeoutMs?: number
  }): () => void
}

/**
 * host 侧我们用到的 dsh 上下文切面。
 *
 * 形状与 dsh-whale-meter 一致（那份已在真实 dsh 上跑通），另加 `llm` 与
 * `agentDefaultModel`：提纯直接借宿主已配好的 provider ——
 * **用户不需要为本插件再配任何 key**，这是相对 MemoryHub 主库最大的体验优势。
 * 两者都做成可选：宿主没挂载时降级为"只扫描不提纯"，而不是插件挂掉。
 */
export interface HostContext {
  on(event: string, listener: (...args: any[]) => any): () => void
  effect(callback: () => void | (() => void), label?: string): void
  /**
   * 机会性取用一个可能没挂载的服务。
   *
   * 这版 Cordis 的 `inject` **只有必需语义**——声明了就等，等不到插件永远不激活
   * （对象形态会被当成「服务名 → 配置」的映射，不是 `{required, optional}`）。
   * 所以可选依赖只能这样在用的时候现取。
   */
  get<T = unknown>(name: string): T | undefined
  /** 等某些服务就绪后再跑一段。用于「有就注册、没有就算了」的可选接线。 */
  inject(names: readonly string[], callback: (ctx: HostContext) => void): void
  logger: { info(msg: string): void; warn(msg: string): void; debug?(msg: string): void }
  webServer: {
    register(route: {
      name: string
      kind: 'exact' | 'prefix'
      path: string
      handler: (
        req: import('node:http').IncomingMessage,
        res: import('node:http').ServerResponse,
      ) => void | Promise<void>
    }): () => void
  }
}

/** 插件配置（cordis.yml 里可改，不硬编码任何部署相关取值）。 */
export interface PorterConfig {
  /** 单次扫描处理的会话数上限。0 = 不限。默认 100——这是成本闸，不是性能闸。 */
  scanLimit?: number
  /** Claude Code 会话根目录，默认 ~/.claude/projects。 */
  claudeCodeRoot?: string
  /** 记忆落盘目录，默认 ~/.dsh/memory-porter。 */
  dataDir?: string
  /** 人工闸松紧档，默认 balanced。面板可实时切换，见 ReviewMode。 */
  reviewMode?: ReviewMode
  /**
   * 提纯专用模型。不填则跟随宿主的默认模型（`agentDefaultModel`）。
   *
   * 单独开这个口子是因为**聊天和搬家该用不同的模型**：聊天可能用 v4-pro，
   * 但搬家是批量作业，flash 的输出价只有 pro 的三分之一，100 个会话能差几十块。
   * 会话里临时切的模型不影响这里——那是 entry point 的事，插件拿不到也不该拿。
   */
  distillModel?: { provider: string; model: string }
}

/**
 * 人工闸松紧档——**这条选择必须交给用户，且必须说人话**。
 *
 * 默认 balanced：网页导出（Claude / ChatGPT 搬家的主线来源）的置信度
 * 恰好等于阈值 0.45，判据是 `<`，所以它自动入库。这个取舍摆在面板上明说，
 * 想更保守的人一键切到 strict。
 */
export type ReviewMode =
  /** 全部进待确认队列，一条都不自动入库 */
  | 'strict'
  /** 默认：高影响 / 冲突 / AI 推断 / 低置信才要你看 */
  | 'balanced'
  /** 只有 AI 推断和冲突才要你看，其余全自动 */
  | 'trusting'

/** 过闸之前的候选：还没拿到 id / confidence / 状态。 */
export interface Candidate {
  type: MemoryType
  claim: string
  evidence: string
  context?: string
  source: SourcePointer
  /**
   * 模型判定命中了「影响过滤器」（动资源 / 方向 / 收入）。
   *
   * 注意这只是**模型的判定**，不直接等于走人工闸——主库的教训是单个高频词
   * （方向 / 课程 / 付费）会把普通候选大批刷进人工闸（曾积压 672 条）。
   * 真正的判定在人工闸里做，见 gate.ts 的 `isHighImpact`。
   */
  impact: boolean
  /**
   * 来源本身就要求人工确认（与 impact 无关）。
   * 目前只有 Claude 云端记忆走这条：它是 AI 推断的结论，不是你逐字说过的话。
   */
  forceReview: boolean
}
