/** Process-wide sharing of the one `dsh-one` domain across the three plugin rows. */
import { OneStore } from './store.js';
const cache = new WeakMap();
function ownerKey(ctx) {
    const facility = ctx.get('storageDomain');
    if (typeof facility === 'object' && facility !== null)
        return facility;
    const root = ctx.root;
    if (typeof root === 'object' && root !== null)
        return root;
    return ctx;
}
/**
 * Acquire the shared store. Each row holds one reference; the last release
 * closes the domain. A row that starts later joins the same open domain.
 */
export async function acquireStore(ctx, config) {
    const key = ownerKey(ctx);
    let entry = cache.get(key);
    if (entry === undefined) {
        const promise = OneStore.create(ctx, config);
        entry = { promise, count: 0 };
        cache.set(key, entry);
        promise.catch(() => {
            if (cache.get(key) === entry)
                cache.delete(key);
        });
    }
    entry.count += 1;
    const store = await entry.promise;
    let released = false;
    return {
        store,
        async release() {
            if (released)
                return;
            released = true;
            const current = cache.get(key);
            if (current === undefined || current !== entry)
                return;
            current.count -= 1;
            if (current.count > 0)
                return;
            cache.delete(key);
            await store.close();
        },
    };
}
