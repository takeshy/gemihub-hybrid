/** Public publication waits while the shop's own AI design is being made or awaits the owner's decision. */
export type ThemeProposalStatus = "none" | "generating" | "ready" | "failed";
export const blocksPublication = (status: ThemeProposalStatus | undefined) => status === "generating" || status === "ready";
