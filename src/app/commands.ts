/**
 * The human `/one` command.
 *
 * The command path is separate from the model tools on purpose: a human typing
 * `/one send ...` is not the assistant, so its messages are never tagged.
 */

import type { CommandDefinitionLike, CommandResultLike, DshContextLike } from '../types.js'
import type { OneRuntime } from './runtime.js'
import { splitFirstToken } from './args.js'
import { stageOf } from '../core/stage.js'

const HELP = [
  '用法：',
  '  /one status                     查看工单与会话',
  '  /one name [新名字|reset]        查看/修改助手名字',
  '  /one persona [文本|reset]       查看/修改助手行为文本',
  '  /one send <sessionId> <text>    给某个会话发消息',
  '  /one workspace <path> [name]    创建/注册工作区',
  '  /one assistant                  打开或创建助手会话',
].join('\n')

export function registerOneCommand(ctx: DshContextLike, runtime: OneRuntime): () => void {
  if (ctx.commands === undefined) return () => {}
  const definition: CommandDefinitionLike = {
    name: 'one',
    description: 'DSH One: tickets, assistant name, workspaces.',
    input: { hint: 'status | name | persona | send | workspace | assistant' },
    async handler(invocation): Promise<CommandResultLike> {
      const { token, rest } = splitFirstToken(invocation.rawInput)
      switch (token) {
        case '':
        case 'help':
          return { kind: 'success', text: HELP }
        case 'status': {
          const tickets = runtime.engine.list()
          const open = tickets.filter(item => item.status === 'open')
          const byStage: Record<string, number> = {}
          for (const ticket of open) {
            const stage = stageOf(ticket)
            byStage[stage] = (byStage[stage] ?? 0) + 1
          }
          const stages = Object.entries(byStage).map(([stage, count]) => `${stage}=${count}`).join(' ')
          const workers = runtime.store.listSessions().filter(item => item.role === 'executor').length
          return {
            kind: 'success',
            text: `工单 ${tickets.length}（open ${open.length}）  ${stages || '无'}\n执行会话 ${workers}`,
          }
        }
        case 'name': {
          const value = rest.trim()
          if (value === '') return { kind: 'success', text: `当前名字：${runtime.assistantName()}` }
          const next = value === 'reset' ? await runtime.settings.resetDisplayName() : await runtime.settings.setDisplayName(value)
          return { kind: 'success', text: `名字已更新为「${next}」` }
        }
        case 'persona': {
          const value = rest.trim()
          if (value === '') {
            const current = runtime.settings.persona()
            return { kind: 'success', text: current === undefined ? '当前使用内置行为文本。' : current }
          }
          if (value === 'reset') {
            await runtime.settings.clearPersona()
            return { kind: 'success', text: '已恢复内置行为文本。' }
          }
          await runtime.settings.setPersona(value)
          return { kind: 'success', text: '助手行为文本已更新。' }
        }
        case 'send': {
          const { token: sessionId, rest: text } = splitFirstToken(rest)
          if (sessionId === '' || text.trim() === '') return { kind: 'error', text: '用法：/one send <sessionId> <text>' }
          await runtime.executor.enqueueReply(sessionId, text.trim())
          runtime.executor.schedule()
          return { kind: 'success', text: `已排队发送到 ${sessionId}` }
        }
        case 'workspace': {
          const { token: path, rest: name } = splitFirstToken(rest)
          if (path === '') return { kind: 'error', text: '用法：/one workspace <path> [name]' }
          const created = await runtime.workspace.create({ path, ...(name.trim() === '' ? {} : { name: name.trim() }) })
          return { kind: 'success', text: `工作区：${created.path}${created.workspaceId === undefined ? '' : `（${created.workspaceId}）`}` }
        }
        case 'assistant': {
          const result = await runtime.ensureAssistant()
          return {
            kind: 'success',
            text: `${result.created ? '已创建' : '已找到'}助手会话：${result.sessionId}\n目录：${result.home}`,
          }
        }
        default:
          return { kind: 'error', text: `未知子命令 "${token}"。\n${HELP}` }
      }
    },
  }
  return ctx.commands.register(definition)
}
