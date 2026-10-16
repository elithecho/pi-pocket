# Writing extensions

An extension gives Pi something new: a **tool** it can call, a **section** of its system prompt, a **hook** that checks or changes its tool calls and answers, or a durable **task**. It can also add to the app itself: **routes** on the server, and a **browser module** with rail buttons, pages, sheets, menu rows, and launcher actions ([Adding to the app](#adding-to-the-app)). Pi Pocket's own features are built this way (`src/server/extensions/`), and the owner can add their own without touching Pi Pocket's code.

Extensions are Pi Durable's. Its README covers the parts in depth: `node_modules/@earendil-works/pi-durable/README.md` in Pi Pocket's folder (Extensions, Tools, System Prompt, Hooks, Your Own State). This page is what Pi Pocket adds, and how to write one that holds up.

Configured **terminal Pi plugins** use a separate, off-by-default bridge, not this module contract.
See [Terminal extensions](terminal-extensions.md) for its trust warning, commands and compatibility
limits. The native Durable modules documented below keep working independently of that switch.

## Drop-in or built-in

- **Drop-in**: a file in `~/.pi-pocket/extensions/` (the data folder's `extensions/`). It survives updates to Pi Pocket, starts off, and the owner turns it on in Menu → Extensions. Use this for anything one person or one machine wants.

A drop-in runs inside the server, with the owner's rights: it can read `config.json` (the owner's token with it) and every session, and Lancet Guard never sees what its code does. Its browser module, if it has one, runs in the app's own page, with the rights of whoever's tab loads it. Show the owner the whole module, its browser files too, and say what it does, before you ask them to turn it on.

Drop-ins other people wrote come from the gallery, and the owner's own go to it ([below](#the-gallery)).

- **Built-in**: a file in `src/server/extensions/`. It is part of Pi Pocket for everyone who uses this copy. Use this only for a change to Pi Pocket itself, and read [self-editing.md](self-editing.md) first.

## A module

One `.ts` file that default-exports a function. Pi Pocket calls it with the host (below) and `web` (what it adds to the app, [below](#adding-to-the-app)), and installs what it returns: one extension, a list, or nothing, for a module that only adds to the app. It may be `async`: the module is loaded once it settles, and may register with `web` until then. It installs all it returns or none of it: when one extension is refused, the version before stays as it was. An extension without a name, or two of one name, are refused, and so is a module that returns nothing and adds nothing to the app (no route, browser module, or cleanup), as it most likely forgot to return its extensions.

```typescript
/**
 * A clock tool: the date and time now, in any time zone. The first sentence of this comment is the module's
 * description in the Extensions sheet.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

const clock = defineTool({
    name: "clock",
    description: "The date and time now, in a time zone such as Europe/Berlin.",
    parameters: Type.Object({ zone: Type.Optional(Type.String()) }),
    replay: "safe",
    execute: async (args) => ({
        content: [
            {
                type: "text" as const,
                text: new Date().toLocaleString("en-US", { timeZone: args.zone }),
            },
        ],
    }),
});

export default function createClock() {
    return defineExtension({ name: "example-clock", tools: [clock] });
}
```

Working examples, tested with every `npm test` (`test/docs-examples.test.ts`):

- [examples/clock.ts](examples/clock.ts): a tool.
- [examples/no-force-push.ts](examples/no-force-push.ts): a hook that blocks some bash calls, and a prompt section that says so.
- [examples/server-status.ts](examples/server-status.ts) with [examples/server-status.js](examples/server-status.js): a page on the rail, with a route that reads the machine's load and memory, and events that keep it live.

The file:

- is TypeScript that Node runs as it is: only erasable syntax (no `enum`, no `namespace`, no constructor parameter properties). Imports of local files end in `.ts`.
- imports `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, and the rest of Pi Pocket's packages by name. The drop-in folder has a `node_modules` link to Pi Pocket's own, so a drop-in gets the very modules the server runs.
- has a file name no built-in module has (a drop-in named `browser.ts` is not loaded). Files that start with `_` or end in `.test.ts` are not modules: use them for helpers and tests. A helper is not reloaded when it changes, even when the module that imports it is: a change to it takes a restart. Keep what you will change often in the module itself.
- starts with a `/** … */` comment whose first sentence says what it does.

### Names

Installing an extension with a name already installed replaces it, and a tool with the name of another replaces it in every session. So Pi Pocket refuses a drop-in that would take a name it keeps for itself, or one another module already has, and says so in Menu → Extensions:

- Extension names `coding-tools`, `pocket-core`, and anything starting with `pocket-` (`pocket-prompt`, `pocket-guard`, and the rest), whether that built-in is on or off.
- The built-in tools: `read`, `write`, `edit`, `bash`, `artifact`, `browser`, `subagent`, `agent_chat`, `schedule`, `codemode`, and `memory`, and PiP's: `sessions`, `session_read`, `session_start`, `session_send`, `session_follow`, `session_stop`, `session_archive`, `session_schedule`, `approvals`, `repo_watch`, and `session_watch_pr`, and the triggers' `watch_pr`.
- An extension or tool name another module installed: the first one in keeps it.

Give every extension and tool a name of your own, with a prefix (`example-clock`, `acme_lookup`). To change how a built-in tool works, wrap it (`wrapTool` in Pi Durable's README) or check its calls with a hook, rather than replacing it.

What a module adds to the app goes by its file's name: `server-status.ts` is `server-status`, at `/api/x/server-status/` and `/x/server-status/`. File names are unique across both folders, so these never collide; a module that adds to the app needs a name of up to 64 letters, digits, `-`, and `_`, starting with a letter or digit.

## Loading, reloading, and errors

- A drop-in shows in Menu → Extensions as soon as its file is there, off. Turning it on loads it; turning it off uninstalls what it installed, its routes and browser module too.
- Saving a module that is on reloads it about 300 ms later. A tool call already running finishes on the old code; the next one gets the new code. Saving a browser module's file has tabs load its new version ([below](#the-browser-module)).
- The latest choice and the latest version win. A module turned off, removed, or saved again while it still loads (it may wait at its top level, or in an `async` default export) installs nothing when that load ends, and a failure of that load is not reported. A file that is gone for a moment, as some editors save, is no removal: only one still gone 300 ms later is taken away.
- A load may take 30 s at most (the import, and an `async` default export): one that takes longer fails. At the server's start the modules share those 30 s, and each one after has 2 s, so modules that hang hold up the start by 30 s and 2 s for each module after, not 30 s each. A load that fails so is not stopped: what it started (a timer, a connection) runs on until the server restarts, though nothing it registers counts. Do slow work after it loads.
- A module that fails to load (a syntax error, a throw while building) is reported to the owner: in the Extensions sheet, and in a notice when it failed at the server's start or after an edit. Others see only that it failed, as the error can name the server's folders or quote a provider. An edit that fails keeps the previous version running, its routes and browser module included.
- A restart installs every module that is on again. Work an extension's tasks left pending resumes once it is installed.

You cannot turn a drop-in on yourself: ask the owner to, in Menu → Extensions.

## Tools

`defineTool({ name, description, parameters, execute, replay })`. `parameters` is a TypeBox schema (`Type` from `@earendil-works/pi-ai`); the arguments are checked against it before `execute(args, api, context)` runs.

- Return `{ content: [{ type: "text", text }] }`. Throw an `Error` to give the model an error result with its message.
- `replay: "safe"` only when running the call twice is harmless (reading, or an action keyed so a repeat finds the first one's result). The default is unsafe: a call cut off by a restart comes back to the model as interrupted instead of running again.
- `annotations: { readOnlyHint: true }`, as in Pi's tool definitions, says the tool does not change files or external state: plan mode lets it run. This is the extension author's hint, not a checked guarantee; conversation-only work, such as context management, can use it.
- `api.conversationId`, `api.taskId`, `api.callId` say which call this is. `${api.taskId}:${api.callId}` is a key that stays the same if the call runs again.
- `api.env` is the session folder's files and shell; `(await api.agent(context)).cwd` is the folder.
- `api.output(text)` streams running output, which becomes the result when `execute` returns no `content`.
- `api.memo(name, context)` reads, and `api.memo(name, value, context)` stores, a value kept with this call: a repeat after a restart finds it. Use it for anything that must not happen twice.
- `api.snapshot(Doc, api.conversationId, context)` reads a document, such as Pi Pocket's in `src/server/docs.ts`.

The tool's description and parameters go into every request: keep them short and exact.

## Prompt sections

`section(name, render, { tag })`: `render(input, context)` returns text, or `undefined` to leave the section out. By default it is wrapped in `<name>…</name>`; `{ tag: false }` leaves it bare.

Sections render before every request, and only those that changed are sent again. Return the same text while nothing changed: the date, not the time; no counters. `input.conversationId` and `input.read.snapshot(Doc, input.conversationId, context)` let a section depend on the session.

## Hooks

`hook(ToolTask, { beforeTool, afterTool })` and `hook(GenerationTask, { beforeRequest, afterResponse, onYield, afterTools })`.

- `beforeTool(call, api, context)` sees `call.name` and `call.arguments` before the call runs. Return `{ block: "why" }` to stop it (the model gets the reason as an error), or `undefined` to let it run. Codemode scripts' calls go through it too.
- `onYield(answer, api, context)` runs after Pi's final answer. Return `{ continue: "message" }` to send Pi on with another message, as Done when does (`extensions/goals.ts`).
- A hook can run again after a restart. Keep what must happen once in `api.memo`, as `extensions/guard.ts` does with an approval.

## The host

What the default export receives first. Extensions reach the app only through it (and add to it through `web`, [above](#adding-to-the-app)); it stays the same while modules reload.

| Member                           | What it is                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `dataDir`, `agentDir`            | Pi Pocket's data folder; Pi's (`~/.pi/agent`)                                                                                 |
| `notice(level, message, id?)`    | Report something to the server log and the app (`"info"`, `"warning"`, `"error"`); with a conversation's id, to its tabs only |
| `resolveModel(spec)`             | `provider/modelId` (or a bare id) to a signed-in model whose sign-in works, or an error that names no other models            |
| `subagentModels()`               | The models the owner allows subagents besides their session's own (`provider/modelId`); empty by default                      |
| `modelProblem(ref, fresh?)`      | Why a model may not be used now (not signed in, its sign-in expired), or `undefined`; `fresh` asks its provider again         |
| `requesterOf(conversationId)`    | The id of the person Pi works for in a session now                                                                            |
| `skillPaths()`                   | The extra skill folders in Pi's settings                                                                                      |
| `skills(cwd)`                    | Pi's skills for a session working in `cwd`, from every place Pi looks                                                         |
| `heldBack(conversationId)`       | Why work Pi would start there with nobody asking may not start now (a spend limit), or `undefined`                            |
| `onLimitsChanged(listener)`      | Call `listener` when the owner changes a spend limit; returns how to stop                                                     |
| `approvals`, `guard`             | Calls waiting for a person to allow them; Lancet Guard                                                                        |
| `schedules`, `goals`, `browsers` | Scheduled messages, Done when, and the built-in browser, as their extensions use them                                         |
| `linkedChats`                    | Normal linked chats: inherited model/thinking with optional startup overrides, list and send; check `modelSelection`          |
| `memory`                         | Lessons Pi keeps across sessions: their projects, the ones in force, saving and changing them                                 |
| `watches`                        | Sessions' PR watches: starting, stopping, and reading one, and the task that looks                                            |
| `repoWatches`                    | Repository watches' task, which the triggers extension installs                                                               |
| `gallery`                        | The extension gallery, which its extension's routes use ([below](#the-gallery))                                               |

Modules reload into the running server, but the server's own part (the host among it) changes only with a restart. A module that uses a member new to the host must work without it until then: check that it is there (`typeof host.heldBack === "function"`) and do as before when it is not. A module that called a missing member would fail at its first use, in every session.

To type it, import the type by the absolute path of `src/server/host.ts`: `import type { PocketHost } from "/path/to/pi-pocket/src/server/host.ts";`. A type import is gone when the module runs, so the path only matters to the type checker.

## Rules that are easy to break

- **Nothing twice.** A restart can run a hook or a safe tool again. Anything that must happen once (a message sent, money spent, a file appended to) goes behind `api.memo` or a key that makes a repeat find the first.
- **No surprise state.** Keep state in Pi Durable documents or memos, not in variables: a reload starts the module over, and a restart starts the process over.
- **Do not block.** Tools run in the server process: use async file and process calls, never `execSync` or a busy loop. A slow tool holds up only its call; a blocked event loop holds up everyone.
- **Do not get around a block.** A guard or a person said no for a reason.
- **Secrets stay out.** Text in a section, a tool's description, or a result goes to the model provider.

## Adding to the app

A module can add to the app what a tool cannot: a page that shows something without asking Pi, a button on the rail, a row in the menu. Its default export's second argument, `web`, registers two parts while the module loads:

- **Routes** on the server, under `/api/x/<module>/`: what the browser module calls. Credentials and other secrets stay here.
- A **browser module**: a `.js` file the app loads in the tabs of the people it is for. It adds rail buttons, pages, sheets, menu rows, and launcher actions through `pocket`, the app's API for extensions.

They install and go with the module's extensions: an edit swaps them in one step, a version that fails keeps the one before, and turning the module off removes them, closing a page of it that is open. [examples/server-status.ts](examples/server-status.ts) and [examples/server-status.js](examples/server-status.js) are a whole one.

```typescript
import type { ExtensionWeb } from "/path/to/pi-pocket/src/server/host.ts";

export default function createUsage(_host: unknown, web: ExtensionWeb) {
    web.route("GET", "usage", async ({ signal }) => fetchUsage(signal)); // GET /api/x/usage/usage
    web.client("usage.js"); // the browser module beside this file
}
```

### Routes

`web.route(method, path, handle, { access })`. `method` is GET, POST, PUT, PATCH, or DELETE. `path` is relative to the module's own: `"status"`, or `"items/:id"`, where `:id` matches one part of the address. Each part is letters, digits, and `. _ ~ -` (but not `.` or `..` alone), or `:name`. Where paths overlap, the most specific wins, whatever the order they were registered in: a fixed part before a `:name` part, from the left (`items/new` before `items/:id`).

`handle(request)` gets `{ method, params, query, body, user, signal }`: the `:name` parts, the query string (`URLSearchParams`, from `pocket.api("usage?days=7")`), the JSON object sent (empty for GET and DELETE), who asked (`{ id, name, role }`), and a signal aborted when the browser stops waiting. What it returns goes back as JSON (`undefined` as `{}`).

- Throw `web.error(status, message)` (a status from 400 to 599) to answer with it and its message, as they are, to whoever asked, guests and viewers too when the route is theirs: `throw web.error(404, "No such item")`. Put nothing in it you would not show them.
- Any other throw is a 500, even an error that carries a `status` of its own (as a provider's SDK's do, with words that can quote a key). The owner sees its message; anyone else sees only that the extension failed. The server log has it whole.
- The app's own checks come first: a sign-in, and the `X-Pocket` header, which a link or form on another site cannot send. A module's routes need it on GET too, so a GET can never be made from elsewhere; `pocket.api` always sends it, and so must anything else that calls them (`curl -H 'X-Pocket: 1'`). Without it, nothing is looked up.
- A route answers only the people its `access` lets in. To anyone else it is not there: the same 404 as a path the module lacks, and a 405 names only the methods they may use. So another route whose path matches may answer them instead (`items/:id` for `items/new`, with `id` `"new"`): give routes whose paths overlap the same `access`, or check `user.role` in the handler.
- A `:name` part is text from outside. The address is decoded before it is split, so the server answers 400 for a part that decodes to `..` (`..%2F`), or has a `\` or NUL in it (`.` and `..` written as they are never reach it: the address resolves them first). Still check a part before you make a file's path of it.
- A handler has no time limit: one that waits holds its request until it answers or the browser stops waiting, which aborts `signal`. Pass `signal` to what it waits for.

### The browser module

`web.client(entry, { access })`. `entry` is the name of a file or folder right beside the module (letters, digits, `.`, `_`, and `-`, starting with a letter, a digit, or `_`), not a link: a `.js` or `.mjs` file, served alone, or a folder, whose `index.js` loads first and may import the folder's other files. A folder serves its `.js`, `.mjs`, `.css`, `.json`, images, and fonts, never `.ts` files, hidden files, `node_modules`, or anything reached through a link (a link could lead to any of those, or out of the folder). A stylesheet or any other file needs a folder: a file alone serves only itself. A file is served up to 8 MB. When the file or folder goes, or becomes a link, the owner is told: tabs cannot load it until it is back. Everyone the browser module is for can read every file of those types in its folder: keep nothing secret there, and keep a module's own data (a cache, settings) elsewhere, such as beside the module or in its own folder under the data folder.

Saving a file the folder serves, in it or in a folder made in it later, gives the browser module a new address, and tabs load it again. Files of other types (`.log`, `.txt`) do not count, so writing one loads nothing again; a `.json` or an image does count. The version in the address is only for that: any version serves the files as they are now. The first 2000 files it serves, in up to 500 folders, count; an edit past those gives no new address, so open tabs keep the version they loaded until the page reloads. Its first 64 folders are watched; an edit deeper is seen at the next look, when something watched changes or the module loads again.

The app imports it and calls its default export with `pocket`. What that returns, if a function, runs when the module goes, as `pocket.onDispose` does.

```javascript
export const pocketApi = 1;

export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;

    function Usage() {
        const [usage, setUsage] = useState(null);
        const [error, setError] = useState(null);

        useEffect(() => {
            const stop = new AbortController();

            pocket.api("usage", undefined, { signal: stop.signal }).then(setUsage, (failure) => {
                if (!stop.signal.aborted) {
                    setError(failure.message);
                }
            });

            return () => stop.abort();
        }, []);

        if (error) {
            return html`<div class="error-box">${error}</div>`;
        }

        return usage ? html`<p>${usage.total} tokens today</p>` : html`<${pocket.Loader} />`;
    }

    pocket.page({ id: "usage", title: "Usage", component: Usage });
    pocket.rail({ id: "usage", title: "Usage", icon: "pulse", page: "usage" });
}
```

| `pocket`                                                              | What it is                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`, `module`, `title`                                          | The API's version (1); the module's name; its title                                                                                                                                                                                                                                                                |
| `html`, `h`, `Fragment`, `useState`, `useEffect`, and the hooks       | The app's own Preact and htm: a component of the module's renders as the app's do                                                                                                                                                                                                                                  |
| `Icon`, `Loader`, `Spinner`, `Markdown`, `Switch`                     | The app's pieces, so the module looks like the rest of the app. `Markdown` cleans the HTML it makes, as replies' does                                                                                                                                                                                              |
| `api(path, body?, { method, signal })`                                | Call one of the module's routes: a GET without `body`, a POST with one; a query string in `path` reaches `query`. `signal` stops it. Rejects with an error with the server's words (and its `status`), or at once for a path that would leave the module's routes: a `.` or `..` part, a leading `//`, or a scheme |
| `on(event, run)`                                                      | Hear an event the module sends; returns how to stop                                                                                                                                                                                                                                                                |
| `rail`, `menu`, `launcher`, `page`, `sheet`                           | Add a button on the rail, a row in the menu, a launcher action, a page, or a sheet (below). Each returns `{ update(patch), remove() }`                                                                                                                                                                             |
| `openPage(id)`, `closePage()`, `openSheet(id, props)`, `closeSheet()` | Show or close the module's own page or sheet; a sheet's component gets `props` (an object). Opening a page closes the sheet or launcher over it. A version that is gone or failed opens and closes nothing                                                                                                         |
| `notify(level, message)`                                              | A notice, as the app's own: `info`, `warning`, or `error`. At most 5 every 5 s for a module, its versions together (its failing actions and stylesheets count too); the rest are dropped. A version that is gone or failed sends none                                                                              |
| `me()`, `conversationId()`                                            | Who uses this tab (`{ id, name, role }`); the session it shows, or null                                                                                                                                                                                                                                            |
| `style(path)`                                                         | Load a stylesheet from the browser module's folder; it goes with this version. A path outside the folder throws; one that does not load says so in a notice. A browser module of one file has no folder for it                                                                                                     |
| `onDispose(run)`                                                      | Run `run` when this version goes: an edit, or the module turned off. Once it is gone or failed, at once                                                                                                                                                                                                            |

Each thing it adds has an `id` of its own (up to 64 letters, digits, and `. _ : -`, starting with a letter or digit), and adding one with the same `id` again replaces it. `update(patch)` takes an object. Adding the same again, or an update that changes nothing, draws nothing again; values count as the same only when they are the very same (a new array or function is a change), and many changes at once draw once. What a module changes draws at the next frame, once for all its changes since, so its changes cost the app at most one redraw a frame, at any refresh rate, as an animation does; a hidden tab, which draws no frames, draws them by a 100 ms timer, which the browser may slow there. Change what it added from an event, a timer, or an effect, not while a component draws, and give effects their dependencies: a module that changes what it added each time it draws, or each time an effect of its drawing runs, is not stopped, and redraws the app every frame until it is turned off. A module is stopped in that browser as one that failed ("was stopped in this browser: it redraws without end"), until the page reloads or the module is edited, when:

- one task makes more than 1000 calls to `pocket` (any of it but `h`, `html`, `Fragment`, the hooks, and the components) over more than a second: a loop of microtasks, which holds the page, and a long batch with heavy work between its calls alike. Its calls then throw until the next task, `pocket.api` too, so an `await` loop rejects and a `.then` chain stops;
- it opens and closes its pages or sheets more than 300 times in a second, or over and over with no task between (more than 1000 times, or 5 or more over more than a second).

A new function or array given each time counts as a change each time. A loop that never yields and calls nothing of `pocket` holds the tab, as does one that catches the error a stopped module's calls throw, and nothing outside it can stop either.

- `rail({ id, title, icon or iconPath, badge, … })`: a button on the rail after the app's own tools, in the sidebar, the drawer, and a phone's home screen. They take at most four buttons' height, and scroll past that. `icon` is one of the app's (`pulse`, `grid`, `globe`, `key`, `chat`, `folder`, `search`, …; an unknown name shows `grid`); `iconPath` is a 24×24 stroked SVG path of its own. `badge` is a short count or word on it: `0`, `NaN`, `-Infinity`, `""`, `"0"`, `null`, and `false` show none, as the app's own counts hide at 0; a count past 99 (and `Infinity`) shows "99+", other numbers (negative, or with decimals) show as they are, and text past 24 characters is cut to 23 and "…", in its label too, without cutting a character in two.
- `menu({ id, label, hint, … })` is a row in the menu's App group; `launcher({ id, label, detail, icon or iconPath, keywords, … })` an action in the launcher (Ctrl/⌘+K).
- Each of those three does one thing when used: `page: "id"` opens a page, `sheet: "id"` a sheet (the id of one the module adds), `run: () => …` runs a function. A rail button that opens a page shows it is open, and closes it on a second tap. Modules' buttons, rows, and actions show in the order the server lists the modules, and an edit keeps a module's place.
- `page({ id, title, component, escape, swipe })` shows in the conversation's place, as the subagents board does, with its title and a close button; Esc and back close it, and on a phone it fills the screen. On a touch screen up to 699 px wide a swipe to the right on it goes back (not in a field or a sideways scroller), and in an app added to an iPhone's or iPad's home screen so does a swipe in from the left edge. `escape: false` keeps Esc for the page (Esc still closes a sheet, the launcher, or PiP over it; the close button and back still close the page). `swipe: false` starts no back swipe anywhere on the page, the edge's included, and a `data-no-swipe` attribute on an element starts none on it or in it (a slider, a canvas you draw on). Esc never closes it while an input method composes a character.
- `sheet({ id, title, component, wide })` is a sheet like the app's. Their components get `pocket` and `close`, and a sheet's the `props` it was opened with. `close` closes only that page or sheet, of that version, while it shows: kept for later, it closes nothing else (`pocket.closePage()` closes whichever page of the module shows). A page or sheet whose module never added that id says the module no longer has it.

The pieces take what the app's own do: `Icon({ name or path, size })`, `Loader({ label })`, `Spinner({ label })`, `Markdown({ text })`, `Switch({ on, label, onChange, disabled })`. To look like the app, use its colors, `var(--text)`, `var(--muted)`, `var(--accent)`, `var(--bg)`, `var(--card)`, `var(--line)`, `var(--err)`, `var(--warn)`, and `var(--ok)`, which follow the theme, and these classes: `button` (with `primary`), `error-box`, `muted`, `small`, `mono`, and `setting` (a row with a label and a control). Pi Pocket keeps those names; the rest of its CSS may change.

Events are not kept for a page that was closed: one that opens fetches what is now, then listens, as the example does.

It fails alone. A module that throws while it loads or sets up says so in a notice and in Menu → Extensions ("In this browser: …"), and what it added goes; what it tries later (a timer it left) adds and opens nothing, and its `onDispose` runs at once. A page or sheet whose component, or a component in it, throws, whatever it throws (nothing at all shows "it gave no reason"; throw an `Error` all the same: nothing thrown from a class's constructor, a method that is a getter, or an effect's cleanup when it goes may escape that, and from a lifecycle method that is a class field, such as `componentWillMount = () => …`, as the component first draws, the box shows Preact's own words), shows "… failed:" and why in its place until it is closed or its component is replaced (added again, or `update({ component })`), and a `run` that throws or rejects says so in a notice. What an event handler in a component throws is caught by nothing but the browser's console: catch it there, and show what went wrong. The rest of the app goes on. An edit loads it again; a module that failed to import for another reason (the network) loads again when the page reloads. Turning a module off closes its page and sheet, and back does not bring its sheets back.

**Safe mode.** A browser module that hangs or breaks the tab would keep you from the Extensions sheet, where you turn it off. Open the app with `?noext=1` on its address (any of its pages: `https://…/?noext=1`; on a sign-in link, as where to go next: `/login?token=…&next=/?noext=1`) and that tab loads no browser modules: a notice says so, and the Extensions sheet, where each module this tab would load says "off in this tab", has a button to load them again. The tab keeps it through reloads (in its session storage, `pocket.noext`), other tabs do not, and `?noext=0` (or `false`, `off`, `no`) ends it. An app added to a home screen has no address bar: open the address in the browser instead. The server part of each module still runs: turn the bad one off there, then leave safe mode.

The page allows nothing from another site (the app's content security policy: scripts and requests only to the app itself). To show what another service knows, fetch it in a route, on the server, where its key stays.

### Who may use it

Routes and the browser module are the owner's alone unless their `access` says more:

| `access`            | Who                                                  |
| ------------------- | ---------------------------------------------------- |
| `"owner"` (default) | The owner                                            |
| `"steer"`           | The owner, and guests who can steer every session    |
| `"view"`            | The owner, guests, and viewers who see every session |

Someone invited to one session never may: these belong to the whole app. Each route checks its own `access`, so a browser module for everyone can have a route for the owner alone. `access` holds for every method: a POST route open to `"view"` lets viewers change something through it, though they may not steer a session. Give a route that changes things `"owner"` or `"steer"`. A browser module runs with the rights of whoever's tab loads it, so it can do nothing in a guest's tab that the guest could not.

### Events

`web.send(event, data, { to })` sends `data` (JSON, up to 256 KB) to the tabs of everyone the browser module's `access` lets in, or only to the tabs of the person whose id is `to`; there `pocket.on(event, run)` hears it. A tab whose browser module has not set up yet misses it. Send once the module has loaded (from a route, a timer, or a watcher), and only from a module with a browser module: events sent while it loads, or by one without, go nowhere. A version that was replaced or turned off sends nothing.

At most 100 events, and 1 MB of them, go out each second for a version of a module; the rest of that second's are dropped. Send what changed, or a summary, not every tick. A tab more than 8 MB behind that takes nothing for 30 s (it does not read its stream, or polls and acknowledges nothing), or any tab more than 128 MB behind, is cut off, and connects again with a fresh view: events are not kept for it. Under 128 MB, a tab that keeps taking is not cut off for being behind, so a slow phone gets everything. `web.send` never throws, as it is mostly called from timers, where a throw would stop the server: an event it cannot send goes to the server's log, once for each kind of mistake in a version.

### Cleanups

`web.onDispose(run)` runs `run` when this version of the module goes: an edit replaces it, the owner turns it off, or the server stops. Stop timers and close connections there: a reload starts the module over, and the old version's timers would otherwise run on. One registered after the module loaded (from a timer) runs too, and one registered after the version went runs at once. `run` may return a promise: when the server stops, it waits up to 3 s for those, the cleanups of versions still going (replaced or turned off a moment before) and of a version still loading included. `pocket.onDispose` does the same in the browser, but a browser cleanup is not waited for: do what must finish at once.

The new version starts before the old one's cleanups run, so that an edit that fails leaves the old one whole. Something only one of them can hold at a time (a port, a lock) cannot be taken while the module loads: take it at its first use, or try again a moment later.

### Versions

`web.api` and `pocket.version` are the version of this API, 1 now. It goes up only when something a module uses changes in a way that breaks it; additions keep it. A module that exports `pocketApi` (the server module, the browser module, or both) is not set up by a Pi Pocket with an older version of this API, which says so instead. The browser checks it after importing the module, so keep a browser module's top level to declarations, and do its work in the default export. A Pi Pocket from before this API knows neither `pocketApi` nor `web`: a module that adds to the app fails there at its first `web.route` or `web.client`, with the error in the Extensions sheet.

## Testing

Copy the module into a test app's data folder and turn it on, as `test/docs-examples.test.ts` does: `openApp` with a scripted model (`test/helpers.ts`), the file in `<dataDir>/extensions/`, `app.setExtensionEnabled(owner, file, true)`, then a session whose scripted model calls the tool. Nothing reaches a real provider, and nothing touches the live data.

For a drop-in, run the test from Pi Pocket's folder with the module copied in, or check it by hand: turn it on, ask Pi to use it in a session made for the purpose, and watch Menu → Extensions and the app's notices for errors.

For what a module adds to the app, `test/extension-web.test.ts` calls routes over HTTP as different people, and `test/extension-ui.test.ts` loads the app in a real Chromium and uses a module's rail button, page, menu row, and sheet. On a copy (`node test/serve.ts`), turn the module on, open the app, and keep the browser's console open.

## The gallery

Menu → Extensions → **Find extensions** (or **Find extensions** in the launcher) lists drop-ins other people wrote, from an index of reviewed entries: by default the repository [TannerMidd/pi-pocket-extensions](https://github.com/TannerMidd/pi-pocket-extensions), whose `index.json` lists them. The owner can read another index instead, at the bottom of that list: a GitHub repository as `owner/name`, or the https address of an `index.json`. It is the built-in Extension gallery (`gallery.ts`, the extension `pocket-gallery`), the owner's alone; turned off, it reads nothing.

Each entry names one drop-in's files at a pinned commit of a GitHub repository, with the size and SHA-256 of each, and what the module installs (below). Nothing in it is trusted, so Pi Pocket:

- reads it strictly (`src/server/gallery/entry.ts`): every field checked, one plain line of text each (no control, invisible, or direction characters), names in the drop-in folder's rules, sizes in bounds (4 MB of index, 50 files of 512 KB each and 2 MB together). An entry it cannot read is left out, and one for a newer Pi Pocket or extension API is hidden; the list says how many. It draws everything as text, and links only to the GitHub addresses it builds.
- downloads files only over https, from the entry's repository on `raw.githubusercontent.com` at the pinned commit. A file whose size or SHA-256 differs from the entry's installs nothing at all.
- installs it **off**, as every drop-in starts, even under a name that was on before. Only the owner turns it on.
- keeps where it came from beside it, in `<name>.gallery.json` in the drop-in folder: the entry as installed. Updates and removal go by it, so **Uninstall** removes its files and nothing else, and the gallery says which of them were edited since.
- puts a version in place all or none: what it replaces is kept aside until every file is in place, and when that fails, or the server stops in the middle, the version before comes back (at the next start, before extensions load).
- never updates by itself. When the index pins a newer commit, the gallery and the Extensions sheet say **update available**; the update shows what changes in what it declares and a diff of every file, and the owner applies it. One that is on stays on, and its new module loads at once; other code files it imports load at the next restart, which the gallery then asks for.
- warns about revoked versions. The index can revoke a commit of an extension; where that commit is installed, the gallery and the Extensions sheet say so with the reason, and offer to turn it off. Looking again twice a day while extensions from the index are installed, the gallery tells the owner in a notice when a revoked one is on. An entry whose own commit is revoked is withdrawn: it is not offered, and not installed.

Before turning one on, read it: the gallery shows every file, and what its entry declares. **Ask Pi to review** starts a session in the drop-in folder, in plan mode (it is not sent while Plan mode is off in Extensions), that asks Pi to audit the code: what it reads and writes (`config.json`, Pi's sign-ins, other secrets), its network calls, the processes it starts, what its browser module does, and whether it does what it declares. It is a session like any other: people who see every session see it too. The index's checks are no security review either: they check the entry and that the module loads; a maintainer reads the code before an entry goes in.

### What an entry declares

| Field                        | What                                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions`                 | The names of the extensions it installs                                                                                                         |
| `tools`, `readOnlyTools`     | Its tools, and those of them with `readOnlyHint` (plan mode lets them run)                                                                      |
| `hooks`                      | Its hooks' handlers: `beforeTool`, `onYield`, …                                                                                                 |
| `sections`                   | Its prompt sections                                                                                                                             |
| `wraps`                      | The tools and sections it wraps: `tool bash`, `section memory`                                                                                  |
| `routes`, `client`, `access` | Its routes (`GET status`), who loads its browser module (or `null`), and the widest access of the two (`owner` when it adds nothing to the app) |

These are what Menu → Extensions shows for a module that is on, and the index's checks load the module in a test app and compare.

### Sharing yours

An entry's files are its drop-in's own, named after its module, so they never meet another's:

- `<name>.ts`, the module. `<name>` is 2 to 64 lowercase letters, digits, `-`, and `_`, starting with a letter or digit, and is neither a built-in module's name nor starts with `pocket-`; its extensions and tools keep the [names rules](#names).
- `<name>.js` or `<name>.mjs` beside it, or the folder `<name>/`, for its browser module (`web.client("<name>.js")`, or `web.client("<name>")`). Helpers go in that folder too (`import { zones } from "./<name>/zones.ts"`): the folder serves no `.ts` files. Four folders deep at most, with no hidden files and no `node_modules`.
- It imports only those, Node's own modules, and the packages Pi Pocket has (`@earendil-works/pi-durable`, `@earendil-works/pi-ai`, …): nothing by its place on this machine, and no code from elsewhere. A type import (`import type … from "/path/to/pi-pocket/src/server/host.ts"`) is fine: it is gone when the module runs.
- Its `/** … */` comment's first paragraph is the entry's description.

To publish it:

1. Put its files in a public GitHub repository with the same names as in your extensions folder, at its top or in a folder of it, and commit them.
2. In Menu → Extensions, tap **Share…** on your drop-in. It checks that the drop-in stands on its own, and drafts its entry: the description from its comment, each file's size and SHA-256, and, while it is on, what it declares. Pi Pocket makes no GitHub calls for this.
3. Fill in what only you know: the repository (`owner/name`), the full ID of the commit with these files, the folder (if not the top), tags, and your GitHub name. **Open a pull request** opens once they would pass the index's checks: it opens GitHub's new-file page in the index repository with the entry filled in, as `entries/<name>.json`. The index's [CONTRIBUTING](https://github.com/TannerMidd/pi-pocket-extensions/blob/main/CONTRIBUTING.md) says the rest.
4. To update it, commit the new files, and send a pull request that changes `source.commit`, `version`, and the files' hashes (**Share…** again gives them). People who have it see the update, with its diff, and choose whether to apply it.

## A built-in extension

A new file in `src/server/extensions/` is loaded into the running server about 300 ms after it is first saved, on, for everyone: there is no way to try it there first. So write it as a drop-in, check it on a copy ([self-editing.md](self-editing.md#check-it-on-a-copy)), and move it in when it works.

Then, in `src/server/reload.ts`, give it its place in `ORDER` and its title in `TITLES` (and `OFF_BY_DEFAULT` if it should start off), and add its tools' names to `BUILT_IN_TOOLS`, so no drop-in takes them (`test/dropins.test.ts` fails until you do). Name the extension `pocket-…`. `reload.ts` is not an extension: these take effect at the next restart. `test/app.test.ts` asserts the order.
