/** Reserve sender memory before constructing snapshots, without queuing unbounded work. */
import { HttpError } from "../errors.ts";
import { MAX_REQUEST_BYTES } from "./protocol.ts";

export const MAX_INFLIGHT_REQUEST_BYTES = 4 * MAX_REQUEST_BYTES;

export interface RequestReservation {
    resize(bytes: number): void;
    release(): void;
}

export class RequestBudget {
    #used = 0;

    reserve(): RequestReservation {
        if (this.#used + MAX_REQUEST_BYTES > MAX_INFLIGHT_REQUEST_BYTES) {
            throw new HttpError(
                429,
                "Terminal extension request memory is busy; retry after other operations finish",
            );
        }

        let held = MAX_REQUEST_BYTES;
        let released = false;

        this.#used += held;

        return {
            resize: (bytes) => {
                if (released || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > held) {
                    throw new Error("Invalid terminal extension request reservation");
                }

                this.#used -= held - bytes;
                held = bytes;
            },
            release: () => {
                if (!released) {
                    this.#used -= held;
                    released = true;
                }
            },
        };
    }
}
