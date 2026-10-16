// Portable Pi extension UI only. Never execute an extension's terminal renderer in the browser.
import { useState } from "preact/hooks";
import { currentTemplates, loadTemplates } from "./commands.js";
import { actions, attempt, store } from "./store.js";
import { html } from "./ui.js";

function ExtensionDialog({ dialog }) {
    const [value, setValue] = useState(
        dialog.kind === "editor"
            ? (dialog.message ?? "")
            : dialog.kind === "select"
              ? (dialog.options?.[0] ?? "")
              : "",
    );
    const [busy, setBusy] = useState(false);

    const answer = async (value) => {
        setBusy(true);
        await attempt(() => actions.terminalAnswer(dialog.conversationId, dialog.id, value));
        setBusy(false);
    };

    const confirm = dialog.kind === "confirm";

    const submit = (event) => {
        event.preventDefault();
        void answer(confirm ? true : value);
    };

    const label = `terminal-dialog-${dialog.id}`;

    return html`<form class="terminal-dialog" aria-label=${dialog.title} onSubmit=${submit}>
        <strong id=${label}>${dialog.title}</strong>
        ${
            confirm &&
            dialog.message &&
            html`<div class="terminal-dialog-message">${dialog.message}</div>`
        }
        ${
            dialog.kind === "input" &&
            html`<input
                aria-labelledby=${label}
                value=${value}
                placeholder=${dialog.message ?? ""}
                disabled=${busy}
                onInput=${(event) => setValue(event.currentTarget.value)}
            />`
        }
        ${
            dialog.kind === "editor" &&
            html`<textarea
                aria-labelledby=${label}
                value=${value}
                disabled=${busy}
                rows="4"
                onInput=${(event) => setValue(event.currentTarget.value)}
            />`
        }
        ${
            dialog.kind === "select" &&
            html`<select
                aria-labelledby=${label}
                value=${value}
                disabled=${busy}
                onChange=${(event) => setValue(event.currentTarget.value)}
            >
                ${(dialog.options ?? []).map((option) => html`<option value=${option}>${option}</option>`)}
            </select>`
        }
        <div class="terminal-dialog-buttons">
            <button
                type="button"
                class="button small"
                disabled=${busy}
                onClick=${() => answer(null)}
            >
                Cancel
            </button>
            <button
                type="submit"
                class="button small"
                disabled=${busy || (dialog.kind === "select" && !dialog.options?.includes(value))}
            >
                ${busy ? "Sending…" : confirm ? "Confirm" : "Continue"}
            </button>
        </div>
    </form>`;
}

export function TerminalPanel({ placement = "aboveEditor", showCommands = false }) {
    const view = store.state.view.terminal;
    const cache = currentTemplates();
    const above = placement === "aboveEditor";
    const rows = [];

    if (above && showCommands && cache?.loading) {
        rows.push(html`<div class="goal-bar terminal-loading" role="status">
            Loading slash commands…
        </div>`);
    }

    if (above && showCommands && cache?.error) {
        rows.push(html`<div class="goal-bar terminal-problem" role="alert">
            <span class="grow">${cache.error}</span>
            <button class="link small" onClick=${() => loadTemplates(true)}>Retry</button>
        </div>`);
    }

    if (!view) {
        return rows;
    }

    if (above && view.problem) {
        rows.push(html`<div class="goal-bar terminal-problem" role="alert">
            <span class="grow">Pi extension: ${view.problem}</span>
        </div>`);
    }

    if (above) {
        rows.push(
            ...Object.entries(view.statuses ?? {}).map(
                ([key, text]) => html`<div
            key=${`status-${key}`}
            class="goal-bar terminal-status"
            role="status"
        >
            <span class="small muted">${key}</span><span class="grow">${text}</span>
        </div>`,
            ),
        );
    }

    rows.push(
        ...Object.entries(view.widgets ?? {})
            .filter(([, widget]) => widget.placement === placement)
            .map(
                ([key, widget]) => html`<div
            key=${`widget-${key}`}
            class="goal-bar terminal-widget"
            aria-label=${key}
        >
            <pre class="grow">${widget.lines.join("\n")}</pre>
        </div>`,
            ),
    );

    if (above) {
        rows.push(
            ...(view.dialogs ?? []).map(
                (dialog) => html`<${ExtensionDialog}
            key=${dialog.id}
            dialog=${dialog}
        />`,
            ),
        );
    }

    return rows;
}
