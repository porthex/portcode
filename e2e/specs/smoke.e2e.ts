/**
 * Smoke test: launch the built Portcode app through tauri-driver and assert the
 * main WebView2 window loads and renders its React shell.
 *
 * The assertions are deliberately data-independent — they check the document
 * and the mounted UI structure, not any agent/session/LLM state — so the suite
 * stays green without a backend, API keys, or seeded data. It is a "does the
 * app boot and paint?" gate, not a feature test.
 */
describe("Portcode app shell", () => {
  it("loads the main window with the Portcode title", async () => {
    // The <title> is set in index.html and surfaces as the window title.
    await expect(browser).toHaveTitle("Portcode");
  });

  it("mounts the React root with rendered content", async () => {
    const root = $("#root");
    await expect(root).toBeExisting();

    // React has rendered into #root — it is not an empty mount point.
    const mounted = await root.$$("*");
    expect(mounted.length).toBeGreaterThan(0);
  });

  it("renders the application shell", async () => {
    // App renders its top-level layout container directly under #root.
    await expect($("#root > div")).toBeDisplayed();

    // The title bar (<header>) renders unconditionally — independent of any
    // session or agent data — so it is a stable signal that the UI is live.
    await expect($("header")).toBeDisplayed();
  });
});
