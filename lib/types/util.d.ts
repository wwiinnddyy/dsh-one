/** Small, dependency-free helpers shared by the host half. */
export declare const now: () => number;
export declare const sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
export declare const nextId: (prefix: string) => string;
export declare const REQUEST_ID_PATTERN: RegExp;
export interface ClassifiedError {
    readonly code: string;
    readonly message: string;
    readonly details: Record<string, unknown>;
}
/** Read a stable error code without trusting a particular error class. */
export declare function classifyError(error: unknown): ClassifiedError;
/** Whether a send failure is worth retrying. */
export declare function isRetryable(error: unknown): boolean;
/** Whether a failure is specifically a subagent-address refusal. */
export declare function isSubagentRefusal(error: unknown): boolean;
export declare function isAbortError(error: unknown, signal?: AbortSignal): boolean;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function asRecord(value: unknown): Record<string, unknown> | undefined;
export declare function asString(value: unknown): string | undefined;
export declare function asBoolean(value: unknown): boolean | undefined;
export declare function asStringArray(value: unknown): string[] | undefined;
/** Whether `target` is inside `root` (case-insensitive on Windows). */
export declare function pathWithin(root: string, target: string): boolean;
/** Truncate free text before it enters an audit row. */
export declare function preview(text: string, limit?: number): string;
/** Render a model route as `provider/model`. */
export declare function formatModel(provider: string, model: string): string;
/** Parse a `provider/model` route. */
export declare function parseModelRoute(value: string): {
    provider: string;
    model: string;
} | undefined;
/** Parse a leading command word plus the remaining raw text. */
export declare function splitFirstToken(text: string): {
    token: string;
    rest: string;
};
