export const visualModelTimeoutMs = 180000;
/** Whole HTML/CSS design generation; slower design models can need several minutes per answer. */
export const visualDesignTimeoutMs = 10 * 60 * 1000;
/** One visual edit: identification, design generation, repairs and the rendered review together. */
export const visualGenerationTimeoutMs = 20 * 60 * 1000;
export type VisualStage = "waiting" | "preparing" | "identifying" | "generating" | "reviewing" | "repairing" | "complete" | "failed";
export type VisualGenerationProgress = {
  shopId: string; visualId: string; requestId: string; stage: VisualStage;
  attempt: number; startedAt: number; updatedAt: number; error?: string;
  lastReview?: { approved: boolean; issues: string[] };
  instruction?: string;
  modelAttempt?: number;
};
