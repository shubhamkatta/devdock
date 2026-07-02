import { z } from "zod";

// ---------- Enums ----------

export const PRReviewScmProviderSchema = z.enum(["bitbucket", "github"]);
export type PRReviewScmProvider = z.infer<typeof PRReviewScmProviderSchema>;

export const PRReviewVerdictSchema = z.enum([
  "approve",
  "decline",
  "request_changes",
  "needs_discussion",
]);
export type PRReviewVerdict = z.infer<typeof PRReviewVerdictSchema>;

export const PRReviewStatusSchema = z.enum([
  "queued",
  "running",
  "complete",
  "error",
  "cancelled",
]);
export type PRReviewStatus = z.infer<typeof PRReviewStatusSchema>;

export const PRReviewLlmProviderSchema = z.enum([
  "claude_code_cli",
  "gemini_cli",
  "codex_cli",
  "anthropic_api",
  "openai_api",
  "gemini_api",
]);
export type PRReviewLlmProvider = z.infer<typeof PRReviewLlmProviderSchema>;

export const PRReviewFileChangeKindSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
]);
export type PRReviewFileChangeKind = z.infer<typeof PRReviewFileChangeKindSchema>;

export const PRReviewCommentSideSchema = z.enum(["LEFT", "RIGHT"]);
export type PRReviewCommentSide = z.infer<typeof PRReviewCommentSideSchema>;

// ---------- Domain entities ----------

export const PRReviewSchema = z.object({
  id: z.number().int().positive(),
  scm_provider: PRReviewScmProviderSchema,
  workspace: z.string(),
  repo_slug: z.string(),
  pr_id: z.number().int().positive(),
  source_branch: z.string(),
  target_branch: z.string(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  verdict: PRReviewVerdictSchema.nullable(),
  status: PRReviewStatusSchema,
  llm_provider: PRReviewLlmProviderSchema.nullable(),
  started_at: z.number().int().nonnegative(),
  finished_at: z.number().int().nonnegative().nullable(),
  prompt_id: z.string().nullable(),
  body: z.string().nullable(),
  re_review_of: z.number().int().positive().nullable(),
});
export type PRReview = z.infer<typeof PRReviewSchema>;

export const PRReviewCommentSchema = z.object({
  id: z.number().int().positive(),
  review_id: z.number().int().positive(),
  file_path: z.string(),
  line_number: z.number().int().positive().nullable(),
  side: PRReviewCommentSideSchema,
  body: z.string(),
  posted_at: z.number().int().nonnegative().nullable(),
  external_id: z.string().nullable(),
});
export type PRReviewComment = z.infer<typeof PRReviewCommentSchema>;

export const PRReviewFileSchema = z.object({
  review_id: z.number().int().positive(),
  file_path: z.string(),
  change_kind: PRReviewFileChangeKindSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type PRReviewFile = z.infer<typeof PRReviewFileSchema>;

export const PRReviewJobSnapshotSchema = z.object({
  review_id: z.number().int().positive(),
  status: PRReviewStatusSchema,
  elapsed_s: z.number(),
  output: z.string(),
});
export type PRReviewJobSnapshot = z.infer<typeof PRReviewJobSnapshotSchema>;

// ---------- IPC args ----------

export const PRReviewStartArgsSchema = z.object({
  scm_provider: PRReviewScmProviderSchema,
  workspace: z.string().min(1),
  repo_slug: z.string().min(1),
  pr_id: z.number().int().positive(),
  re_review_of: z.number().int().positive().optional(),
});
export type PRReviewStartArgs = z.infer<typeof PRReviewStartArgsSchema>;

export const PRReviewGetArgsSchema = z.object({
  id: z.number().int().positive(),
});
export type PRReviewGetArgs = z.infer<typeof PRReviewGetArgsSchema>;

export const PRReviewListArgsSchema = z.object({
  scm_provider: PRReviewScmProviderSchema.optional(),
  workspace: z.string().optional(),
  repo_slug: z.string().optional(),
  pr_id: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type PRReviewListArgs = z.infer<typeof PRReviewListArgsSchema>;

export const PRReviewCommentAddArgsSchema = z.object({
  review_id: z.number().int().positive(),
  file_path: z.string().min(1),
  line_number: z.number().int().positive().optional(),
  side: PRReviewCommentSideSchema,
  body: z.string().min(1),
});
export type PRReviewCommentAddArgs = z.infer<typeof PRReviewCommentAddArgsSchema>;

export const PRReviewActionArgsSchema = z.object({
  review_id: z.number().int().positive(),
});
export type PRReviewActionArgs = z.infer<typeof PRReviewActionArgsSchema>;

export const PRReviewPostCommentArgsSchema = z.object({
  comment_id: z.number().int().positive(),
});
export type PRReviewPostCommentArgs = z.infer<typeof PRReviewPostCommentArgsSchema>;

export const PRReviewWithChildrenSchema = z.object({
  review: PRReviewSchema,
  files: z.array(PRReviewFileSchema),
  comments: z.array(PRReviewCommentSchema),
});
export type PRReviewWithChildren = z.infer<typeof PRReviewWithChildrenSchema>;
