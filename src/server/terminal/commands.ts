/** Pocket owns these short names even while their feature is off; every plugin also has /ext:<name>. */
export const POCKET_COMMAND_NAMES = new Set([
    "artifacts",
    "branch",
    "browser",
    "changes",
    "chat",
    "compact",
    "copy",
    "cwd",
    "export",
    "files",
    "find",
    "instructions",
    "login",
    "model",
    "name",
    "new",
    "peek",
    "pip",
    "plan",
    "remember",
    "reset",
    "resume",
    "schedule",
    "session",
    "settings",
    "stop",
    "theme",
    "thinking",
    "trust",
    "until",
    "watch",
]);

/** Only remove the command separator, never whitespace belonging to the plugin's arguments. */
export function extensionInput(
    text: string,
): { name: string; args: string; qualified: boolean } | undefined {
    const match = /^\/([^\s]+)(?:\s([\s\S]*))?$/.exec(text.trimStart());

    if (!match) {
        return undefined;
    }

    const qualified = match[1]!.startsWith("ext:");
    const name = qualified ? match[1]!.slice(4) : match[1]!;

    if (!qualified && name.includes("/")) {
        return undefined;
    }

    return name ? { name, args: match[2] ?? "", qualified } : undefined;
}
