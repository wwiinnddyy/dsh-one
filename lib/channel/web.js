/** The assistant's chat channel: prompt its own DSH Session through the outbox. */
import { classifyError } from '../util.js';
export class WebChannel {
    id = 'web';
    core;
    constructor(core) {
        this.core = core;
    }
    async deliver(wake) {
        try {
            const result = await this.core.send({
                targetSessionId: wake.targetSessionId,
                text: wake.text,
                requestId: wake.dedupeKey,
                mode: 'queue',
                source: 'wake',
                // The run owner is the assistant itself; a wake never needs the general
                // session allowlist to admit its own report.
                callerSessionId: wake.targetSessionId,
            });
            return result.status === 'sent' || result.status === 'observed'
                ? { status: 'sent' }
                : { status: 'failed', ...(result.error === undefined ? {} : { error: result.error }) };
        }
        catch (error) {
            return { status: 'failed', error: classifyError(error).message };
        }
    }
}
