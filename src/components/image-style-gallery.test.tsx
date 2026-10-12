import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageStyleGallery } from "./image-style-gallery";

afterEach(cleanup);
const added = ["你的摇头娃娃", "增强照片", "夜拍闪光", "蓝图海报", "色彩分析", "漫画", "奇幻报纸", "胶片条", "超写实壁纸", "看手相"];

it("fills ready-to-edit prompts from each added reference style without sending a request", () => {
  const onSelect = vi.fn();
  render(<ImageStyleGallery onUpload={vi.fn()} onSelect={onSelect} />);
  for (const label of added) {
    fireEvent.click(screen.getByRole("button", { name: `使用${label}风格` }));
    expect(onSelect).toHaveBeenLastCalledWith(expect.stringMatching(/.{40}/));
  }
  expect(new Set(onSelect.mock.calls.map(([prompt]) => prompt)).size).toBe(added.length);
  expect(screen.getAllByRole("button")).toHaveLength(22);
});

it("keeps added task templates available and disables their actions while generating", () => {
  const onSelect = vi.fn();
  render(<ImageStyleGallery category="templates" disabled onUpload={vi.fn()} onSelect={onSelect} />);
  for (const label of ["增强照片", "蓝图海报", "色彩分析", "奇幻报纸", "胶片条", "看手相"]) {
    const button = screen.getByRole("button", { name: `使用${label}风格` });
    expect(button).toBeDisabled();
    fireEvent.click(button);
  }
  expect(onSelect).not.toHaveBeenCalled();
});
