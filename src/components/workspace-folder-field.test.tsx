import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceFolderField } from "./workspace-folder-field";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("uses the native picker result as the full workspace path and preserves a cancelled selection", async () => {
  const onChange = vi.fn(); const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ data: { path: "D:\\Agent files", cancelled: false } })).mockResolvedValueOnce(Response.json({ data: { path: null, cancelled: true } }));
  vi.stubGlobal("fetch", fetchMock);
  render(<WorkspaceFolderField value={"C:\\Old"} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "浏览" }));
  await waitFor(() => expect(onChange).toHaveBeenCalledWith("D:\\Agent files"));
  expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/local/folder-picker");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ initialPath: "C:\\Old" });
  fireEvent.click(await screen.findByRole("button", { name: "浏览" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(onChange).toHaveBeenCalledTimes(1);
});
