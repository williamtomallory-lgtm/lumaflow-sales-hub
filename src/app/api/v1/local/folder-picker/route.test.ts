// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
const picker = vi.hoisted(() => vi.fn(async () => ({ path: "D:\\Work", cancelled: false })));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/folder-picker", () => ({ selectWorkspaceFolder: picker }));
import { POST } from "./route";
afterEach(() => { picker.mockClear(); vi.unstubAllEnvs(); });
function request(host: string, origin: string, body = { initialPath: "C:\\Existing" }) { return new Request(`${host}/api/v1/local/folder-picker`, { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
it("opens the picker only for a same-origin local request", async () => {
  expect((await POST(request("http://127.0.0.1:3000", "https://untrusted.invalid"))).status).toBe(403);
  expect((await POST(request("https://lumaflow.example", "https://lumaflow.example"))).status).toBe(403);
  expect(picker).not.toHaveBeenCalled();
  const result = await POST(request("http://127.0.0.1:3000", "http://127.0.0.1:3000"));
  expect(result.status).toBe(200); expect(await result.json()).toMatchObject({ data: { path: "D:\\Work" } });
  expect(picker).toHaveBeenCalledWith("C:\\Existing", expect.any(AbortSignal));
});
