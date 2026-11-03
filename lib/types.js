/** Shared contracts for dsh-one's host half. */
/** Errors with a stable code for tool and command presentation. */
export class OneError extends Error {
    code;
    details;
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'OneError';
        this.code = code;
        this.details = details;
    }
}
