// Adapt the unchanged agent runtime's messages to Firebase AI Logic.
// The original tool executor still validates and executes every returned call.
export function firebaseSchema(schema = {}) {
  const result = {};
  const type = Array.isArray(schema.type) ? schema.type.find(type => type !== "null") : schema.type;
  result.type = ["object", "array", "string", "number", "integer", "boolean"].includes(type) ? type : "string";
  if (typeof schema.description === "string") result.description = schema.description;
  if (Array.isArray(schema.enum) && schema.enum.every(value => typeof value === "string")) result.enum = schema.enum;
  if (result.type === "object") {
    result.properties = Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key, firebaseSchema(value)]));
    if (Array.isArray(schema.required)) result.required = schema.required.filter(key => Object.hasOwn(result.properties, key));
  }
  if (result.type === "array") result.items = firebaseSchema(schema.items || {});
  return result;
}

const textPart = text => ({ type: "text", text });
export function cloudRequest(messages, tools = [], signatures = new Map()) {
  if (!Array.isArray(messages) || !messages.length) throw new Error("A conversation is required.");
  const systemInstruction = messages.filter(message => message.role === "system").map(message => message.content || "").join("\n\n");
  const calls = new Map();
  const contents = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const call = calls.get(message.tool_call_id);
      if (!call || call.name !== message.name && message.name) throw new Error("Unmatched tool response.");
      let response; try { response = JSON.parse(message.content); } catch { response = { text: message.content }; }
      const part = { type: "functionResponse", functionResponse: { name: call.name,
        ...(call.providerId ? { id: call.providerId } : {}), response: { result: response } } };
      const last = contents.at(-1);
      if (last?.role === "user" && last.parts.every(item => item.functionResponse)) last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
      continue;
    }
    if (!["user", "assistant"].includes(message.role) || message.content && typeof message.content !== "string")
      throw new Error("Unsupported conversation content.");
    const toolCalls = message.tool_calls || [];
    const remembered = toolCalls.length && signatures.get(toolCalls[0].id);
    if (remembered && remembered.signature !== JSON.stringify(toolCalls)) throw new Error("Tool call changed after generation.");
    for (const call of toolCalls) {
      if (calls.has(call.id)) throw new Error("Duplicate tool call.");
      calls.set(call.id, { name: call.function.name, providerId: remembered?.providerIds?.[call.id] });
    }
    const parts = remembered ? remembered.parts : [
      ...(message.content ? [textPart(message.content)] : []),
      ...toolCalls.map(call => ({ type: "functionCall", functionCall: { name: call.function.name, args: JSON.parse(call.function.arguments || "{}") } })),
    ];
    if (parts.length) contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
  }
  const declarations = tools.map(tool => ({ name: tool.function.name,
    description: tool.function.description || tool.function.name,
    ...(Object.keys(tool.function.parameters?.properties || {}).length ? { parameters: firebaseSchema(tool.function.parameters) } : {}),
  }));
  return { systemInstruction, request: { contents,
    ...(declarations.length ? { tools: [{ functionDeclarations: declarations }] } : {}),
  } };
}

export function runtimeResponse(response, signatures = new Map(), newId = () => crypto.randomUUID()) {
  const parts = response.candidates?.[0]?.content?.parts || [];
  const functionParts = parts.filter(part => part.functionCall);
  const toolCalls = functionParts.map(part => ({ id: part.functionCall.id || `firebase-${newId()}`, type: "function",
    function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) } }));
  if (toolCalls.length) {
    const record = { signature: JSON.stringify(toolCalls), parts,
      providerIds: Object.fromEntries(toolCalls.map((call, index) => [call.id, functionParts[index].functionCall.id])) };
    for (const call of toolCalls) signatures.set(call.id, record);
    while (signatures.size > 256) signatures.delete(signatures.keys().next().value);
  }
  return { content: parts.filter(part => typeof part.text === "string" && !part.thought).map(part => part.text).join(""),
    toolCalls, finishReason: toolCalls.length ? "tool_calls" : "stop", usage: response.usageMetadata || null };
}
