import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { TuiService } from '../definition.ts'
import { run } from './runner.ts'

function stubTui() {
  const replaceSession = vi.fn()
  const notice = vi.fn()
  const setStatus = vi.fn()
  const readInput = vi.fn(async () => null)
  let interrupt: (() => void) | undefined
  const tui = {
    onInterrupt: (listener: () => void) => {
      interrupt = listener
      return () => { interrupt = undefined }
    },
    onQueueEdit: () => () => {},
    onRewind: () => () => {},
    readInput,
    resolveQueueEdit: vi.fn(),
    restoreInput: vi.fn(),
    replaceSession,
    setStatus,
    notice,
  } as unknown as TuiService
  return { tui, replaceSession, notice, setStatus, readInput, interrupt: () => { interrupt?.() } }
}

describe('runner startup', () => {
  it('publishes the requested resumed session as the only initial session', async () => {
    const { tui, replaceSession, notice } = stubTui()
    const start = vi.fn(async (options?: { resumeId?: string }) => {
      replaceSession([{ type: 'session/start', data: { id: options?.resumeId } }])
    })
    const execute = vi.fn()
    const exit = vi.fn()
    const services = new Map<string, unknown>([
      ['loader', { await: async () => undefined }],
      ['omdshSession', {
        start,
        execute,
        interruptVisible: () => false,
        editLatestFollowup: async () => undefined,
        rewindToTurn: async () => undefined,
        agent: undefined,
      }],
      ['omdshLoop', { disable: vi.fn(), pause: vi.fn(), syncAgent: vi.fn() }],
      ['omdshStartup', { afterSessionStart: async () => undefined }],
      ['cmdlineArgs', { get: () => ['--resume', 'session-123'] }],
      ['appExit', exit],
    ])
    const ctx = { get: (name: string) => services.get(name) } as unknown as Context

    await run(ctx, tui)

    expect(start).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ resumeId: 'session-123' }))
    expect(execute).not.toHaveBeenCalled()
    expect(replaceSession).toHaveBeenCalledTimes(1)
    expect(notice).toHaveBeenCalledWith('Resumed session-123.')
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('cancels a pending startup resume without creating a fallback session', async () => {
    const { tui, notice, setStatus, interrupt } = stubTui()
    const start = vi.fn((options?: { signal?: AbortSignal }) => {
      if (options?.signal === undefined) return Promise.resolve()
      return new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => { reject(options.signal?.reason) }, { once: true })
      })
    })
    const exit = vi.fn()
    const disable = vi.fn()
    const services = new Map<string, unknown>([
      ['loader', { await: async () => undefined }],
      ['omdshSession', {
        start,
        interruptVisible: () => false,
        editLatestFollowup: async () => undefined,
        rewindToTurn: async () => undefined,
        agent: undefined,
      }],
      ['omdshLoop', { disable, pause: vi.fn(), syncAgent: vi.fn() }],
      ['omdshStartup', { afterSessionStart: async () => undefined }],
      ['cmdlineArgs', { get: () => ['--resume', 'session-pending'] }],
      ['appExit', exit],
    ])
    const ctx = { get: (name: string) => services.get(name) } as unknown as Context

    const running = run(ctx, tui)
    await vi.waitFor(() => { expect(start).toHaveBeenCalledTimes(1) })
    interrupt()
    await running

    expect(start).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ resumeId: 'session-pending' }))
    expect(setStatus).toHaveBeenNthCalledWith(1, 'running')
    expect(setStatus).toHaveBeenLastCalledWith('idle')
    expect(notice).not.toHaveBeenCalled()
    expect(disable).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('exits when startup resolves after its resume signal was cancelled', async () => {
    const { tui, notice, setStatus, readInput, interrupt } = stubTui()
    const start = vi.fn((options?: { signal?: AbortSignal }) => {
      if (options?.signal === undefined) return Promise.resolve()
      return new Promise<void>((resolve) => {
        options.signal?.addEventListener('abort', () => { queueMicrotask(resolve) }, { once: true })
      })
    })
    const exit = vi.fn()
    const disable = vi.fn()
    const services = new Map<string, unknown>([
      ['loader', { await: async () => undefined }],
      ['omdshSession', {
        start,
        interruptVisible: () => false,
        editLatestFollowup: async () => undefined,
        rewindToTurn: async () => undefined,
        agent: undefined,
      }],
      ['omdshLoop', { disable, pause: vi.fn(), syncAgent: vi.fn() }],
      ['omdshStartup', { afterSessionStart: async () => undefined }],
      ['cmdlineArgs', { get: () => ['--resume', 'session-late-cancel'] }],
      ['appExit', exit],
    ])
    const ctx = { get: (name: string) => services.get(name) } as unknown as Context

    const running = run(ctx, tui)
    await vi.waitFor(() => { expect(start).toHaveBeenCalledTimes(1) })
    interrupt()
    await running

    expect(start).toHaveBeenCalledTimes(1)
    expect(setStatus).toHaveBeenNthCalledWith(1, 'running')
    expect(setStatus).toHaveBeenLastCalledWith('idle')
    expect(notice).not.toHaveBeenCalled()
    expect(readInput).not.toHaveBeenCalled()
    expect(disable).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('keeps ordinary startup on the default session path', async () => {
    const { tui } = stubTui()
    const start = vi.fn(async () => undefined)
    const exit = vi.fn()
    const services = new Map<string, unknown>([
      ['loader', { await: async () => undefined }],
      ['omdshSession', {
        start,
        interruptVisible: () => false,
        editLatestFollowup: async () => undefined,
        rewindToTurn: async () => undefined,
        agent: undefined,
      }],
      ['omdshLoop', { disable: vi.fn(), pause: vi.fn() }],
      ['omdshStartup', { afterSessionStart: async () => undefined }],
      ['cmdlineArgs', { get: () => [] }],
      ['appExit', exit],
    ])
    const ctx = { get: (name: string) => services.get(name) } as unknown as Context

    await run(ctx, tui)

    expect(start).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith()
    expect(exit).toHaveBeenCalledWith(0)
  })
})
