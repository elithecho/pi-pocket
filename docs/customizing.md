# Changing how Pi works, without code

Most changes people ask for ("always use pnpm", "review the way we do it here", "never touch the migrations") need no code. Pi Pocket reads the same files Pi does, so what is written for Pi works here too, and the other way round. Pi's own documentation covers each in full; its path is in the system prompt.

## Instructions for one session

Menu → **Instructions for Pi**, or `/instructions use pnpm, not npm`. Pi gets them with every message in that session, after the rest of the system prompt. Everyone in the session sees them. They are stored with the session, so they last across restarts, and a fork starts with its parent's.

Use them for rules that belong to one piece of work. You cannot set them with a tool: tell the person what to put there.

## AGENTS.md: rules for a project, or for everything

Pi loads context files the way Pi does:

- `~/.pi/agent/AGENTS.md`: for every session, whatever its folder.
- `AGENTS.md` (or `CLAUDE.md`) in the session's folder and each folder above it.

See Pi's `configuration.md` for the full list of names, including `AGENTS.override.md`. Pi Pocket reads them again at most 30 seconds after they change; the next request has them.

Keep them short and true: they go with every request, and a rule Pi cannot follow is worse than none.

## Skills: procedures Pi follows on request

A skill is a folder with a `SKILL.md`: a name and a description at the top, the steps below. Its name and description go into the system prompt; Pi reads the rest when a task matches it, or when someone sends `/skill:name what to do`.

Put one in `~/.pi/agent/skills/<name>/` or `~/.agents/skills/<name>/` (for every session), or in a project's `.pi/skills/` or `.agents/skills/` (for sessions in it). A project's `.agents/skills/` counts in the session's folder and each folder above it, up to the repository's root. Pi's settings can add more folders. Where two skills share a name, the project's wins. See Pi's `skills.md`. Like `AGENTS.md`, skills are read again within 30 seconds.

A project's `.agents/skills/` load only in a project Pi trusts. When a session's project has some and nobody has decided, Pi Pocket asks its owner above the message box; `/trust` (or Menu → **Project trust**) shows the answer and changes it. The answer goes where Pi's CLI keeps its own (`~/.pi/agent/trust.json`), so each goes by what was decided in the other; in the CLI, trust also loads the project's `.pi` settings, extensions, and packages. `"defaultProjectTrust": "always"` (or `"never"`) in `~/.pi/agent/settings.json` answers for every project nobody decided about. The CLI asks before a project's `.pi/skills/` too; Pi Pocket loads those until you answer "Don't trust" (or `defaultProjectTrust` is `"never"`), and then leaves them out too. **Not now** (×) puts the question off in that tab.

## Prompt templates: saved messages with blanks

A Markdown file in `~/.pi/agent/prompts/` (or a project's `.pi/prompts/`, unless Pi was told not to trust the project) becomes a slash command named after it: `review.md` is `/review`. `$1`, `$2`, … take the words after the command, `$@` all of them. See Pi's `prompt-templates.md`.

Use a template for a message people send often; use a skill for steps Pi should know how to take.

## Models and providers

People sign in to providers from Menu → **Providers**, and pick a model per session from the model chip in the message box. Pi Pocket uses Pi's sign-ins (`~/.pi/agent/auth.json`) and Pi's model list: to add a model or a provider Pi does not know, follow Pi's `models.md` and `custom-provider.md`.

Models are the person's to choose, never Pi's: a subagent runs on its session's model unless the owner allows others under **Models for subagents** at the top of the Providers sheet (none by default), and PiP passes a model only when its person named it. Instructions, skills, or `AGENTS.md` cannot widen that; tell the person where the setting is instead.

## Project model defaults for new sessions

Menu → **Default model** sets the owner's app-wide model and thinking pair. This always wins. To use project defaults, open that menu and choose **Clear owner default: use project defaults, then last picked**.

In the session folder's `.pi/settings.json`, set both `defaultProvider` and `defaultModel`, and optionally `defaultThinkingLevel` (`off` when omitted). For example:

```json
{
    "defaultProvider": "anthropic",
    "defaultModel": "claude-sonnet-4-5",
    "defaultThinkingLevel": "high"
}
```

Use a provider/model ID known to Pi's model list. Pocket limits thinking to levels that model supports. A thinking-only project setting does not change an owner-default or last-picked pair.

Project defaults need trust. Any project with `.pi/settings.json` can ask, even if it has no model keys: the shared decision also controls what Pi's terminal app loads. A settings-only project asks the owner above the message box; **Review** or Menu → **Project trust** explains the choice. Until trusted, normal fallback applies. After trust, only later new sessions use project defaults; the open session will not change. No project setting can grant trust to itself. The decision is shared with Pi's terminal app; `defaultProjectTrust` is read only from global Pi settings.

Without an owner default, the order is a trusted project pin, the last picked model, Pi's global default, then no model. Pocket reads the actual final folder after creating a worktree, plus fresh global defaults and trust policy for each creation. A worktree uses the files present in that checkout (including copied non-ignored new files), not a separate read from its source folder. Bad JSON, an incomplete provider/model pair, an unknown model, or an invalid thinking value in consulted trusted settings stops session creation with an error, not a silent change to a different model. A known model without a sign-in stays selected and its next request shows the sign-in failure. If global Pi settings cannot be read or parsed, creation without an owner default also stops with a safe error: Pocket must not guess the trust policy.

Existing sessions do not change when files or folders change. Imports, forks, subagents, manual model choices, and PiP's own conversation keep their previous behavior. A model the person explicitly named to PiP overrides project settings; an ordinary session PiP starts without a named model uses the same trusted-project order as any new session, including when the owner globally trusts projects. **Extra skill and prompt paths from each session folder's settings, and per-project run policy (compaction, retries, stream timeouts, steering, and follow-up mode), are not supported yet.** Standard project skill and prompt folders still work as before.

## Other switches people have

These are in the app, not in files. Tell the person where they are rather than changing them some other way.

- **Plan mode** (the Plan chip): Pi plans and asks before it changes anything.
- **Done when** (`/until npm test`): Pi keeps working until a check passes.
- **Scheduled messages** (`/schedule in 2h check the deploy`): a message to Pi later, or on repeat. Pi has a `schedule` tool for its own.
- **Extensions** (Menu → Extensions, the owner): turn the browser, subagents, codemode, Lancet Guard, a drop-in, and the rest on and off for every session.
- **Lancet Guard and approvals** (Menu → Extensions): with the guard on, risky commands wait for a person to allow them; "Approvals need someone else" makes that someone other than who asked.

See [features.md](features.md) for each.

## When this is not enough

To give Pi a new tool, add a rule to its prompt that depends on the session's state, or check its tool calls, write an extension: [extensions.md](extensions.md). An extension can also add a page, a rail button, or a route to the app ([Adding to the app](extensions.md#adding-to-the-app)).
