const endpoint = "/api/demo-shop";
export async function sampleShopSession() {
  try {
    const response = await fetch(endpoint, { cache: "no-store", signal: AbortSignal.timeout(2000) });
    if (response.ok && response.headers.get("content-type")?.includes("application/json")) return await response.json();
  } catch { /* The shop directory is available without a sample shop session. */ }
  return null;
}
