import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { executeCowAgentComputer } from "../server/cowagent-client";

export function computerTools(agentId: string) {
  return {
    localComputer: tool({
      description: "本地 Agent 受控电脑工具：在授权 Workspace 内读取、创建、编辑或删除文件，也可在获得工具权限后运行本机 PowerShell。read_file 默认4000字符，nextOffset非空可继续分页；编辑现有代码优先用 edit_file。执行本轮明确任务，返回真实结果和路径，不能虚构完成。",
      inputSchema: z.object({
        action: z.enum(["command", "write_file", "edit_file", "read_file", "list_files", "delete_file"]),
        command: z.string().max(64000).optional(), cwd: z.string().max(2000).optional(),
        path: z.string().max(2000).optional(), content: z.string().max(1000000).optional(),
        oldText: z.string().min(1).max(64000).optional(), newText: z.string().max(64000).optional(),
        replaceAll: z.boolean().optional(), offsetCharacters: z.number().int().min(0).optional(),
        maxCharacters: z.number().int().min(1).max(16000).optional(),
        timeoutSeconds: z.number().int().min(1).max(600).optional(),
      }),
      execute: async (operation) => executeCowAgentComputer(agentId, operation),
    }),
  };
}
