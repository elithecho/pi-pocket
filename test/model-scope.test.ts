import { cleanUp, owner, root, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { PocketApp } from "../src/server/app.ts";

const app = await PocketApp.open({
    dataDir: join(root, "scope-data"),
    defaultCwd: work,
    supervised: false,
    log: () => {},
    configureModels: (models) => models.registerNativeProvider(scriptedModel().provider),
});

type Choices = Awaited<ReturnType<typeof app.modelList>>;
const scopedIds = (models: Choices) =>
    models.filter((model) => model.scoped).map((model) => model.id);

after(async () => {
    await app.close();
    cleanUp();
});

test("scope is optional picker metadata and uses Pi patterns without applying thinking", async () => {
    app.settings.setEnabledModels(["faux/*2:high", "faux/faux-2"]);
    const choices = (await app.hello(owner(app))).models;

    assert.deepEqual(scopedIds(choices), ["faux-2"]);
    assert.equal(choices.length, 3);
    assert.ok(choices.every((model) => !Object.hasOwn(model, "thinkingLevel")));
    assert.equal(app.config.defaultModel, undefined);
});
