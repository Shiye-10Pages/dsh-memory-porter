/**
 * `memory-porter` 命名空间词典（zh 为键集源）。
 *
 * 两条约定：
 * 1. **入库依据（gateReason）在 host 侧是稳定的机器键**（`auto-confidence` 等），
 *    到这里才翻成人话——所以换语言不用迁移已经落盘的 JSONL。
 * 2. 面板优先用宿主 locale 服务的 `t`，拿不到就退到本文件的 `fallbackT`：
 *    宿主 API 形态变了，面板也还能读。
 */

export const NS = 'memory-porter'

export const zh = {
  'chip.title': '记忆搬家：本机 {count} 个会话可搬',
  'side.label': '记忆搬家',
  'side.title': '记忆搬家 · 本机 {portable} 个会话可搬{pending}',
  'side.pending': ' · {count} 条待确认',
  'panel.title': '记忆搬家',
  'panel.subtitle': '号可以没，记忆不能没',
  'panel.close': '关闭',
  'tab.port': '搬家',
  'tab.pending': '待确认',
  'tab.library': '记忆库',

  'top.portable': '本机 Claude Code 会话',
  'top.portableHint': '号没了这些也还在你硬盘上',
  'top.stored': '已搬进来的记忆',
  'top.pending': '等你确认',

  'lane.free': '免费 · 瞬时',
  'lane.local': '本机',
  'import.head': '有 Claude / ChatGPT 的导出？拖进来',
  'import.lead': '导出包里的 memories.json 是 Claude 记着的关于你的一切——它已经是结论，不过模型、不花一分钱，直接进你的库。而这份东西号一没就彻底消失，别处重建不出来。',
  'import.placeholder': '导出解压后的文件夹路径，或 conversations.json / memories.json',
  'import.action': '导入',
  'import.busy': '导入中…',
  'import.done': '读到 {conversations} 个会话；{candidates} 条 Claude 记忆已零成本进「待确认」页。',
  'import.more': ' 会话本身还要用模型提纯才能变成记忆，见下。',

  'stats.head': '没有导出？你硬盘上本来就还留着这些',
  'stats.action': '看看本机还剩多少（免费）',
  'stats.busy': '统计中…',
  'stats.mine': '你自己说过的话',
  'stats.mineHint': '条，共 {chars} 字',
  'stats.convs': '会话 / 消息',
  'stats.convsHint': '{count} 条消息',
  'stats.earliest': '最早回到',
  'stats.earliestHint': '号没了，这些也还在',

  'local.action': '顺手粗筛一遍显式决断句（免费，会漏很多）',
  'local.busy': '粗筛中…',
  'local.done': '粗筛只挑得到「我决定 / 以后都 / 不要再」这类显式句式，这次挑出 {found} 句。真正的结论多数是隐含的，得靠下面的模型提纯。',

  'model.label': '提纯用',
  'model.follow': '跟随 {label}',
  'model.default': 'dsh 默认模型',
  'model.note': '想挖得更深？用模型完整提纯一遍——它能抓到规则抓不到的隐含结论，代价是会把对话原文发给你在 DSH 里配的模型服务商，并按用量收费。搬家是批量作业，和你聊天用的模型可以不一样——会话里临时切的模型不影响这里。',
  'model.none': '（当前列不出可选模型，会用宿主默认那个。）',

  'run.estimate': '① 先算算要花多少钱',
  'run.estimateBusy': '算账中…',
  'run.distill': '② 开始搬家',
  'run.distillBusy': '正在搬…',
  'run.progress': '正在搬 {done} / {total} 块 —— 这一步要等模型逐段读完，会话多时可能要几分钟，别关面板。',
  'estimate.line': '{conversations} 个会话 · 约 {tokens} tokens · 用 {model}（{source}）现在跑 ¥{cost}',
  'estimate.peak': '（高峰时段；等空闲时段跑约 ¥{cost}）',
  'estimate.outbound': ' —— 提纯会把对话原文发给你在 DSH 里配置的模型服务商。',
  'report.line': '搬完了（用的 {model}）：从 {conversations} 个会话提炼出 {candidates} 条候选，自动入库 {accepted} 条、待你确认 {pending} 条。',
  'report.blocked': ' 其中 {count} 条因为对不上原文被挡掉了 —— 证据必须逐字出现在你说过的话里，模型转述的一律不要。',
  'report.fromAssistant': ' 另有 {count} 条的证据出自 AI 的复述而非你的原话 —— 已全部推进「待确认」，不自动入库。',
  'report.errors': ' 另有 {count} 个会话解析失败。',
  'error.line': '出错了：{message}',

  'mode.head': '什么会自动入库，什么要你看一眼 —— 这条你自己定，随时能改：',
  'mode.strict': '逐条确认',
  'mode.strictDesc': '一条都不自动入库，全部等你点头。最稳，但队列会长。',
  'mode.balanced': '默认（推荐）',
  'mode.balancedDesc': '动到钱和方向的、与旧结论冲突的、AI 推断的，才要你看。网页导出的记忆会自动入库。',
  'mode.trusting': '省事',
  'mode.trustingDesc': '只有 AI 推断和冲突才拦你，其余全自动。适合先搬进来再慢慢看。',
  'mode.note': '当前档位改的是 cordis.yml 里的 reviewMode；面板这里的切换只影响下一次搬家。默认档下，Claude / ChatGPT 网页导出的记忆置信度正好卡在自动入库的线上——想更保守就切「逐条确认」。',

  'queue.note': '按「最该看一眼的排前面」排序。每条都标了为什么需要你确认，丢弃的条目不会再回到队列。',
  'queue.empty': '队列是空的。该看的都看完了，或者还没搬过东西进来。',
  'queue.loading': '读取中…',
  'card.approve': '批准入库',
  'card.discard': '丢弃',
  'card.related': '与 {count} 条已有记忆相关',
  'card.score': '相关度 {score}',
  'card.meta': '置信度 {confidence} · {date} 起 · 来源 {sources}',

  'library.placeholder': '试着问一句你以前说过的话，看看能不能召回',
  'library.search': '召回',
  'library.exportMd': '导出 MD',
  'library.exportJsonl': 'JSONL',
  'library.note': '模型也能直接调 recall_memory 拿到同一份结果。导出的 Markdown / JSONL 可以直接喂给生态里其他记忆插件——它们负责「从今天起记住」，这里负责「把过去搬进来」。',
  'library.empty': '记忆库还是空的，先去「搬家」页扫一遍。',
  'library.noHits': '没召回到相关记忆。',

  'reason.auto-confidence': '自动入库·置信达标',
  'reason.auto-multi-source': '自动入库·多源印证',
  'reason.human-ai-inferred': '待确认·AI 推断',
  'reason.human-high-impact': '待确认·高影响',
  'reason.human-conflict': '待确认·与已有记忆冲突',
  'reason.human-low-confidence': '待确认·置信不足',
  'reason.human-user-choice': '待确认·你选择了逐条确认',
}

/** 英文场一律用 portability / vendor lock-in 的说法，不提封号。 */
export const en: Record<keyof typeof zh, string> = {
  'chip.title': 'Memory Porter — {count} local conversations ready to port',
  'side.label': 'Memory Porter',
  'side.title': 'Memory Porter — {portable} local conversations{pending}',
  'side.pending': ' · {count} awaiting review',
  'panel.title': 'Memory Porter',
  'panel.subtitle': "Accounts come and go. Your memory shouldn't.",
  'panel.close': 'Close',
  'tab.port': 'Port',
  'tab.pending': 'Pending',
  'tab.library': 'Library',

  'top.portable': 'Local Claude Code conversations',
  'top.portableHint': 'Still on your disk, with or without the account',
  'top.stored': 'Memories ported',
  'top.pending': 'Awaiting review',

  'lane.free': 'Free · instant',
  'lane.local': 'Local',
  'import.head': 'Got a Claude / ChatGPT export? Point us at it',
  'import.lead': "Your export contains memories.json — everything Claude remembers about you. It is already distilled, so it costs no tokens and goes straight into your library. Lose access to the account and it is gone for good; nothing else can rebuild it.",
  'import.placeholder': 'Path to the unzipped export folder, or conversations.json / memories.json',
  'import.action': 'Import',
  'import.busy': 'Importing…',
  'import.done': 'Read {conversations} conversations; {candidates} Claude memories added to Pending at zero cost.',
  'import.more': ' The conversations still need model distillation to become memories — see below.',

  'stats.head': 'No export? This is what is still sitting on your disk',
  'stats.action': 'See what is still here (free)',
  'stats.busy': 'Counting…',
  'stats.mine': 'Things you said',
  'stats.mineHint': 'messages, {chars} characters',
  'stats.convs': 'Conversations / messages',
  'stats.convsHint': '{count} messages',
  'stats.earliest': 'Going back to',
  'stats.earliestHint': 'Still here, with or without the account',

  'local.action': 'Also skim for explicit decisions (free, misses a lot)',
  'local.busy': 'Skimming…',
  'local.done': 'The skim only catches explicit patterns like "I decided" or "from now on" — it found {found}. Most real conclusions are implicit; those need model distillation below.',

  'model.label': 'Distill with',
  'model.follow': 'Follow {label}',
  'model.default': "dsh default model",
  'model.note': 'Want more depth? A full model pass catches the implicit conclusions rules cannot. The cost: your conversation text is sent to whichever provider you configured in DSH, billed by usage. Porting is a batch job — it can use a different model than your chat, and switching models inside a session does not affect this.',
  'model.none': ' (No selectable models right now — the host default will be used.)',

  'run.estimate': '① Estimate the cost first',
  'run.estimateBusy': 'Estimating…',
  'run.distill': '② Start porting',
  'run.distillBusy': 'Porting…',
  'run.progress': 'Porting {done} / {total} chunks — the model reads each segment in turn, so this can take minutes with many conversations. Keep the panel open.',
  'estimate.line': '{conversations} conversations · ~{tokens} tokens · using {model} ({source}) · ¥{cost} right now',
  'estimate.peak': ' (peak hours; roughly ¥{cost} if you wait for off-peak)',
  'estimate.outbound': ' — distillation sends your conversation text to the provider configured in DSH.',
  'report.line': 'Done (via {model}): {candidates} candidates from {conversations} conversations — {accepted} stored automatically, {pending} awaiting your review.',
  'report.blocked': ' {count} were rejected because they did not match the source text — evidence must appear verbatim in what you actually said; paraphrase never counts.',
  'report.fromAssistant': ' {count} more were backed by the AI\'s restatement rather than your own words — all pushed to Pending, never stored automatically.',
  'report.errors': ' {count} conversations failed to parse.',
  'error.line': 'Something went wrong: {message}',

  'mode.head': 'What lands automatically vs. what you review — your call, changeable anytime:',
  'mode.strict': 'Review everything',
  'mode.strictDesc': 'Nothing is stored without your approval. Safest, but the queue gets long.',
  'mode.balanced': 'Default (recommended)',
  'mode.balancedDesc': 'Only money/direction calls, conflicts with existing memories, and AI-inferred items need you. Web-export memories land automatically.',
  'mode.trusting': 'Hands off',
  'mode.trustingDesc': 'Only AI-inferred items and conflicts stop you. Good for porting everything now and reviewing later.',
  'mode.note': 'This maps to reviewMode in cordis.yml; switching here affects the next port. On the default setting, memories from Claude / ChatGPT web exports land exactly on the auto-store threshold — switch to "Review everything" if you want to be stricter.',

  'queue.note': 'Sorted so the ones most worth a look come first. Each is tagged with why it needs you. Discarded items never come back.',
  'queue.empty': 'Queue is empty — either you have reviewed everything, or nothing has been ported yet.',
  'queue.loading': 'Loading…',
  'card.approve': 'Approve',
  'card.discard': 'Discard',
  'card.related': 'related to {count} existing memories',
  'card.score': 'relevance {score}',
  'card.meta': 'confidence {confidence} · from {date} · source {sources}',

  'library.placeholder': 'Ask about something you said before and see if it comes back',
  'library.search': 'Recall',
  'library.exportMd': 'Export MD',
  'library.exportJsonl': 'JSONL',
  'library.note': 'The model can call recall_memory for the same results. Exported Markdown / JSONL feeds straight into other memory plugins — they handle "remember from today", this handles "bring the past in".',
  'library.empty': 'Library is empty — start on the Port tab.',
  'library.noHits': 'Nothing relevant came back.',

  'reason.auto-confidence': 'Auto · confidence met',
  'reason.auto-multi-source': 'Auto · corroborated by multiple sources',
  'reason.human-ai-inferred': 'Review · AI-inferred',
  'reason.human-high-impact': 'Review · high impact',
  'reason.human-conflict': 'Review · conflicts with an existing memory',
  'reason.human-low-confidence': 'Review · low confidence',
  'reason.human-user-choice': 'Review · you chose to review everything',
}

export type PorterKey = keyof typeof zh

/** 宿主 locale 服务缺席时的本地兜底：按浏览器语言选表，中文兜底。 */
export function fallbackT(key: PorterKey, params?: Record<string, unknown>): string {
  const zhFirst = typeof navigator !== 'undefined'
    && navigator.language.toLowerCase().startsWith('zh')
  let text: string = (zhFirst ? zh[key] : en[key]) ?? zh[key] ?? key
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}
