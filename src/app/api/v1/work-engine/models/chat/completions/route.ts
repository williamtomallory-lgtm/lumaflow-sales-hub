import { handleWorkEngineCompletion } from "@/lib/ai/work-engine-gateway";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const POST = handleWorkEngineCompletion;
