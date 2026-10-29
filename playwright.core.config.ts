import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Day-to-day contract: public access, registration, scoped roles, draft/results,
// read-only API credentials and desktop IRC authorization/relay.
// Visual/theme/archive matrices belong to full CI.
export const coreSpecs = [
  "health.spec.ts",
  "public.spec.ts",
  "registration.spec.ts",
  "roles.spec.ts",
  "draft.spec.ts",
  "results.spec.ts",
  "read-api.spec.ts",
  "developer-api.spec.ts",
  "desktop-auth.spec.ts",
  "referee.spec.ts",
];
export default defineConfig({
  ...base,
  testMatch: coreSpecs.map((file) => "**/" + file),
  grepInvert: /@full/,
  projects: base.projects?.filter(
    (project) => project.name !== "firefox-header",
  ),
});
