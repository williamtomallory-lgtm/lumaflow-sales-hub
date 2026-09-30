// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  status: vi.fn(), search: vi.fn(), assign: vi.fn(), demo: vi.fn(), profile: vi.fn(),
}));
vi.mock("@/lib/knowledge/agent-library", () => ({
  getAgentLibraryStatus: mocks.status, searchAgentLibrary: mocks.search,
  assignAgentLibrary: mocks.assign, importPersonalAgentDemo: mocks.demo,
}));
vi.mock("@/lib/server/cowagent-client", () => ({ getCowAgentProfile: mocks.profile }));
import { GET, POST } from "@/app/api/v1/knowledge/agent-library/route";

const endpoint = "http://127.0.0.1:3000/api/v1/knowledge/agent-library";
const token = "test-token-".padEnd(64, "a");
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("LUMAFLOW_KNOWLEDGE_TOKEN", token);
  vi.stubEnv("ASSISTANT_API_TOKEN", "");
  mocks.status.mockResolvedValue({ agentId: "wechat-service", documents: [{ id: "demo-pa-products", characters: 100 }] });
  mocks.search.mockResolvedValue({ agentId: "wechat-service", documents: [{ text: "private test body" }] });
  mocks.profile.mockResolvedValue({ id: "wechat-service", enabled: true });
  mocks.demo.mockResolvedValue({ agentId: "wechat-service", includeDemo: true });
  mocks.assign.mockResolvedValue({ agentId: "wechat-service", includeDemo: false });
});
afterEach(() => vi.unstubAllEnvs());

describe("private website-to-WeChat knowledge API", () => {
  it("exposes metadata, not extracted bodies, to the same-origin browser", async () => {
    const response = await GET(new Request(`${endpoint}?agentId=wechat-service`, { headers: { "sec-fetch-site": "same-origin" } }));
    expect(response.status).toBe(200);
    expect((await response.json()).meta.bodyIncluded).toBe(false);
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.status).toHaveBeenCalledWith("wechat-service");
  });
  it("only includes text for a valid private loopback bridge token", async () => {
    const response = await GET(new Request(`${endpoint}?agentId=wechat-service&q=PTEST-739&limit=2`, { headers: { authorization: `Bearer ${token}` } }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.meta.bodyIncluded).toBe(true);
    expect(body.data.documents[0].text).toBe("private test body");
    expect(mocks.search).toHaveBeenCalledWith({ agentId: "wechat-service", q: "PTEST-739", limit: 2, offset: 0 });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("rejects wrong tokens, direct unauthenticated reads and remote hosts", async () => {
    for (const request of [
      new Request(`${endpoint}?agentId=wechat-service`, { headers: { authorization: "Bearer wrong" } }),
      new Request(`${endpoint}?agentId=wechat-service`),
      new Request(`https://remote.invalid/api/v1/knowledge/agent-library?agentId=wechat-service`, { headers: { authorization: `Bearer ${token}` } }),
      new Request(`${endpoint}?agentId=wechat-service`, { headers: { origin: "https://evil.invalid" } }),
    ]) expect((await GET(request)).status).toBe(403);
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.status).not.toHaveBeenCalled();
  });
  it("rejects absent or short configured credentials and invalid query bounds", async () => {
    vi.stubEnv("LUMAFLOW_KNOWLEDGE_TOKEN", "short");
    expect((await GET(new Request(`${endpoint}?agentId=wechat-service`, { headers: { authorization: "Bearer short" } }))).status).toBe(403);
    expect((await GET(new Request(`${endpoint}?agentId=../secret&limit=99`, { headers: { "sec-fetch-site": "same-origin" } }))).status).toBe(422);
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it("requires same-origin explicit demo import and an enabled real Agent", async () => {
    const request = () => new Request(endpoint, { method: "POST", headers: { origin: "http://127.0.0.1:3000", "content-type": "application/json" }, body: JSON.stringify({ action: "import-demo", agentId: "wechat-service" }) });
    expect((await POST(request())).status).toBe(200);
    expect(mocks.demo).toHaveBeenCalledWith("wechat-service");
    mocks.demo.mockClear();
    mocks.profile.mockResolvedValue({ enabled: false });
    expect((await POST(request())).status).toBe(409);
    expect(mocks.demo).not.toHaveBeenCalled();
    expect((await POST(new Request(endpoint, { method: "POST", body: JSON.stringify({ action: "import-demo", agentId: "wechat-service" }) }))).status).toBe(403);
  });
  it("rejects unexpected fields and traversal document grants before mutation", async () => {
    const response = await POST(new Request(endpoint, { method: "POST", headers: { origin: "http://127.0.0.1:3000", "content-type": "application/json" },
      body: JSON.stringify({ action: "assign", agentId: "wechat-service", documentIds: ["../company-secret"], includeDemo: true, extra: "ignore" }) }));
    expect(response.status).toBe(422);
    expect(mocks.assign).not.toHaveBeenCalled();
  });
});
