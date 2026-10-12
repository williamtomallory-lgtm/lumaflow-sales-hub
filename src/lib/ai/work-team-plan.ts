import type { CowAgentProfile } from "../contracts/cowagent-agent";
import type { CollaborationMode } from "../contracts/agent-progress";

export type WorkTeamPlan = { prepare: CowAgentProfile[]; review: CowAgentProfile[]; mode: CollaborationMode };

/** Code selects existing, enabled profiles. The client cannot invent team permissions. */
export function planWorkTeam(input: {
  text: string; lead?: CowAgentProfile; roster: CowAgentProfile[];
  teamMode: "auto" | "single" | "manual";
  manual: CowAgentProfile[]; collaborationMode?: CollaborationMode; planOnly?: boolean;
}): WorkTeamPlan {
  const empty: WorkTeamPlan = { prepare: [], review: [], mode: "sequential" };
  if (!input.lead || input.teamMode === "single") return empty;
  if (input.manual.length || input.teamMode === "manual") return {
    prepare: input.manual, review: [], mode: input.collaborationMode ?? "parallel",
  };
  // Short greetings and simple factual questions do not require a committee.
  const complex = /(?:调研|研究|比较|对比|分析|统计|报告|核验|检查|修复|优化|协作|分工|整理|制作|生成|创建|research|compare|analy[sz]e|report|verify|review|implement|create)/i.test(input.text)
    || /(?:先[\s\S]+(?:再|然后|最后)|first[\s\S]+then)/i.test(input.text);
  if (!complex) return empty;
  const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const workspace = normalizePath(input.lead.workspace);
  const select = (id: string | undefined) => input.roster.find((agent) => agent.id === id && agent.id !== input.lead?.id
    && agent.enabled && agent.type === "local" && agent.permissions?.read === true
    && !agent.permissions.create && !agent.permissions.modify && !agent.permissions.delete && !agent.permissions.tools
    && [agent.workspace, ...(agent.allowedPaths ?? [])].some((allowed) => workspace === normalizePath(allowed) || workspace.startsWith(`${normalizePath(allowed)}/`)));
  const researcher = select(process.env.LUMAFLOW_WORK_RESEARCH_AGENT_ID);
  const reviewer = select(process.env.LUMAFLOW_WORK_REVIEW_AGENT_ID);
  return { prepare: researcher ? [researcher] : [], review: reviewer && !input.planOnly && reviewer.id !== researcher?.id ? [reviewer] : [], mode: "sequential" };
}

/** Ask for essential route parameters before wasting a search on an undefined trip. */
export function flightClarification(text: string): { text: string; missing: string[] } | undefined {
  if (!/(?:机票|航班|flight|airfare)/i.test(text) || !/(?:找|查|订|买|最快|最早|最便宜|find|search|book|fastest|earliest|cheapest)/i.test(text)) return;
  const missing: string[] = [];
  const hasOrigin = /(?:从|出发(?:城市|机场)?[：:]?|departure(?: city)?[：:]?|from\s+)[^，。？?\n]{2,50}/i.test(text)
    || /[\u4e00-\u9fff]{2,8}(?:到|飞往|飞)[\u4e00-\u9fff]{2,8}/.test(text.replace(/(?:今天|明天|后天|去帮我|帮我|去|找找|最快的)/g, ""));
  if (!hasOrigin) missing.push("出发城市或机场");
  if (!/(?:今天|明天|后天|\d{1,2}月\d{1,2}[日号]|\d{4}[-/]\d{1,2}[-/]\d{1,2}|today|tomorrow)/i.test(text)) missing.push("出发日期");
  if (/(?:最快|fastest)/i.test(text) && !/(?:最早(?:起飞|抵达|到达)|最短(?:飞行|总行程)|飞行时间|earliest arrival|shortest)/i.test(text)) missing.push("‘最快’是最早起飞、最短行程还是最早抵达");
  if (!missing.length) return;
  return { missing, text: `我可以帮你比较航班。请先补充：${missing.join("；")}。相对日期按出发地当地时间核对；查到具体航班后，我会分别标明时刻、来源，以及票价和余票是否实时确认。` };
}
