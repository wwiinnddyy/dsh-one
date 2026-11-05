/** The assistant's chat channel: prompt its own DSH Session through the outbox. */
import type { OneCore } from '../core/registry.js';
import type { AssistantChannel, ChannelDelivery, WakeEnvelope } from './types.js';
export declare class WebChannel implements AssistantChannel {
    readonly id = "web";
    private readonly core;
    constructor(core: OneCore);
    deliver(wake: WakeEnvelope): Promise<ChannelDelivery>;
}
