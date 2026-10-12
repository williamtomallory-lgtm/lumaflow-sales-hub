type WireTool = { type?: string; function?: { name?: string; parameters?: { properties?: Record<string, { type?: string; enum?: unknown[] }> } } };

/** Decode only a complete model tool envelope, and only functions offered in this request. */
export function decodeStrataToolEnvelope(text: string, tools: WireTool[]) {
  const envelope = /^\s*<tool_call>\s*([\s\S]*?)\s*<\/tool_call>\s*$/.exec(text);
  if (!envelope) throw new Error("Strata tool format could not be decoded");
  const body = envelope[1];
  const opening = /^<(?:function=([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))>/.exec(body);
  if (!opening) throw new Error("Strata tool format could not be decoded");
  const name = opening[1] || opening[2];
  const offered = tools.find((item) => item.type === "function" && item.function?.name === name)?.function;
  if (!offered?.parameters?.properties) throw new Error("Strata emitted an unavailable tool");
  const closing = new RegExp(`\\s*</(?:function|${name})>\\s*$`);
  if (!closing.test(body)) throw new Error("Strata tool output ended before dispatch");
  const parameters = body.slice(opening[0].length).replace(closing, "");
  const args: Record<string, unknown> = {};
  let position = 0;
  const pattern = /\s*<parameter=([A-Za-z_][A-Za-z0-9_]*)>([\s\S]*?)<\/parameter>/g;
  for (const match of parameters.matchAll(pattern)) {
    if (parameters.slice(position, match.index).trim()) throw new Error("Strata tool parameters could not be decoded");
    const key = match[1], property = offered.parameters.properties[key];
    if (!Object.hasOwn(offered.parameters.properties, key) || !property || Object.hasOwn(args, key) || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Strata emitted an invalid tool argument");
    const value = match[2].replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    if (property.type === "string") args[key] = value;
    else {
      try { args[key] = JSON.parse(value); } catch { throw new Error("Strata emitted an invalid tool argument"); }
    }
    if (property.enum && !property.enum.includes(args[key])) throw new Error("Strata emitted an invalid tool argument");
    position = match.index + match[0].length;
  }
  if (parameters.slice(position).trim()) throw new Error("Strata tool parameters could not be decoded");
  return { name, arguments: JSON.stringify(args) };
}

/** Adapt Strata's alternate XML envelope to the SDK's normal, schema-validated tool dispatch. */
export async function strataToolFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let tools: WireTool[] = [];
  try {
    const body = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.clone().text() : "";
    const request = JSON.parse(body);
    if (Array.isArray(request.tools)) tools = request.tools;
  } catch { /* Requests without tool definitions use the original transport. */ }
  const response = await fetch(input, init);
  if (!response.ok || !tools.length || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
  const reader = response.body.getReader(), decoder = new TextDecoder(), encoder = new TextEncoder();
  let buffer = "", candidate = "", mode: "probe" | "plain" | "tool" = "probe";
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (frame: string) => controller.enqueue(encoder.encode(frame + "\n\n"));
      const processFrame = (frame: string) => {
        if (!frame.startsWith("data: ") || frame === "data: [DONE]") { emit(frame); return; }
        const payload = JSON.parse(frame.slice(6));
        const choice = payload.choices?.[0];
        if (!choice?.delta) { emit(frame); return; }
        if (choice.delta.tool_calls?.length) {
          if (candidate.trim()) throw new Error("Strata emitted conflicting tool formats");
          candidate = "";
          mode = "plain";
        }
        if (typeof choice.delta.content === "string" && mode !== "plain") {
          candidate += choice.delta.content;
          if (candidate.length > 128_000) throw new Error("Strata tool output exceeded the allowed size");
          const prefix = candidate.trimStart();
          if (prefix.startsWith("<tool_call>")) mode = "tool";
          else if (prefix && !"<tool_call>".startsWith(prefix)) mode = "plain";
          if (mode === "plain") { choice.delta.content = candidate; candidate = ""; }
          else delete choice.delta.content;
        }
        if (choice.finish_reason && mode === "tool") {
          choice.delta.tool_calls = [{ index: 0, id: `call_${crypto.randomUUID().replaceAll("-", "")}`, type: "function", function: decodeStrataToolEnvelope(candidate, tools) }];
          choice.finish_reason = "tool_calls"; candidate = ""; mode = "plain";
        } else if (choice.finish_reason && candidate) { choice.delta.content = candidate; candidate = ""; }
        emit(`data: ${JSON.stringify(payload)}`);
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length); processFrame(frame);
          }
        }
        buffer += decoder.decode(); if (buffer.trim()) processFrame(buffer.trim());
        if ((mode === "tool" || mode === "probe") && candidate.trim()) throw new Error("Strata tool output ended before dispatch");
        controller.close();
      } catch (error) { await reader.cancel().catch(() => {}); controller.error(error); }
      finally { reader.releaseLock(); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  const headers = new Headers(response.headers); headers.delete("content-length");
  return new Response(stream, { status: response.status, statusText: response.statusText, headers });
}
