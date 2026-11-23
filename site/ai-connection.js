import { createConnection, installHybridEngine, mountHybridControls, readPublishedFacts } from "./hybrid.bundle.js";
export { installHybridEngine, readPublishedFacts };
export const aiConnection = () => createConnection(new URL("./hybrid-config.json", import.meta.url).href);
export const mountAiConnection = mountHybridControls;
