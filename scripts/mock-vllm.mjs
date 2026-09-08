import { createServer } from "node:http";

const port = Number(process.env.MOCK_VLLM_PORT ?? 8010);

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function sse(response, chunks) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    json(response, 200, { object: "list", data: [{ id: "lumaflow-qwen", object: "model", owned_by: "mock-vllm" }] });
    return;
  }

  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    json(response, 404, { error: { message: "Not found" } });
    return;
  }

  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const toolResults = (body.messages ?? []).filter((message) => message.role === "tool").map((message) => JSON.parse(message.content));
  const searchResult = toolResults.find((result) => Array.isArray(result.products));
  const inventoryResult = toolResults.find((result) => result.inventory);
  const base = { id: `chatcmpl-mock-${Date.now()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1_000), model: body.model };

  // Fail the protocol test if the runtime did not actually load its application skill files.
  const instructions = body.messages?.filter((message) => message.role === "system").map((message) => message.content).join("\n") ?? "";
  if (!instructions.includes("Skill product-advisor@") || !instructions.includes("Skill reply-drafter@")) {
    json(response, 400, { error: { message: "Application skills are missing from the model request." } });
    return;
  }

  if (!searchResult) {
    sse(response, [
      {
        ...base,
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: "call-search-products-1",
              type: "function",
              function: { name: "searchProducts", arguments: JSON.stringify({ query: "18W 黑色轨道灯", category: "轨道灯", color: "黑", powerMin: 17, powerMax: 19, stockMin: 50, limit: 3 }) },
            }],
          },
          finish_reason: null,
        }],
      },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
    return;
  }

  const product = searchResult.products[0];
  if (product && !inventoryResult) {
    sse(response, [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-check-inventory-1", type: "function", function: { name: "checkInventory", arguments: JSON.stringify({ identifier: product.sku }) } }] }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
    return;
  }
  const reply = product
    ? `协议模拟：查询到 ${product.name}（SKU：${product.sku}），${product.power}，库存工具返回 ${inventoryResult.inventory.stock} 件。`
    : "协议模拟：当前条件没有匹配产品。";
  sse(response, [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: `来源：searchProducts / checkInventory（${searchResult.source}）。演示或回退数据不作为正式承诺依据。` }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mock vLLM listening on http://127.0.0.1:${port}/v1`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
