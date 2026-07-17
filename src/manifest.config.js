import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "../package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "Devin Session Exporter",
  version: pkg.version,
  description: "Export the currently viewed Devin session conversation.",
  action: {
    default_title: "Export Devin session",
    default_popup: "src/popup/index.html",
    default_icon: {
      16: "icons/icon16.png",
      48: "icons/icon48.png",
      128: "icons/icon128.png"
    }
  },
  icons: {
    16: "icons/icon16.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png"
  },
  permissions: ["activeTab", "scripting", "downloads", "storage"],
  host_permissions: ["https://app.devin.ai/*", "https://devin.ai/*"],
  content_scripts: [
    {
      matches: ["https://app.devin.ai/sessions/*"],
      js: ["vauth.js"],
      run_at: "document_start",
      world: "MAIN"
    },
    {
      matches: ["https://app.devin.ai/*", "https://devin.ai/*"],
      js: ["src/content/main.jsx"],
      run_at: "document_idle"
    }
  ],
  browser_specific_settings: {
    gecko: {
      id: "devin-session-exporter@example.invalid",
      strict_min_version: "109.0"
    }
  }
});
