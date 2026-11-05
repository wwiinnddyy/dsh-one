/**
 * User preferences that belong to the assistant, not to the deployment.
 *
 * The row config seeds the defaults; a stored value wins from then on. Keeping
 * these out of `Config` means renaming the assistant never restarts the plugin.
 */

import type { OneConfig } from '../types.js'
import type { Store } from './store.js'
import { UserError } from '../core/errors.js'

export const SETTINGS_NAMESPACE = 'one'
const DISPLAY_NAME_KEY = 'displayName'
const PERSONA_KEY = 'persona'
const NOTIFY_MUTED_KEY = 'notifyMuted'
const AVATAR_KEY = 'avatar'

/** Largest accepted avatar data URL, in characters (roughly 300 KB decoded). */
export const AVATAR_MAX_CHARS = 400_000

/** Only raster data URLs are accepted; SVG can carry script, so it is refused. */
const AVATAR_PATTERN = /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/u

export const DISPLAY_NAME_MAX_CHARS = 24

export const DEFAULT_PERSONA = [
  '## 你是谁',
  '你是本工作区的常驻助手，一个会自己把事情推进下去的协调者，而不是一个只会回答问题的聊天框。',
  '你拥有自己的对话与上下文，可以跨工作区观察、派活、推进目标。',
  '',
  '## 怎么工作',
  '- 用户给你一个目标时，先判断它需要几步；需要多个会话协作时，用 one_work 建工单并派给合适的会话。',
  '- 可以直接复用其他工作区里已有的会话，也可以自己选一个文件夹建工作区，再在那里开会话。',
  '- 需要知道有哪些工作区或会话时，用 one_status 查看，不要凭记忆猜。',
  '- 给别的会话发消息用 one_work 的 message 动作；只有你的消息会带 [来自助手「名字」]。',
  '- 先自己查证再下结论。不确定的事说不确定，不要编。',
  '',
  '## 什么时候开口',
  '只有三种情况需要你打断用户：计划全部完成；卡住了，只有人能做决定；失败了且你自己无法恢复。',
  '其余时候保持安静：进度、重试、中间步骤只写进工单记录，不要刷对话。',
].join('\n')

export function normalizeDisplayName(raw: string): string {
  const value = raw.trim()
  if (value === '') throw new UserError('one/name-empty', 'the assistant name cannot be empty', {})
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new UserError('one/name-invalid', 'the assistant name cannot contain control characters', {})
  }
  if ([...value].length > DISPLAY_NAME_MAX_CHARS) {
    throw new UserError('one/name-too-long', `the assistant name is limited to ${DISPLAY_NAME_MAX_CHARS} characters`, {})
  }
  return value
}

export class SettingsService {
  private readonly store: Store
  private readonly config: OneConfig
  private readonly now: () => number

  constructor(store: Store, config: OneConfig, now: () => number = Date.now) {
    this.store = store
    this.config = config
    this.now = now
  }

  displayName(): string {
    const stored = this.store.getSetting(SETTINGS_NAMESPACE, DISPLAY_NAME_KEY)?.value
    if (stored !== undefined) {
      try {
        return normalizeDisplayName(stored)
      } catch {
        // A bad persisted value must not break startup.
      }
    }
    return this.config.displayName
  }

  async setDisplayName(value: string, updatedBy: 'human' | 'agent' | 'system' = 'human'): Promise<string> {
    const name = normalizeDisplayName(value)
    await this.store.putSetting({
      namespace: SETTINGS_NAMESPACE,
      key: DISPLAY_NAME_KEY,
      value: name,
      updatedAt: this.now(),
      updatedBy,
    })
    return name
  }

  async resetDisplayName(): Promise<string> {
    await this.store.deleteSetting(SETTINGS_NAMESPACE, DISPLAY_NAME_KEY)
    return this.config.displayName
  }

  /** A raster data URL, or undefined to use the name's initial. */
  avatar(): string | undefined {
    const value = this.store.getSetting(SETTINGS_NAMESPACE, AVATAR_KEY)?.value
    return value === undefined || !AVATAR_PATTERN.test(value) ? undefined : value
  }

  async setAvatar(dataUrl: string): Promise<void> {
    const value = dataUrl.trim()
    if (value.length > AVATAR_MAX_CHARS) {
      throw new UserError('one/avatar-too-large', 'the avatar image is too large', { max: AVATAR_MAX_CHARS })
    }
    if (!AVATAR_PATTERN.test(value)) {
      throw new UserError('one/avatar-invalid', 'the avatar must be a PNG, JPEG, WebP or GIF data URL', {})
    }
    await this.store.putSetting({
      namespace: SETTINGS_NAMESPACE,
      key: AVATAR_KEY,
      value,
      updatedAt: this.now(),
      updatedBy: 'human',
    })
  }

  async clearAvatar(): Promise<void> {
    await this.store.deleteSetting(SETTINGS_NAMESPACE, AVATAR_KEY)
  }

  persona(): string | undefined {
    const value = this.store.getSetting(SETTINGS_NAMESPACE, PERSONA_KEY)?.value
    return value === undefined || value.trim() === '' ? undefined : value
  }

  async setPersona(text: string): Promise<void> {
    const value = text.trim()
    if (value === '') throw new UserError('one/persona-empty', 'the assistant prompt cannot be blank', {})
    if (value.length > 8_000) throw new UserError('one/persona-too-long', 'the assistant prompt is too long', {})
    await this.store.putSetting({
      namespace: SETTINGS_NAMESPACE,
      key: PERSONA_KEY,
      value,
      updatedAt: this.now(),
      updatedBy: 'human',
    })
  }

  async clearPersona(): Promise<void> {
    await this.store.deleteSetting(SETTINGS_NAMESPACE, PERSONA_KEY)
  }

  notifyMuted(): boolean {
    return this.store.getSetting(SETTINGS_NAMESPACE, NOTIFY_MUTED_KEY)?.value === 'true'
  }

  async setNotifyMuted(muted: boolean): Promise<void> {
    await this.store.putSetting({
      namespace: SETTINGS_NAMESPACE,
      key: NOTIFY_MUTED_KEY,
      value: muted ? 'true' : 'false',
      updatedAt: this.now(),
      updatedBy: 'human',
    })
  }
}
