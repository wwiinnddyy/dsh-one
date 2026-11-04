/** Optional DSH Go native panel, status strip, and toasts. Absent hosts are skipped. */

import type { DshContextLike, PanelOverview, TaskService, IntakeService } from '../types.js'
import type { OneCore } from '../core/registry.js'
import type { SettingsService } from '../core/settings.js'
import { buildPanelOverview } from './api.js'

interface DshGoServiceLike {
  panel(id: string, definition: Record<string, unknown>): () => void
  strip(id: string, data: (scope: unknown, emit: (value: unknown) => void, caps: unknown) => () => void): () => void
  refresh(id: string, scope?: unknown): void
}

type View = Record<string, unknown>

/** Register the native panel when the DSH Go bridge is present. */
export function registerDshGoPanel(
  ctx: DshContextLike,
  core: OneCore,
  settings: SettingsService,
): () => void {
  const disposers: (() => void)[] = []
  const attach = (child: DshContextLike): void => {
    const service = child.get('dshGo') as DshGoServiceLike | undefined
    if (service === undefined) return
    const notify = (): void => {
      try {
        service.refresh('one')
      } catch {
        // A refresh failure must not break task transitions.
      }
    }
    const unsubscribers: (() => void)[] = []
    const tasks = child.get('oneTasks') as TaskService | undefined
    const intake = child.get('oneIntake') as IntakeService | undefined
    if (tasks !== undefined) unsubscribers.push(tasks.subscribe(notify))
    if (intake !== undefined) unsubscribers.push(intake.subscribe(notify))
    unsubscribers.push(settings.subscribe(notify))
    disposers.push(() => {
      for (const unsubscribe of unsubscribers.reverse()) unsubscribe()
    })
    disposers.push(service.panel('one', {
      view: () => panelView(buildPanelOverview(child, core, settings)),
      data: (_scope: unknown, emit: (value: unknown) => void) => {
        const push = (): void => {
          const overview = buildPanelOverview(child, core, settings)
          emit({
            displayName: overview.displayName,
            attention: overview.attention.length,
            running: overview.running.length,
            history: overview.history.length,
            leases: overview.health.leases,
            policyVersion: overview.health.policyVersion ?? '',
          })
        }
        push()
        const disposersInner: (() => void)[] = []
        if (tasks !== undefined) disposersInner.push(tasks.subscribe(push))
        if (intake !== undefined) disposersInner.push(intake.subscribe(push))
        disposersInner.push(settings.subscribe(push))
        return () => {
          for (const dispose of disposersInner.reverse()) dispose()
        }
      },
      actions: {
        refresh: (_scope: unknown, _event: unknown) => ({ refresh: true, toast: `${settings.displayName()} refreshed` }),
      },
    }))
    disposers.push(service.strip('one', (_scope: unknown, emit: (value: unknown) => void) => {
      const push = (): void => {
        const overview = buildPanelOverview(child, core, settings)
        const text = `${overview.displayName} ${overview.attention.length}/${overview.running.length}`
        emit({
          text,
          icon: overview.attention.length > 0 ? 'warning' : 'pending',
          tone: overview.attention.length > 0 ? 'warn' : 'muted',
        })
      }
      push()
      const disposersInner: (() => void)[] = []
      if (tasks !== undefined) disposersInner.push(tasks.subscribe(push))
      if (intake !== undefined) disposersInner.push(intake.subscribe(push))
      disposersInner.push(settings.subscribe(push))
      return () => {
        for (const dispose of disposersInner.reverse()) dispose()
      }
    }))
  }
  if (typeof ctx.inject === 'function') {
    const result = ctx.inject(['dshGo'], child => {
      ctx.effect(() => {
        attach(child)
        return () => {
          for (const dispose of disposers.reverse()) dispose()
        }
      }, 'dsh-one: dshGo panel')
    })
    void result
  } else {
    if (ctx.get('dshGo') !== undefined) attach(ctx)
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

function panelView(overview: PanelOverview): View {
  const attention = overview.attention.slice(0, 8).map(item => ({
    title: item.title,
    subtitle: item.detail ?? item.status,
    trailing: item.status,
    tone: item.status === 'failed' ? 'bad' : 'warn',
  }))
  const running = overview.running.slice(0, 8).map(item => ({
    title: item.title,
    subtitle: item.detail ?? '',
    trailing: item.status,
    tone: 'info',
  }))
  const history = overview.history.slice(0, 6).map(item => ({
    title: item.title,
    trailing: item.status,
    tone: 'muted',
  }))
  return {
    type: 'stack',
    title: overview.displayName,
    children: [
      {
        type: 'keyValue',
        items: [
          ['Attention', overview.attention.length],
          ['Running', overview.running.length],
          ['Workers', `${overview.health.workers}/${overview.health.maxWorkers}`],
          ['Leases', overview.health.leases],
          ['Policy', overview.health.policyVersion ?? '—'],
          ['Storage', overview.health.storage],
        ],
      },
      ...(attention.length === 0
        ? [{ type: 'callout', text: 'Nothing needs a person right now.', tone: 'good' }]
        : [{ type: 'text', text: '**Needs attention**' }, { type: 'list', items: attention }]),
      ...(running.length === 0 ? [] : [{ type: 'text', text: '**Running**' }, { type: 'list', items: running }]),
      ...(history.length === 0 ? [] : [{ type: 'text', text: '**History**' }, { type: 'list', items: history }]),
      ...(overview.health.lastError === undefined
        ? []
        : [{ type: 'callout', text: overview.health.lastError, tone: 'bad' }]),
    ],
  }
}
