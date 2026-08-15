import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { createAnalysisContext, MixedAdapter } from '../src/bridge.ts'
import { resolveConfig } from '../src/config.ts'

class CapturingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'text-delta', index: 0, text: '最终回答' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('Mix agent-loop integration', () => {
  it('logs the image message before slow preprocessing and persists analysis before the base reply', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })

    const base = new CapturingAdapter()
    ctx.llm.registerAdapter(['base'], base)
    const preprocessingStarted = Promise.withResolvers<void>()
    const releasePreprocessing = Promise.withResolvers<void>()
    let shouldPreprocess = true
    const config = resolveConfig({ baseModel: { provider: 'base', model: 'chat' } })
    ctx.llm.registerAdapter(['vision-mix'], new MixedAdapter(ctx, () => config, async (options) => {
      if (!shouldPreprocess) return false
      shouldPreprocess = false
      preprocessingStarted.resolve()
      await releasePreprocessing.promise
      if (options.sessionId === undefined) throw new Error('missing session id')
      const agent = ctx.agents.get(options.sessionId)
      if (agent === undefined) throw new Error('missing live agent')
      agent.steer(createAnalysisContext('页面', '图片中有一个绿色按钮。', {
        attachmentId: AttachmentId(`sha256:${'f'.repeat(64)}`), mediaType: 'image/png',
        bytes: 3, width: 1, height: 1, name: 'screen.png',
      }))
      return true
    }))

    const agent = ctx.agentLoop.create(SessionId('bridge-loop'), { provider: 'vision-mix', model: 'mix' })
    const image = {
      attachmentId: AttachmentId(`sha256:${'f'.repeat(64)}`), mediaType: 'image/png' as const,
      bytes: 3, width: 1, height: 1,
    }
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '这是什么？' }, { type: 'image', attachment: image }],
      source: { kind: 'user' },
    }))

    await preprocessingStarted.promise
    const visibleBeforeAnalysis = agent.session.events.filter(event => event.type === 'user/message')
    expect(visibleBeforeAnalysis).toHaveLength(1)
    expect(visibleBeforeAnalysis[0]?.type === 'user/message'
      && visibleBeforeAnalysis[0].data.content.some(block => block.type === 'image')).toBe(true)
    expect(base.requests).toHaveLength(0)

    releasePreprocessing.resolve()
    await agent.whenIdle()

    const enteredMessages = agent.session.events
      .filter(event => event.type === 'user/message')
      .map(event => event.type === 'user/message' ? event.data : undefined)
    expect(enteredMessages).toHaveLength(2)
    expect(enteredMessages[1]?.source).toEqual({ kind: 'plugin', plugin: 'vision-mix' })
    expect(base.requests).toHaveLength(1)
    expect(base.requests[0]?.messages.some(message =>
      message.content.some(block => block.type === 'text' && block.text.includes('绿色按钮')))).toBe(true)
    expect(base.requests[0]?.messages.some(message =>
      message.content.some(block => block.type === 'image'))).toBe(false)
    expect(agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(2)
  })
})
