import { parseDocumentBuffer } from "@/lib/document-parser";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) return Response.json({ error: "请选择一个文件" }, { status: 400 });
    if (file.size > 10 * 1024 * 1024) return Response.json({ error: "文件不能超过 10 MB" }, { status: 413 });
    const parsed = await parseDocumentBuffer(file.name, file.type, await file.arrayBuffer());
    return Response.json({ name: file.name, ...parsed });
  } catch (error) {
    const message = error instanceof Error ? error.message : "文档解析失败";
    return Response.json({ error: message }, { status: 422 });
  }
}
