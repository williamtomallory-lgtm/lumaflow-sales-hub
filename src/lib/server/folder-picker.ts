import "server-only";
import { spawn } from "node:child_process";
import path from "node:path";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { ApiHttpError } from "./api-security";

let selecting = false;
export async function selectWorkspaceFolder(initialPath: string, signal?: AbortSignal) {
  if (process.platform !== "win32") throw new ApiHttpError(422, "WINDOWS_FOLDER_PICKER", "请在运行本机服务的 Windows 电脑上选择文件夹。");
  if (selecting) throw new ApiHttpError(409, "FOLDER_PICKER_OPEN", "文件夹选择窗口已打开，请完成选择或取消。");
  selecting = true;
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(process.cwd(), "scripts", "select-workspace-folder.ps1"), "-InitialPath", initialPath], { windowsHide: true, signal });
      let stdout = "";
      child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.resume();
      const timer = setTimeout(() => { child.kill(); reject(new ApiHttpError(408, "FOLDER_PICKER_TIMEOUT", "选择文件夹已超时，请重新点击浏览。")); }, 300_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); if (code === 0) resolve(stdout); else reject(new ApiHttpError(503, "FOLDER_PICKER_FAILED", "无法打开系统文件夹窗口，可直接填写工作目录路径。")); });
    });
    const result = z.object({ path: z.string().nullable(), cancelled: z.boolean() }).parse(JSON.parse(output.trim()));
    if (result.path && !(await stat(result.path)).isDirectory()) throw new ApiHttpError(422, "FOLDER_NOT_FOUND", "所选文件夹不存在，请重新选择。");
    return result;
  } finally { selecting = false; }
}
