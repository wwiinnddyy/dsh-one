/** Small, dependency-free helpers shared by the host half. */
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
export const now = () => Date.now();
export const sleep = async (ms, signal) => {
    if (ms <= 0) {
        signal?.throwIfAborted();
        return;
    }
    await new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolvePromise();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason ?? new Error('aborted'));
        };
        if (signal?.aborted === true) {
            onAbort();
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
    });
};
export const nextId = (prefix) => `${prefix}-${randomUUID()}`;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
/** Read a stable error code without trusting a particular error class. */
export function classifyError(error) {
    if (typeof error === 'object' && error !== null) {
        const record = error;
        const code = typeof record['code'] === 'string'
            ? record['code']
            : typeof record['name'] === 'string' && record['name'] !== 'Error'
                ? record['name']
                : 'unknown';
        const message = typeof record['message'] === 'string' ? record['message'] : String(error);
        const details = isRecord(record['details']) ? record['details'] : {};
        return { code, message, details };
    }
    return { code: 'unknown', message: String(error), details: {} };
}
/** Whether a send failure is worth retrying. */
export function isRetryable(error) {
    const { code, details } = classifyError(error);
    if (code === 'session/writer-held')
        return true;
    if (code === 'session/agent-busy') {
        const reason = typeof details['reason'] === 'string' ? details['reason'] : '';
        return !reason.includes('subagent');
    }
    return code === 'gateway/internal' || code === 'ECONNRESET' || code === 'ETIMEDOUT';
}
/** Whether a failure is specifically a subagent-address refusal. */
export function isSubagentRefusal(error) {
    const { code, message, details } = classifyError(error);
    if (code !== 'session/agent-busy')
        return false;
    const reason = typeof details['reason'] === 'string' ? details['reason'] : message;
    return reason.includes('subagent');
}
export function isAbortError(error, signal) {
    if (signal?.aborted === true)
        return true;
    if (typeof error === 'object' && error !== null) {
        const name = error['name'];
        if (name === 'AbortError')
            return true;
    }
    return classifyError(error).code === 'gateway/cancelled';
}
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function asRecord(value) {
    return isRecord(value) ? value : undefined;
}
export function asString(value) {
    return typeof value === 'string' ? value : undefined;
}
export function asBoolean(value) {
    return typeof value === 'boolean' ? value : undefined;
}
export function asStringArray(value) {
    if (!Array.isArray(value))
        return undefined;
    return value.filter((item) => typeof item === 'string');
}
/** Whether `target` is inside `root` (case-insensitive on Windows). */
export function pathWithin(root, target) {
    const normalizedRoot = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
    const normalizedTarget = process.platform === 'win32' ? resolve(target).toLowerCase() : resolve(target);
    const diff = relative(normalizedRoot, normalizedTarget);
    if (diff === '')
        return true;
    if (isAbsolute(diff))
        return false;
    return !diff.split(sep).includes('..');
}
/** Truncate free text before it enters an audit row. */
export function preview(text, limit = 120) {
    const single = text.replace(/\s+/gu, ' ').trim();
    return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`;
}
/** Render a model route as `provider/model`. */
export function formatModel(provider, model) {
    return `${provider}/${model}`;
}
/** Parse a `provider/model` route. */
export function parseModelRoute(value) {
    const slash = value.indexOf('/');
    if (slash <= 0 || slash === value.length - 1)
        return undefined;
    return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}
/** Parse a leading command word plus the remaining raw text. */
export function splitFirstToken(text) {
    const trimmed = text.trim();
    if (trimmed === '')
        return { token: '', rest: '' };
    const match = /^(\S+)(?:\s+|$)([\s\S]*)$/u.exec(trimmed);
    if (match === null)
        return { token: trimmed, rest: '' };
    return { token: match[1] ?? '', rest: match[2] ?? '' };
}
