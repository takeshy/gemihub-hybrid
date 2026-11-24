export function mountSiteEditor({ basePath = "" } = {}) {
  document.getElementById("site-design").hidden = false;
  document.getElementById("site-design-toggle").addEventListener("click", () => { location.href = basePath + "/page-editor"; });
}
