import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { executeCowAgentComputer, getCowAgentProfile } from "../server/cowagent-client";
import { assertGrantedWorkAccess, assertLocalWorkAccess, workAccess, type WorkPermissions } from "./work-permissions";

const allComputerActions = ["command", "write_file", "edit_file", "read_file", "list_files", "delete_file"] as const;
const writableComputerActions = ["write_file", "edit_file", "read_file", "list_files"] as const;
const readableComputerActions = ["read_file", "list_files"] as const;

export function computerTools(agentId: string, permissions?: WorkPermissions) {
  const access = workAccess(permissions);
  const computerActions = access === "full" ? allComputerActions : access === "write" ? writableComputerActions : readableComputerActions;
  return {
    localComputer: tool({
      description: access === "full"
        ? "通过本机 CowAgent 执行授权的 PowerShell 命令、分页读取/保存/编辑/删除文件和列出目录。read_file 支持分页；修改已有代码优先用 edit_file。只执行用户本轮明确要求的工作，返回真实回执。"
        : access === "write"
          ? "通过本机 CowAgent 读取、创建和修改文件及列出目录；当前权限不可执行命令或删除文件。read_file 支持分页；修改已有代码优先用 edit_file。只执行用户本轮明确要求的工作，返回真实回执。"
          : "通过本机 CowAgent 只读文件及列出目录；当前权限不可写入、删除或执行命令。read_file 支持分页，只报告工具真实读到的内容。",
      inputSchema: z.object({
        action: z.enum(computerActions),
        command: z.string().max(64000).optional(), cwd: z.string().max(2000).optional(),
        path: z.string().max(2000).optional(), content: z.string().max(1000000).optional(),
        oldText: z.string().min(1).max(64000).optional(), newText: z.string().max(64000).optional(),
        replaceAll: z.boolean().optional(), offsetCharacters: z.number().int().min(0).optional(),
        maxCharacters: z.number().int().min(1).max(16000).optional(),
        timeoutSeconds: z.number().int().min(1).max(600).optional(),
      }),
      execute: async (operation) => {
        const needed = operation.action === "command" || operation.action === "delete_file" ? "full"
          : operation.action === "write_file" || operation.action === "edit_file" ? "write" : "read";
        if (needed === "read" && permissions) assertGrantedWorkAccess(permissions, needed, operation.action);
        else assertLocalWorkAccess(await getCowAgentProfile(agentId), needed, operation.action);
        return executeCowAgentComputer(agentId, operation);
      },
    }),
  };
}
