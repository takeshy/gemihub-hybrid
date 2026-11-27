const notice = document.getElementById("judge-session-message");
const invite = location.hash.slice(1);
if (invite) {
  history.replaceState(null, "", location.pathname);
  notice.textContent = "Checking your invitation…";
  try {
    const response = await fetch("/judge/admin/auth/demo", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invite }), signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error("The invitation is unavailable or expired.");
    location.replace("/judge/admin/");
  } catch (error) { notice.textContent = error.message; }
} else {
  location.replace("/judge/admin/");
}
