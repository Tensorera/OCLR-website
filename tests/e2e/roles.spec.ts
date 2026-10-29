import { englishStorage } from "../fixtures/preferences";
import { captureResponsiveLayout } from "./responsive";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { seedSession } from "./session";
import { seedEditions } from "../fixtures/editions";
import { closeDb } from "../../src/db";
test.describe("scoped staff roles through real HTTP sessions", () => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires isolated PostgreSQL");
  test.afterAll(async () => closeDb());
  test.beforeEach(async () => {
    await seedEditions();
  });
  test("grants and revokes limited access without refreshing the operator session", async ({
    page,
    context,
    browser,
    isMobile,
  }, info) => {
    const adminId = isMobile ? 70001 : 60001;
    const operatorId = isMobile ? 180101 : 180001;
    const cookie = await seedSession(operatorId);
    await context.addCookies([await seedSession(adminId)]);
    const operator = await browser.newContext({
      storageState: englishStorage,
      baseURL: "http://127.0.0.1:3100",
    });
    const guest = await browser.newContext({
      storageState: englishStorage,
      baseURL: "http://127.0.0.1:3100",
    });
    await operator.addCookies([cookie]);
    const origin = { origin: "http://127.0.0.1:3100" };
    try {
      expect((await guest.request.get("/api/admin/staff")).status()).toBe(401);
      expect(
        (
          await guest.request.post("/api/admin/staff", {
            headers: origin,
            data: {},
          })
        ).status(),
      ).toBe(401);
      expect((await operator.request.get("/api/admin/staff")).status()).toBe(
        403,
      );
      const scopedCookie = await seedSession(operatorId + 2);
      const scoped = await browser.newContext({
        storageState: englishStorage,
        baseURL: "http://127.0.0.1:3100",
      });
      try {
        await scoped.addCookies([scopedCookie]);
        expect(
          (
            await context.request.post("/api/admin/staff", {
              headers: origin,
              data: {
                action: "grant",
                userId: operatorId + 2,
                role: "admin",
                editionSlug: "test-cup",
                confirmed: true,
              },
            })
          ).status(),
        ).toBe(200);
        const scopedHtml = await (
          await scoped.request.get("/admin/staff")
        ).text();
        expect(scopedHtml).toContain("Synthetic test edition");
        expect(scopedHtml).not.toContain("Synthetic desktop draft");
        expect(scopedHtml).not.toContain("Synthetic mobile draft");
      } finally {
        await scoped.close();
      }
      await page.goto("/admin/staff");
      await captureResponsiveLayout(page, info, "minimal-staff");
      const assignment = page.locator("article").filter({
        has: page.getByRole("heading", {
          name: `Synthetic Player ${operatorId} · ${operatorId}`,
          exact: true,
        }),
      });
      await page.getByLabel("Verified osu! user ID").fill(String(operatorId));
      await page
        .getByRole("group", { name: "Roles (select multiple)" })
        .first()
        .getByRole("checkbox", { name: "Mappooler", exact: true })
        .check();
      await page
        .getByRole("combobox", { name: /^Scope/ })
        .selectOption("test-cup");
      await page.getByRole("button", { name: "Review role grant" }).click();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await assignment
        .locator("summary")
        .filter({ hasText: "About visibility and revocation" })
        .click();
      await expect(
        assignment.getByRole("button", { name: "Revoke role" }),
      ).toBeVisible();
      const listing = await (
        await context.request.get("/api/admin/staff")
      ).json();
      const grant = listing.grants.find(
        (g: { grant: { userId: number; revokedAt: string | null } }) =>
          g.grant.userId === operatorId && !g.grant.revokedAt,
      ).grant;
      const operatorPage = await operator.newPage();
      await operatorPage.goto("/admin");
      await expect(
        operatorPage.getByRole("heading", {
          name: "Administration overview",
          level: 1,
        }),
      ).toBeVisible();
      await expect(
        operatorPage.getByRole("link", { name: "Staff management" }),
      ).toHaveCount(0);
      await expect(
        operatorPage.getByRole("link", { name: /Captains$/ }),
      ).toHaveCount(0);
      for (const path of [
        "/admin/staff",
        "/admin/tournaments/test-cup/captains",
        "/admin/tournaments/test-cup/teams",
        "/admin/tournaments/test-cup/draft",
        "/admin/tournaments/test-cup/matches",
        "/admin/tournaments/draft-desktop-test/mappools",
      ]) {
        // https://nextjs.org/docs/app/api-reference/file-conventions/not-found
        // A streamed not-found page may already have HTTP 200 headers.
        // Assert denial content here; API checks below assert exact 401/403 statuses.
        await operatorPage.goto(path);
        await expect(
          operatorPage.getByRole("heading", {
            name: "Off the beat.",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          operatorPage.getByText("Something went wrong.", { exact: true }),
        ).toHaveCount(0);
      }
      for (const path of [
        "/api/admin/staff",
        "/api/admin/registrations",
        "/api/admin/registrations/export",
        "/api/admin/tournaments/test-cup/captains",
        "/api/admin/tournaments/test-cup/teams",
        "/api/admin/tournaments/test-cup/draft",
      ]) {
        expect((await operator.request.get(path)).status(), path).toBe(403);
        expect((await guest.request.get(path)).status(), path).toBe(401);
      }
      for (const path of [
        "/api/admin/staff",
        "/api/admin/tournaments/test-cup/captains",
        "/api/admin/tournaments/test-cup/teams",
        "/api/admin/tournaments/test-cup/draft",
      ])
        expect(
          (
            await operator.request.post(path, {
              headers: origin,
              data: { confirmed: true },
            })
          ).status(),
          path,
        ).toBe(403);
      expect(
        (
          await context.request.post("/api/admin/staff", {
            data: {
              action: "revoke",
              grantId: grant.id,
              confirmed: true,
            },
          })
        ).status(),
      ).toBe(403);
      expect(
        (
          await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
            .analyze()
        ).violations,
      ).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath("staff-roles.png"),
        fullPage: true,
        animations: "disabled",
      });
      const revoked = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/admin/staff") &&
          response.request().method() === "POST" &&
          response.request().postDataJSON()?.action === "revoke",
      );
      await assignment.getByRole("button", { name: "Revoke role" }).click();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      expect((await revoked).status()).toBe(200);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(
        (
          await operator.request.get("/api/admin/tournaments/test-cup/mappools")
        ).status(),
      ).toBe(403);

      await expect(
        assignment.getByRole("button", { name: "Revoke role" }),
      ).toHaveCount(0);
      expect(
        (
          await operator.request.get("/api/admin/tournaments/test-cup/draft")
        ).status(),
      ).toBe(403);
      const response = await operatorPage.goto("/admin");
      // Next.js notFound() uses 200 once streaming has begun, otherwise 404.
      // Check the denial UI and absence of the protected workspace in both cases.
      expect([200, 404]).toContain(response?.status());
      await expect(
        operatorPage.getByRole("heading", {
          name: "Off the beat.",
          exact: true,
        }),
      ).toBeVisible();
      await expect(operatorPage.locator(".admin-workspace")).toHaveCount(0);
      await expect(
        operatorPage.getByRole("heading", { name: "Administration overview" }),
      ).toHaveCount(0);
      expect((await operator.request.get("/api/admin/staff")).status()).toBe(
        403,
      );
    } finally {
      await operator.close();
      await guest.close();
    }
  });
});
