/**
 * 开发用 · 拿本机真实数据跑一遍连接器。
 *
 * 只读不写、不联网、不落盘——把结果打在终端上，用来核对解析条数与
 * MemoryHub 主库 Python 版是否一致，以及在提纯前估一下 token 量级。
 *
 *   npx tsx scripts/scan-local.ts [会话数上限]
 */
import { countAvailable, scanClaudeCode } from '../src/connectors/index.ts'
import { estimateCost } from '../src/cost.ts'
import { renderConversation } from '../src/distill.ts'

const limit = Number(process.argv[2] ?? 100)
const model = process.argv[3] ?? 'deepseek-v4-flash'

const total = await countAvailable()
console.log(`本机可搬会话总数: ${total}`)

const { conversations, result } = await scanClaudeCode({ limitConversations: limit })
const turns = conversations.reduce((n, c) => n + c.turns.length, 0)
const users = conversations.reduce((n, c) => n + c.turns.filter(t => t.role === 'user').length, 0)
const chars = conversations.reduce((n, c) => n + c.turns.reduce((m, t) => m + t.text.length, 0), 0)

console.log(`扫描 ${result.conversations} 个会话 / ${turns} 条消息（user ${users} · assistant ${turns - users}）`)
console.log(`跳过非对话行 ${result.skipped} 条，解析失败 ${result.errors.length} 个文件`)
console.log(`正文合计 ${chars.toLocaleString()} 字符`)
for (const error of result.errors.slice(0, 5)) console.log(`  ! ${error.uri}: ${error.message}`)

const estimate = estimateCost(conversations.map(c => renderConversation(c.turns)), model, Date.now())
console.log(
  `\n提纯预估（${estimate.model}）：输入 ${estimate.inputTokens.toLocaleString()} tokens`
  + ` + 输出 ≈ ${estimate.outputTokens.toLocaleString()}`,
)
console.log(
  `  现在跑 ¥${estimate.cny}（${estimate.repriced ? (estimate.peak ? '高峰时段' : '空闲时段') : '调价前平价'}）`
  + `  ·  空闲时段跑 ¥${estimate.offPeakCny}`,
)

const sample = conversations[0]
if (sample !== undefined) {
  console.log(`\n样例会话 convId=${sample.convId}\n  project=${sample.project ?? '?'}`)
  for (const turn of sample.turns.slice(0, 3)) {
    console.log(`  [${turn.seq}] ${turn.role} @${turn.ts || '?'} :: ${turn.text.slice(0, 60).replace(/\s+/g, ' ')}…`)
  }
}
