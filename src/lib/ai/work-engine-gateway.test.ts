// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("../server/work-engine", () => ({ authorizeWorkEngineGateway: vi.fn(async () => ({})) }));
vi.mock("./model-config", () => ({ getModelOptions: vi.fn(async () => [{ id: "configured", configured: true, connectionKind: "live" }]), assertModelConfigured: vi.fn(() => ({ baseURL: "http://127.0.0.1:8081/v1", model: "bonsai", apiKey: "local", maxOutputTokens: 2048 })) }));
const { release } = vi.hoisted(() => ({ release: vi.fn() }));
vi.mock("./local-model-runtime", () => ({ leaseLocalModel: vi.fn(async () => release), releaseRuntimeWhenResponseEnds: vi.fn((response: Response) => response) }));
import { handleWorkEngineCompletion } from "./work-engine-gateway";
import { assertModelConfigured } from "./model-config";
import { authorizeWorkEngineGateway } from "../server/work-engine";
const request = (model = "configured") => new Request("http://127.0.0.1:3000/api/v1/work-engine/models/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: false }) });
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
describe("full engine model gateway", () => {
  it("rejects unregistered model ids and caller URLs before any model request", async () => {
    vi.stubGlobal("fetch", vi.fn());
    expect((await handleWorkEngineCompletion(request("https://evil.example/model"))).status).toBe(422);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps desktop work on local models even if a configured profile points to a cloud", async () => {
    vi.mocked(assertModelConfigured).mockReturnValueOnce({ baseURL: "https://remote.example/v1", model: "x", apiKey: "secret", maxOutputTokens: 1024 } as ReturnType<typeof assertModelConfigured>);
    vi.stubGlobal("fetch", vi.fn());
    expect((await handleWorkEngineCompletion(request())).status).toBe(403); expect(fetch).not.toHaveBeenCalled();
  });
  it("collects actual streamed tool calls for non-streaming engine clients and releases the model lease", async () => {
    const frames = [
      { id: "real-id", model: "bonsai", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: '{"pa' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"report.txt"}' } }] }, finish_reason: "tool_calls" }] },
    ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(frames, { headers: { "content-type": "text/event-stream" } })));
    const response = await handleWorkEngineCompletion(request()); const value = await response.json();
    expect(value.choices[0].message.tool_calls[0].function.arguments).toBe('{"path":"report.txt"}');
    expect(value.choices[0].finish_reason).toBe("tool_calls"); expect(release).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("http://127.0.0.1:8081/v1/chat/completions");
  });
  it("releases the model lease on an upstream failure without exposing model credentials", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("sensitive details", { status: 500 })));
    const response = await handleWorkEngineCompletion(request());
    expect(response.status).toBe(502); expect(release).toHaveBeenCalledOnce(); expect(await response.text()).not.toContain("sensitive details");
  });
  it("removes task and write tools from research requests and rejects an unsolicited mutation before dispatch", async () => {
    vi.mocked(authorizeWorkEngineGateway).mockResolvedValueOnce({ readOnly: true } as Awaited<ReturnType<typeof authorizeWorkEngineGateway>>);
    const frames = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "escape", function: { name: "task", arguments: '{"task":"write a file"}' } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(frames, { headers: { "content-type": "text/event-stream" } })));
    const tools = ["read_file", "task", "write_file"].map((name) => ({ type: "function", function: { name, parameters: { type: "object", properties: {} } } }));
    const input = new Request("http://localhost:3000/api/v1/work-engine/models/chat/completions", { method: "POST", body: JSON.stringify({ model: "configured", messages: [{ role: "user", content: "read" }], tools, stream: true }) });
    const response = await handleWorkEngineCompletion(input);
    expect(response.status).toBe(403); expect(release).toHaveBeenCalledOnce();
    const sent = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(sent.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(["read_file"]);
    expect(await response.text()).not.toContain('"tool_calls"');
  });
  it("allows an actually offered read call through the bounded research stream", async () => {
    vi.mocked(authorizeWorkEngineGateway).mockResolvedValueOnce({ readOnly: true } as Awaited<ReturnType<typeof authorizeWorkEngineGateway>>);
    const frames = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "read", type: "function", function: { name: "read_file", arguments: '{"file_path":"report.txt"}' } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(frames, { headers: { "content-type": "text/event-stream" } })));
    const input = new Request("http://localhost:3000/api/v1/work-engine/models/chat/completions", { method: "POST", body: JSON.stringify({ model: "configured", messages: [{ role: "user", content: "read" }], tools: [{ type: "function", function: { name: "read_file" } }], stream: true }) });
    const response = await handleWorkEngineCompletion(input);
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toContain('"name":"read_file"'); expect(release).toHaveBeenCalledOnce();
  });
});
