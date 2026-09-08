import { z } from "zod";
import type { KnowledgeCategory } from "../business";

/**
 * Limits for the local knowledge archive.  These are deliberately independent
 * of the parser's text limit: binary files are still stored safely even when
 * this application cannot understand their contents yet.
 */
export const KNOWLEDGE_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const KNOWLEDGE_MAX_TEXT_CHARS = 20_000;
export const KNOWLEDGE_CLASSIFICATION_MAX_CHARS = 4_000;
export const KNOWLEDGE_MAX_FILE_COUNT = 500;
export const KNOWLEDGE_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const KNOWLEDGE_MAX_NAME_CHARS = 240;

export const knowledgeCategorySchema = z.enum([
  "FAQ",
  "销售话术",
  "产品知识",
  "公司知识",
  "政策",
  "案例",
  "文档解析",
]);

export const knowledgeClassificationStatusSchema = z.enum([
  "pending",
  "classified",
  "archived",
]);

export const knowledgeClassificationSourceSchema = z.enum(["model", "manual", "none"]);
export const knowledgeParseStatusSchema = z.enum(["parsed", "archive_only", "parse_failed"]);
export const knowledgeStorageSourceSchema = z.enum(["uploaded", "demo"]);

export type KnowledgeClassificationStatus = z.infer<typeof knowledgeClassificationStatusSchema>;
export type KnowledgeClassificationSource = z.infer<typeof knowledgeClassificationSourceSchema>;
export type KnowledgeParseStatus = z.infer<typeof knowledgeParseStatusSchema>;
export type KnowledgeStorageSource = z.infer<typeof knowledgeStorageSourceSchema>;

/** A model-owned classification result.  The schema is also sent to the model. */
export const knowledgeClassificationSchema = z.object({
  category: knowledgeCategorySchema,
  title: z.string().trim().min(1).max(240),
  summary: z.string().trim().min(1).max(1_200),
  tags: z.array(z.string().trim().min(1).max(80)).max(12),
  confidence: z.number().finite().min(0).max(1),
}).strict();

export type KnowledgeClassification = z.infer<typeof knowledgeClassificationSchema>;

/**
 * Safe data sent to the browser.  It intentionally contains no local path,
 * storage key, or extracted full text.  Use getKnowledgeTextById on the server
 * when a trusted sales-agent tool needs the bounded text body.
 */
export type KnowledgeEntry = {
  id: string;
  originalName: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  sizeLabel: string;
  sha256Prefix: string;
  uploadedAt: string;
  updatedAt: string;
  classificationStatus: KnowledgeClassificationStatus;
  classificationSource: KnowledgeClassificationSource;
  category: KnowledgeCategory | null;
  title: string;
  summary: string;
  tags: string[];
  confidence: number | null;
  classificationError: string | null;
  parseStatus: KnowledgeParseStatus;
  parseError: string | null;
  characters: number;
  /** Number of leading extracted characters sent to the classifier. */
  classificationCharacters: number;
  pages: number | null;
  truncated: boolean;
  hasText: boolean;
  source: KnowledgeStorageSource;
  version: string;
  owner: string;
  downloadUrl: string;
  textPreview: string;
};

export const knowledgeEntrySchema: z.ZodType<KnowledgeEntry> = z.object({
  id: z.string().min(1),
  originalName: z.string().min(1).max(KNOWLEDGE_MAX_NAME_CHARS),
  mimeType: z.string().min(1).max(200),
  extension: z.string().max(40),
  sizeBytes: z.number().int().nonnegative().max(KNOWLEDGE_MAX_FILE_BYTES),
  sizeLabel: z.string().min(1).max(40),
  sha256Prefix: z.string().regex(/^[0-9a-f]{12}$/),
  uploadedAt: z.string(),
  updatedAt: z.string(),
  classificationStatus: knowledgeClassificationStatusSchema,
  classificationSource: knowledgeClassificationSourceSchema,
  category: knowledgeCategorySchema.nullable(),
  title: z.string().min(1).max(240),
  summary: z.string().max(1_200),
  tags: z.array(z.string().min(1).max(80)).max(12),
  confidence: z.number().finite().min(0).max(1).nullable(),
  classificationError: z.string().max(500).nullable(),
  parseStatus: knowledgeParseStatusSchema,
  parseError: z.string().max(500).nullable(),
  characters: z.number().int().nonnegative(),
  classificationCharacters: z.number().int().nonnegative().max(KNOWLEDGE_CLASSIFICATION_MAX_CHARS),
  pages: z.number().int().positive().nullable(),
  truncated: z.boolean(),
  hasText: z.boolean(),
  source: knowledgeStorageSourceSchema,
  version: z.string().min(1).max(40),
  owner: z.string().min(1).max(120),
  downloadUrl: z.string().min(1),
  textPreview: z.string().max(1_200),
}).strict();

/** Internal record shape persisted beside the UUID-named original file. */
export type StoredKnowledgeRecord = KnowledgeEntry & {
  /** Full digest is kept privately for exact de-duplication; never sent to UI. */
  sha256: string;
  storageFileName: string;
  extractedText: string | null;
};

export const knowledgeListQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  category: knowledgeCategorySchema.optional(),
  status: knowledgeClassificationStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export type KnowledgeListQuery = z.infer<typeof knowledgeListQuerySchema>;

export const knowledgeClassificationRequestSchema = z.object({
  modelProfileId: z.enum(["local-qwen3-8b", "local-qwen3-14b", "configured"]).optional(),
}).strict();

export const knowledgePatchSchema = z.object({
  category: knowledgeCategorySchema.optional(),
  title: z.string().trim().min(1).max(240).optional(),
  summary: z.string().trim().min(1).max(1_200).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  status: z.enum(["classified", "archived"]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");

export type KnowledgePatch = z.infer<typeof knowledgePatchSchema>;

export type KnowledgeListResponse = {
  data: KnowledgeEntry[];
  summary: {
    total: number;
    classified: number;
    pending: number;
    archived: number;
    byCategory: Array<{ category: KnowledgeCategory; count: number }>;
    storageBytes: number;
    storageLimitBytes: number;
    fileLimit: number;
  };
  meta: {
    apiVersion: "v1";
    requestId: string;
    source: "local-files";
    demoEntriesExcluded: true;
    limit: number;
    offset: number;
  };
};

export const knowledgeListResponseSchema: z.ZodType<KnowledgeListResponse> = z.object({
  data: z.array(knowledgeEntrySchema),
  summary: z.object({
    total: z.number().int().nonnegative(),
    classified: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative(),
    byCategory: z.array(z.object({ category: knowledgeCategorySchema, count: z.number().int().nonnegative() })),
    storageBytes: z.number().int().nonnegative(),
    storageLimitBytes: z.number().int().positive(),
    fileLimit: z.number().int().positive(),
  }),
  meta: z.object({
    apiVersion: z.literal("v1"),
    requestId: z.string().min(1),
    source: z.literal("local-files"),
    demoEntriesExcluded: z.literal(true),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  }),
});

export function formatKnowledgeSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
