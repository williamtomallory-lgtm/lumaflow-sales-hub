// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { decodeStrataToolEnvelope, strataToolFetch } from "./strata-tool-transport";
const tools = [{ type: "function", function: { name: "localComputer", parameters: { properties: { action: { type: "string", enum: ["read_file", "write_file"] }, path: { type: "string" }, content: { type: "string" }, maxCharacters: { type: "integer" } } } } }];
const raw = '<tool_call>\n<localComputer>\n<parameter=action>\nwrite_file\n</parameter>\n<parameter=path>\nreport.md\n</parameter>\n<parameter=content>\n# Report\n合计250\n</parameter>\n</function>\n</tool_call>';
afterEach(() => vi.unstubAllGlobals());
describe("Strata alternate tool format compatibility", () => {
  it("decodes the actually observed alternate envelope without losing file text", () => {
    const call = decodeStrataToolEnvelope(raw, tools);
    expect(call.name).toBe("localComputer"); expect(JSON.parse(call.arguments)).toEqual({ action: "write_file", path: "report.md", content: "# Report\n合计250" });
  });
  it("rejects unoffered tools, arguments, forbidden actions and incomplete output", () => {
    expect(() => decodeStrataToolEnvelope(raw.replace('<localComputer>', '<shell>'), tools)).toThrow("unavailable tool");
    expect(() => decodeStrataToolEnvelope(raw.replace('parameter=path', 'parameter=apiKey'), tools)).toThrow("invalid tool argument");
    expect(() => decodeStrataToolEnvelope(raw.replace('write_file', 'command'), tools)).toThrow("invalid tool argument");
    expect(() => decodeStrataToolEnvelope(raw.replace('</tool_call>', ''), tools)).toThrow();
    expect(() => decodeStrataToolEnvelope('Example:\n'+raw, tools)).toThrow();
  });
  it("allows an offered tool with no arguments and leaves required-field validation to the SDK", () => {
    expect(decodeStrataToolEnvelope('<tool_call><localComputer></function></tool_call>', tools)).toEqual({ name: 'localComputer', arguments: '{}' });
  });
  it("rejects an interrupted protocol prefix rather than silently dropping it", async () => {
    const source = 'data: '+JSON.stringify({ choices: [{ delta: { content: '<tool_' }, finish_reason: null }] })+'\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(source, { headers: { 'content-type':'text/event-stream' } })));
    const response = await strataToolFetch('http://127.0.0.1/v1/chat/completions', { body: JSON.stringify({ tools }) });
    await expect(response.text()).rejects.toThrow('ended before dispatch');
  });
  it("turns split XML content into a real OpenAI tool frame instead of displaying a fake call", async () => {
    const wire = (content: string, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason }] })}\n\n`;
    const encoded = new TextEncoder(); const source = wire(raw.slice(0, 4))+wire(raw.slice(4))+wire('', 'stop')+'data: [DONE]\n\n';
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) { for (let i=0;i<source.length;i+=17) controller.enqueue(encoded.encode(source.slice(i,i+17))); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } })));
    const response = await strataToolFetch('http://127.0.0.1/v1/chat/completions', { method: 'POST', body: JSON.stringify({ tools }) });
    const text = await response.text();
    expect(text).not.toContain('<tool_call>'); expect(text).toContain('"finish_reason":"tool_calls"');
    const events = text.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));
    const call = events.flatMap(event => event.choices[0].delta.tool_calls || [])[0];
    expect(call.function.name).toBe('localComputer'); expect(JSON.parse(call.function.arguments).content).toBe('# Report\n合计250');
  });
  it("preserves ordinary streamed answers and native tool calls", async () => {
    const source = 'data: '+JSON.stringify({ choices: [{ delta: { content: '已读取文件' }, finish_reason: null }] })+'\n\ndata: '+JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })+'\n\ndata: [DONE]\n\n';
    vi.stubGlobal("fetch", vi.fn(async () => new Response(source, { headers: { 'content-type': 'text/event-stream' } })));
    expect(await (await strataToolFetch('http://127.0.0.1/v1/chat/completions', { body: JSON.stringify({ tools }) })).text()).toContain('已读取文件');
    const native = 'data: '+JSON.stringify({ choices: [{ delta: { tool_calls: [{ index:0, type:'function', function:{ name:'localComputer',arguments:'{}' } }] }, finish_reason:'tool_calls' }] })+'\n\ndata: [DONE]\n\n';
    vi.mocked(fetch).mockResolvedValueOnce(new Response(native, { headers: { 'content-type':'text/event-stream' } }));
    expect(await (await strataToolFetch('http://127.0.0.1/v1/chat/completions', { body: JSON.stringify({ tools }) })).text()).toBe(native);
  });
});
