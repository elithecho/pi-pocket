// Appearance: themes, and how the app looks and moves.
import { useEffect } from "preact/hooks";
import { closeSheet, openSheet, store } from "../store.js";
import {
    chooseTheme,
    paletteOf,
    prefs,
    preview,
    setPrefs,
    themeIds,
    THEMES,
    themeVars,
    varsStyle,
} from "../theme.js";
import { html, Icon, Sheet, Switch } from "../ui.js";

// Key hints are for people with a keyboard: a touch screen has none.
const touch = matchMedia("(pointer: coarse)").matches;

/** A theme as a card: a tiny Hyprland desktop drawn in its own colors. */
function ThemeCard({ id, desktop = false }) {
    const palette = paletteOf(id);
    const vars = varsStyle(themeVars(palette));
    // "Desktop" on a server without an Omarchy desktop shows Tokyo Night.
    const on =
        prefs().theme === id ||
        (id === "tokyo-night" && prefs().theme === "desktop" && !store.state.desktopTheme);
    const dots = ["--o-red", "--o-yellow", "--o-green", "--o-cyan", "--o-blue", "--o-magenta"];
    const desk = html`<div class="tc-desk">
        <div class="tc-win"><i></i><i></i><i class="lit"></i></div>
        <div class="tc-win"><i></i><i></i><i class="lit"></i></div>
    </div>`;
    const name = html`<div class="tc-name">
        ${desktop ? `Desktop · ${palette.name}` : THEMES[id].name}
        ${palette.colors.mode === "light" && html`<small>light</small>`}
    </div>`;

    return html`<button
        class=${`theme-card ${on ? "on" : ""} ${desktop ? "theme-desktop" : ""}`}
        aria-pressed=${on}
        style=${vars}
        title=${desktop ? "Follow the Omarchy theme of the machine Pi Pocket runs on" : THEMES[id].name}
        onMouseEnter=${() => matchMedia("(hover: hover)").matches && preview(id)}
        onMouseLeave=${() => preview(null)}
        onFocus=${() => preview(id)}
        onBlur=${() => preview(null)}
        onClick=${(event) => chooseTheme(id, event)}
    >
        ${desk}
        ${
            desktop
                ? html`<div class="tc-text">
                    ${name}
                    <div class="tc-note">
                        Follows your desktop: change the Omarchy theme and Pi Pocket changes with it.
                    </div>
                    <div class="tc-dots">
                        ${dots.map((dot) => html`<i style=${`background:var(${dot})`}></i>`)}
                    </div>
                </div>`
                : html`${name}
                <div class="tc-dots">
                    ${dots.map((dot) => html`<i style=${`background:var(${dot})`}></i>`)}
                </div>`
        }
    </button>`;
}

/** A new density, with the choice tapped kept where it was: the rows above it grow or shrink with the change. */
function chooseDensity(density, event) {
    const button = event.currentTarget;
    const before = button.getBoundingClientRect().top;

    setPrefs({ density });
    requestAnimationFrame(() => {
        const body = button.closest(".sheet-body");

        if (body) {
            body.scrollTop += button.getBoundingClientRect().top - before;
        }
    });
}

function SettingRow({ title, detail, children }) {
    return html`<div class="setting-row">
        <div class="setting-text">
            <span>${title}</span>
            ${detail && html`<span>${detail}</span>`}
        </div>
        ${children}
    </div>`;
}

export function AppearanceSheet() {
    const p = prefs();
    const desktop = store.state.desktopTheme;

    useEffect(() => () => preview(null), []);

    return html`<${Sheet} title="Appearance" onClose=${closeSheet} wide=${true}>
        <div class="label">Theme</div>
        <div class="theme-grid">
            ${desktop && html`<${ThemeCard} id="desktop" desktop=${true} />`}
            ${themeIds().map((id) => html`<${ThemeCard} key=${id} id=${id} />`)}
        </div>
        ${
            !desktop &&
            html`<p class="muted small">
                Running Pi Pocket on an Omarchy desktop adds “Desktop”: the app follows the theme the desktop uses.
            </p>`
        }
        <div class="label">Layout and motion</div>
        <div class="sheet-list">
            <${SettingRow}
                title="Tiled windows"
                detail="Wide screens: the sidebar and the session as Hyprland windows, with gaps and the active border"
            >
                <${Switch}
                    on=${p.tiling}
                    label="Tiled windows"
                    onChange=${() => setPrefs({ tiling: !p.tiling })}
                />
            <//>
            <${SettingRow}
                title="Peek tiles"
                detail=${`Other sessions beside this one, live while on screen: working, waiting for you, done since you looked, and pinned. Also the tiles button in the top bar${touch ? "" : ", or Alt+P"}`}
            >
                <${Switch}
                    on=${p.peeks}
                    label="Peek tiles"
                    onChange=${() => setPrefs({ peeks: !p.peeks })}
                />
            <//>
            ${
                desktop?.wallpaper &&
                html`<${SettingRow}
                    title="Desktop wallpaper"
                    detail="Your wallpaper in the gaps between windows, while following the desktop"
                >
                    <${Switch}
                        on=${p.wallpaper}
                        disabled=${!p.tiling || p.theme !== "desktop"}
                        label="Desktop wallpaper"
                        onChange=${() => setPrefs({ wallpaper: !p.wallpaper })}
                    />
                <//>`
            }
            <${SettingRow}
                title="Sidebar"
                detail="Folded, it shows numbered sessions like workspaces"
            >
                <div class="segmented">
                    ${[
                        ["open", "Open"],
                        ["rail", "Folded"],
                    ].map(
                        ([value, label]) =>
                            html`<button
                                class=${p.sidebar === value ? "on" : ""}
                                aria-pressed=${p.sidebar === value}
                                onClick=${() => setPrefs({ sidebar: value })}
                            >
                                ${label}
                            </button>`,
                    )}
                </div>
            <//>
            <${SettingRow}
                title="Motion"
                detail="Auto follows your system's reduced-motion setting"
            >
                <div class="segmented">
                    ${[
                        ["auto", "Auto"],
                        ["full", "Full"],
                        ["reduced", "Reduced"],
                    ].map(
                        ([value, label]) =>
                            html`<button
                                class=${p.motion === value ? "on" : ""}
                                aria-pressed=${p.motion === value}
                                onClick=${() => setPrefs({ motion: value })}
                            >
                                ${label}
                            </button>`,
                    )}
                </div>
            <//>
            <${SettingRow} title="Text size">
                <div class="segmented">
                    ${[13, 14, 15, 16, 17].map(
                        (size) => html`<button
                            class=${p.text === size ? "on" : ""}
                            aria-pressed=${p.text === size}
                            onClick=${() => setPrefs({ text: size })}
                        >
                            ${size}
                        </button>`,
                    )}
                </div>
            <//>
            <${SettingRow}
                title="Density"
                detail="Less room around messages, rows, and the message box, to fit more on a screen"
            >
                <div class="segmented">
                    ${[
                        ["comfortable", "Comfortable"],
                        ["compact", "Compact"],
                        ["tight", "Tight"],
                    ].map(
                        ([value, label]) =>
                            html`<button
                                class=${p.density === value ? "on" : ""}
                                aria-pressed=${p.density === value}
                                onClick=${(event) => chooseDensity(value, event)}
                            >
                                ${label}
                            </button>`,
                    )}
                </div>
            <//>
        </div>
        <div class="label">Conversation</div>
        <div class="sheet-list">
            <${SettingRow}
                title="Show thinking"
                detail=${`Adds a chevron before the live spinner. Tap it to read the current thought above the line as it comes${touch ? "" : ". Also Alt+T"}`}
            >
                <${Switch}
                    on=${p.showThinking}
                    label="Show thinking"
                    onChange=${() => setPrefs({ showThinking: !p.showThinking })}
                />
            <//>
        </div>
        <div class="label">Status line</div>
        <div class="sheet-list">
            <${SettingRow}
                title="Reply speed"
                detail="Under the message box: how fast the last answer came, in tokens a second, and how long its first token took"
            >
                <${Switch}
                    on=${p.speed}
                    label="Reply speed"
                    onChange=${() => setPrefs({ speed: !p.speed })}
                />
            <//>
        </div>
        ${
            !touch &&
            html`<button
                class="button ghost wide sheet-footer"
                onClick=${() => openSheet({ type: "shortcuts" })}
            >
                <${Icon} name="keyboard" size=${16} /> Keyboard shortcuts
            </button>`
        }
    <//>`;
}
