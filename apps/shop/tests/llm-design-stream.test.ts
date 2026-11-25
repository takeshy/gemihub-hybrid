import { test } from "node:test";
import assert from "node:assert/strict";
import type { GoogleGenAI } from "@google/genai";
import { generateJson, setProviderResolver, setVertexClient } from "../server/llm.ts";

test("design generation streams from Vertex AI so long designs are not cut off waiting for response headers", async t => {
  const saved = { project: process.env.GOOGLE_CLOUD_PROJECT, model: process.env.VERTEX_MODEL, design: process.env.GEMINI_DESIGN_MODEL };
  process.env.GOOGLE_CLOUD_PROJECT = "test-project"; process.env.VERTEX_MODEL = "text-model"; process.env.GEMINI_DESIGN_MODEL = "design-model";
  const calls: { kind: string; model: string }[] = [];
  setProviderResolver(async () => "vertex");
  setVertexClient({ models: {
    async generateContentStream(params: { model: string }) {
      calls.push({ kind: "stream", model: params.model });
      return (async function* () { yield { text: '{"css":".a{' }; yield { text: "color:red}" }; yield { text: '"}' }; })();
    },
    async generateContent(params: { model: string }) { calls.push({ kind: "single", model: params.model }); return { text: '{"ok":true}' }; },
  } } as unknown as Pick<GoogleGenAI, "models">);
  t.after(() => {
    setVertexClient(undefined);
    for (const [key, value] of [["GOOGLE_CLOUD_PROJECT", saved.project], ["VERTEX_MODEL", saved.model], ["GEMINI_DESIGN_MODEL", saved.design]] as const)
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  const schema = { type: "object" };
  assert.equal(await generateJson({ purpose: "design", system: "s", contents: [], schema }), '{"css":".a{color:red}"}');
  assert.equal(await generateJson({ system: "s", contents: [], schema }), '{"ok":true}');
  assert.deepEqual(calls, [{ kind: "stream", model: "design-model" }, { kind: "single", model: "text-model" }]);
});
