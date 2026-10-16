/** Terminal extensions load your configured Pi plugins in isolated hosts, exposing their commands, tools and portable UI. */
import { defineExtension, GenerationTask, hook, ToolTask } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";
import { TERMINAL_EXTENSION } from "../terminal/manager.ts";

export default function createTerminal(host: PocketHost) {
    const terminal = host.terminal;

    // A module can reload before a running older server has the new host member.
    if (!terminal) {
        return [];
    }

    return defineExtension({
        name: TERMINAL_EXTENSION,
        hooks: [
            hook(GenerationTask, {
                beforeRequest: async (_request, api, context) => {
                    await terminal.turnStart(api, context);
                },
                afterResponse: (message, api, context) =>
                    terminal.messageEnd(api, message, context),
                onYield: async (message, api, context) => {
                    await terminal.turnEnd(api, message, context);
                },
                afterTools: async (assistant, results, api, context) => {
                    const message = await terminal.assistant(assistant);

                    if (message) {
                        await terminal.turnEnd(api, message, context, results, false);
                    }
                },
            }),
            hook(ToolTask, {
                beforeTool: (call, api, context) => terminal.beforeTool(call, api, context),
                afterTool: (call, result, api, context) =>
                    terminal.afterTool(call, result, api, context),
            }),
        ],
    });
}
