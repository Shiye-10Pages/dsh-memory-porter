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
}

/**
 * host 侧我们用到的 dsh 上下文切面。
 *
 * 形状与 dsh-whale-meter 一致（那份已在真实 dsh 上跑通），另加 `llm`：
 * 提纯直接借宿主已配好的 provider —— **用户不需要为本插件再配任何 key**，
 * 这是相对 MemoryHub 主库最大的体验优势。
 */
export interface HostContext {
  on(event: string, listener: (...args: any[]) => any): () => void
  effect(callback: () => void | (() => void), label?: string): void
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
}

/** 过闸之前的候选：还没拿到 id / confidence / 状态。 */
export interface Candidate {
  type: MemoryType
  claim: string
  evidence: string
  context?: string
  source: SourcePointer
  /**
   * 命中「影响过滤器」（动资源 / 方向 / 收入）——
   * 契约要求这类候选**必须**走人工闸，即使其余三重过滤器都为否。
   */
  forceReview: boolean
}
