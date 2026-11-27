import type { Theme } from "./presentation";

/** Public publication waits while the shop's own AI design is being made or awaits the owner's decision. */
export type ThemeProposalStatus = "none" | "generating" | "ready" | "failed";
export type ThemeProposal = { status: ThemeProposalStatus; startedAt?: number; theme?: Theme; error?: string };
export const blocksPublication = (status: ThemeProposalStatus | undefined) => status === "generating" || status === "ready";
