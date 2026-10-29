import { englishStorage } from "../fixtures/preferences";
import { assertTestDatabase } from "../database";
import { captureResponsiveLayout } from "./responsive";
import { writeFileSync } from "node:fs";
import { bracketFixture } from "../fixtures/bracket";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { sql } from "drizzle-orm";
import { db, closeDb } from "../../src/db";
import { createSession } from "../../src/lib/auth/sessions";
import { draftPicks } from "../../src/db/schema";
import { prepareDraft } from "../fixtures/draft";
const testUrl = process.env.TEST_DATABASE_URL;
test.describe("isolated multi-captain rehearsal", () => {
  test.skip(!testUrl, "Requires isolated PostgreSQL");
  test.setTimeout(90000);
  const contexts: BrowserContext[] = [];
  test.beforeAll(() => {
    assertTestDatabase(testUrl);
    process.env.DATABASE_URL = testUrl;
    process.env.ADMIN_OSU_IDS = "110001,120001";
  });
  test.beforeEach(async () => {
    await db().execute(sql`TRUNCATE edition_state, users CASCADE`);
  });
  test.afterEach(async () => {
    for (const context of contexts.splice(0)) await context.close();
    await db().execute(sql`TRUNCATE edition_state, users CASCADE`);
    writeFileSync(process.env.OCLR_TEST_BRACKETS_FILE!, "[]");
  });
  test.afterAll(async () => closeDb());
  async function actor(browser: Browser, id: number | null, mobile: boolean) {
    const context = await browser.newContext({
      storageState: englishStorage,
      baseURL: "http://127.0.0.1:3100",
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    context.setDefaultTimeout(10000);
    contexts.push(context);
    if (id) {
      const session = await createSession(id);
      await context.addCookies([
        {
          name: "oclr_session",
          value: session.token,
          domain: "127.0.0.1",
          path: "/",
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
    }
    const page = await context.newPage();
    await page.route("https://a.ppy.sh/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="88" height="88"><rect width="88" height="88" rx="12" fill="#574066"/><circle cx="44" cy="32" r="14" fill="#d5b1eb"/><path d="M18 78a26 26 0 0 1 52 0" fill="#d5b1eb"/></svg>',
      }),
    );
    return { context, page };
  }
  test("captain-direct and staff-on-behalf picks publish atomically and survive reconnect", async ({
    browser,
    isMobile,
  }, testInfo) => {
    const slug = isMobile ? "draft-mobile-test" : "draft-desktop-test";
    const base = isMobile ? 120001 : 110001;
    const fixture = await prepareDraft(slug, base);
    const a = await actor(browser, fixture.a.osuId, isMobile);
    const b = await actor(browser, fixture.b.osuId, isMobile);
    const staff = await actor(browser, fixture.staff.osuId, isMobile);
    const spectator = await actor(browser, null, isMobile);
    await a.page.goto(`/tournaments/${slug}/draft/captain`);
    await b.page.goto(`/tournaments/${slug}/draft/captain`);
    await staff.page.goto(`/admin/tournaments/${slug}/draft`);
    const source = staff.page.getByRole("textbox", {
      name: "OBS Browser Source / Overlay URL",
      exact: true,
    });
    await expect(source).toHaveValue(
      `http://127.0.0.1:3100/tournaments/${slug}/draft/overlay`,
    );
    // Denied clipboard access keeps a focusable manual-copy fallback.
    await staff.page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error("denied")) },
      }),
    );
    await staff.page
      .getByRole("button", { name: "Copy URL", exact: true })
      .click();
    await expect(
      staff.page.getByRole("status").filter({ hasText: "Copy failed." }),
    ).toBeVisible();
    await expect(source).toBeFocused();
    await staff.page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (window as unknown as { copied: string }).copied = text;
          },
        },
      }),
    );
    await staff.page
      .getByRole("button", { name: "Copy URL", exact: true })
      .click();
    await expect(
      staff.page.getByRole("status").filter({ hasText: "URL copied." }),
    ).toBeVisible();
    expect(
      await staff.page.evaluate(
        () => (window as unknown as { copied: string }).copied,
      ),
    ).toBe(`http://127.0.0.1:3100/tournaments/${slug}/draft/overlay`);
    await staff.page
      .locator(".obs-source-link")
      .getByRole("button", { name: "Notes", exact: true })
      .click();
    await expect(
      staff.page.getByText(
        "Only released draft information appears in the overlay.",
        { exact: true },
      ),
    ).toBeVisible();
    await staff.page.keyboard.press("Escape");
    await spectator.page.goto(`/tournaments/${slug}/draft`);
    const closedRegistration = await spectator.context.newPage();
    await closedRegistration.goto(`/tournaments/${slug}/register`);
    await expect(
      closedRegistration.getByRole("heading", {
        name: "Registration is not open",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      closedRegistration.getByRole("button", {
        name: /Submit individual application/,
      }),
    ).toHaveCount(0);
    await closedRegistration.close();
    await expect(
      a.page.getByRole("button", { name: "Confirm Pick", exact: true }),
    ).toBeVisible();
    await expect(
      b.page.getByRole("button", { name: "Confirm Pick", exact: true }),
    ).toBeDisabled();
    const initial = await (
      await b.context.request.get(`/api/tournaments/${slug}/draft/captain`)
    ).json();
    expect(
      (
        await b.context.request.post(`/api/tournaments/${slug}/draft/picks`, {
          headers: { origin: "http://127.0.0.1:3100" },
          data: {
            sessionId: initial.sessionId,
            turnIndex: initial.turnIndex,
            expectedVersion: initial.engineRevision,
            candidateId: fixture.players[0].osuId,
            idempotencyKey: crypto.randomUUID(),
          },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await spectator.context.request.post(
          `/api/tournaments/${slug}/draft/picks`,
          { headers: { origin: "http://127.0.0.1:3100" }, data: {} },
        )
      ).status(),
    ).toBe(401);
    expect(
      (
        await a.context.request.get(`/api/admin/tournaments/${slug}/draft`)
      ).status(),
    ).toBe(403);
    const choose = a.page.getByRole("button", {
      name: `Choose ${fixture.players[0].username}`,
      exact: true,
    });
    await expect(
      a.page.getByRole("region", { name: "My team", exact: true }),
    ).toContainText(fixture.a.username);
    await expect(
      b.page.getByRole("region", { name: "My team", exact: true }),
    ).toContainText(fixture.b.username);
    await expect(
      b.page.getByRole("button", {
        name: `Choose ${fixture.players[0].username}`,
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      b.page.getByText("Waiting for your turn.", { exact: true }).first(),
    ).toBeVisible();
    await a.page
      .getByRole("searchbox", { name: "Search eligible players", exact: true })
      .fill(String(fixture.players[0].osuId));
    await expect(
      a.page
        .getByRole("list", { name: "Eligible players", exact: true })
        .locator("li"),
    ).toHaveCount(1);
    if (isMobile) await choose.tap();
    else {
      await choose.focus();
      await choose.press("Enter");
    }
    await expect(
      a.page.getByRole("button", { name: "Confirm Pick", exact: true }),
    ).toBeFocused();
    await a.page
      .getByRole("button", { name: "Cancel selection", exact: true })
      .click();
    await expect(choose).toBeFocused();
    await a.page
      .getByRole("searchbox", { name: "Search eligible players", exact: true })
      .fill("");
    if (isMobile) await choose.tap();
    else
      await a.page
        .locator(`[data-player-id="${fixture.players[0].osuId}"]`)
        .dragTo(a.page.getByRole("region", { name: "My team", exact: true }));
    await expect(
      a.page.getByLabel("Pending selection", { exact: true }),
    ).toContainText(fixture.players[0].username);
    expect(await db().select().from(draftPicks)).toHaveLength(0);
    await expect(
      a.page
        .getByRole("list", { name: "My team roster", exact: true })
        .locator("li"),
    ).toHaveCount(1);
    await expect(choose.locator("img")).toHaveAttribute(
      "src",
      `https://a.ppy.sh/${fixture.players[0].osuId}`,
    );
    expect(
      (
        await new AxeBuilder({ page: a.page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    expect(
      await a.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await a.page.evaluate(() => {
      window.scrollTo(0, 0);
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    });
    await captureResponsiveLayout(a.page, testInfo, "captain-pending-pick");
    await a.page.screenshot({
      path: testInfo.outputPath("captain-pending-pick.png"),
      fullPage: true,
      animations: "disabled",
    });
    // Let the committed snapshot arrive before its HTTP receipt, so the old
    // selection component has unmounted when it reports success to the room.
    await a.page.route(
      `**/api/tournaments/${slug}/draft/picks`,
      async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await expect(
          a.page
            .getByRole("list", { name: "My team roster", exact: true })
            .locator("li"),
        ).toHaveCount(2);
        await route.fulfill({ response });
      },
    );
    await a.page
      .getByRole("button", { name: "Confirm Pick", exact: true })
      .click();

    await expect(a.page.getByText(/Pick committed to/).first()).toBeVisible();
    await expect(
      staff.page.getByRole("button", {
        name: "Publish current state",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      a.page
        .getByRole("list", { name: "My team roster", exact: true })
        .locator("li"),
    ).toHaveCount(2);
    await expect(choose).toHaveCount(0);
    await expect(spectator.page.locator(".draft-picks > li")).toHaveCount(1);
    await expect(
      b.page.getByRole("button", {
        name: `Choose ${fixture.players[1].username}`,
        exact: true,
      }),
    ).toBeEnabled();
    // Each room polls independently. Wait for Staff's own turn transition
    // before staging a proposal; a proposal for the previous captain is invalidated.
    const staffConfirm = staff.page.getByRole("button", {
      name: `Select for Captain ${fixture.b.username}`,
      exact: true,
    });
    await expect(staffConfirm).toBeVisible();
    await expect(staffConfirm).toBeDisabled();
    await expect(
      staff.page.getByRole("region", { name: "Receiving team", exact: true }),
    ).toContainText(fixture.b.username);
    await staff.page
      .getByRole("button", {
        name: `Choose ${fixture.players[1].username}`,
        exact: true,
      })
      .click();
    await expect(
      staff.page.getByLabel("Pending selection", { exact: true }),
    ).toContainText(fixture.players[1].username);
    await staff.page.route(
      `**/api/tournaments/${slug}/draft/picks`,
      async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await expect(
          staff.page.getByRole("region", {
            name: "Receiving team",
            exact: true,
          }),
        ).toHaveCount(0);
        await route.fulfill({ response });
      },
    );
    await staffConfirm.click();
    await expect(
      staff.page.getByText(/Pick committed to/).first(),
    ).toBeVisible();

    await expect(spectator.page.locator(".draft-picks > li")).toHaveCount(2);
    await expect(
      spectator.page.locator(".draft-picks > li").last(),
    ).toContainText(fixture.b.username);
    await expect(
      spectator.page.locator(".draft-picks > li").last(),
    ).not.toContainText(fixture.staff.username);
    await spectator.context.setOffline(true);
    await expect(
      spectator.page.getByRole("status").filter({ hasText: "Reconnecting" }),
    ).toBeVisible({ timeout: 7000 });
    await spectator.context.setOffline(false);
    await expect(
      spectator.page.getByRole("status").filter({ hasText: "Connected" }),
    ).toBeVisible({ timeout: 7000 });
    await spectator.page.reload();
    await expect(spectator.page.locator(".draft-picks > li")).toHaveCount(2);
    expect(await db().select().from(draftPicks)).toHaveLength(2);
    await staff.page
      .getByRole("button", { name: "Finalize rosters", exact: true })
      .click();
    await staff.page
      .getByRole("dialog")
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    await expect(
      staff.page.getByText("Rosters finalized", { exact: true }),
    ).toBeVisible();
    await expect(
      spectator.page.getByText("Rosters finalized", { exact: true }),
    ).toBeVisible();
    const teamA = fixture.teamRows.find(
      (t) => t.captainId === fixture.a.osuId,
    )!;
    const teamB = fixture.teamRows.find(
      (t) => t.captainId === fixture.b.osuId,
    )!;
    writeFileSync(
      process.env.OCLR_TEST_BRACKETS_FILE!,
      JSON.stringify([bracketFixture(slug, teamA.id, teamB.id)]),
    );
    const bracketPage = await spectator.context.newPage();
    await bracketPage.goto(`/tournaments/${slug}/bracket`);
    await expect(
      bracketPage.getByRole("heading", {
        name: "Bracket awaiting publication",
      }),
    ).toBeVisible();
    for (const team of fixture.teamRows) {
      await staff.page.goto(`/admin/tournaments/${slug}/teams`);
      const card = staff.page.getByRole("article").filter({
        has: staff.page.getByRole("heading", {
          name: team.name,
          exact: true,
        }),
      });
      await card
        .getByRole("button", { name: "Publish finalized roster", exact: true })
        .click();
      await staff.page
        .getByRole("dialog")
        .getByRole("button", { name: "Confirm", exact: true })
        .click();
      await expect(
        card.getByRole("button", { name: "Hide roster", exact: true }),
      ).toBeVisible();
    }
    await bracketPage.reload();
    await expect(bracketPage.locator(".match-card")).toHaveCount(2);
    await expect(bracketPage.locator(".bracket-connectors path")).toHaveCount(
      2,
    );
    await expect(
      bracketPage.locator(".match-card").first().locator(".match-winner"),
    ).toContainText(teamA.name);
    await expect(bracketPage.locator(".match-card").last()).toContainText(
      "Pending",
    );
    await expect(bracketPage.locator(".match-alternative")).toHaveCount(0);
    await expect(bracketPage.locator(".match-card h3").first()).toBeVisible();
    await expect(
      bracketPage.locator(".match-card .sr-only").first(),
    ).toHaveText(" (winner)");
    expect(
      (
        await new AxeBuilder({ page: bracketPage })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    if (isMobile) {
      const region = bracketPage.getByRole("region", {
        name: /bracket; scroll horizontally/,
      });
      await region.focus();
      await region.press("ArrowRight");
      await expect
        .poll(() => region.evaluate((node) => node.scrollLeft))
        .toBeGreaterThan(0);
    }
    expect(
      await bracketPage.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await bracketPage.evaluate(() => window.scrollTo(0, 0));
    await bracketPage.screenshot({
      path: testInfo.outputPath("bracket.png"),
      fullPage: true,
      animations: "disabled",
    });
    await bracketPage.goto(`/tournaments/${slug}/participants`);
    await expect(bracketPage).toHaveURL(
      new RegExp(`/tournaments/${slug}/players$`),
    );
    await expect(
      bracketPage
        .locator(".event-player-identity .muted")
        .filter({ hasText: /^Captain/ }),
    ).toHaveCount(2);
    // Accepted players remain public even when they have no released roster.
    await expect(
      bracketPage.getByRole("link", {
        name: fixture.players[0].username,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      bracketPage.getByRole("link", {
        name: fixture.players[7].username,
        exact: true,
      }),
    ).toBeVisible();
    await bracketPage.close();
    await staff.page.goto(`/admin/tournaments/${slug}/draft`);
    for (const [page, name] of [
      [a.page, "captain"],
      [staff.page, "draft-control"],
      [spectator.page, "draft-public"],
    ] as const) {
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
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        if (document.activeElement instanceof HTMLElement)
          document.activeElement.blur();
      });
      await page.screenshot({
        path: testInfo.outputPath(`${name}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
    await spectator.page.goto(`/tournaments/${slug}/draft?presenter=1`);
    await expect(spectator.page).toHaveURL(/\/login/);
    const presenterPage = await staff.context.newPage();
    await presenterPage.goto(`/tournaments/${slug}/draft?presenter=1`);
    await expect(presenterPage.locator(".site-header")).toBeHidden();
    await expect(presenterPage.locator(".draft-picks > li")).toHaveCount(2);
    await presenterPage.close();
    const payload = JSON.stringify(
      await (
        await spectator.context.request.get(`/api/tournaments/${slug}/draft`)
      ).json(),
    );
    for (const forbidden of [
      "actorId",
      "requestKey",
      "staff_on_behalf",
      fixture.staff.username,
    ])
      expect(payload).not.toContain(forbidden);
    await a.context.clearCookies();
    await a.context.addCookies(englishStorage.cookies);
    await staff.context.clearCookies();
    await staff.context.addCookies(englishStorage.cookies);
    await expect(
      a.page.getByRole("heading", {
        name: "Sign-in or captain access changed.",
        exact: true,
      }),
    ).toBeVisible();
    await expect(a.page.locator(".draft-picks > li")).toHaveCount(0);
    await expect(staff.page.getByRole("main").getByRole("alert")).toHaveText(
      "Staff access is unavailable. Sign in again or contact the organizer.",
    );
    await expect(staff.page.locator(".draft-picks > li")).toHaveCount(0);
  });
  test("competing UI confirmations commit once and clear stale selections", async ({
    browser,
    isMobile,
  }) => {
    const slug = isMobile ? "draft-mobile-test" : "draft-desktop-test";
    const fixture = await prepareDraft(slug, isMobile ? 120001 : 110001);
    const a = await actor(browser, fixture.a.osuId, isMobile);
    const staff = await actor(browser, fixture.staff.osuId, isMobile);
    await a.page.goto(`/tournaments/${slug}/draft/captain`);
    await staff.page.goto(`/admin/tournaments/${slug}/draft`);
    await a.page
      .getByRole("button", {
        name: `Choose ${fixture.players[0].username}`,
        exact: true,
      })
      .click();
    await staff.page
      .getByRole("button", {
        name: `Choose ${fixture.players[0].username}`,
        exact: true,
      })
      .click();
    await Promise.all([
      a.page.getByRole("button", { name: "Confirm Pick", exact: true }).click(),
      staff.page
        .getByRole("button", {
          name: `Select for Captain ${fixture.a.username}`,
          exact: true,
        })
        .click(),
    ]);
    await expect
      .poll(async () => (await db().select().from(draftPicks)).length)
      .toBe(1);
    await expect
      .poll(
        async () =>
          (await a.page.locator("main").innerText()) +
          (await staff.page.locator("main").innerText()),
      )
      .toContain("Draft state changed");
    await expect(
      staff.page.getByText("Committed changes await publication.", {
        exact: false,
      }),
    ).toHaveCount(0);
    const cancel = staff.page
      .locator("dialog[open]")
      .getByRole("button", { name: "Cancel", exact: true });
    if (await cancel.count()) await cancel.click();
    await expect(
      staff.page.getByRole("button", {
        name: `Select for Captain ${fixture.b.username}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      staff.page.getByRole("button", {
        name: `Select for Captain ${fixture.b.username}`,
        exact: true,
      }),
    ).toBeDisabled();
  });
  test("discards unconfirmed picks on disconnect and retries a lost receipt with the same idempotency key", async ({
    browser,
    isMobile,
  }) => {
    const slug = isMobile ? "draft-mobile-test" : "draft-desktop-test";
    const fixture = await prepareDraft(slug, isMobile ? 120001 : 110001);
    const a = await actor(browser, fixture.a.osuId, isMobile);
    await a.page.goto(`/tournaments/${slug}/draft/captain`);
    const choose = a.page.getByRole("button", {
      name: `Choose ${fixture.players[0].username}`,
      exact: true,
    });
    await choose.click();
    await a.context.setOffline(true);
    await expect(
      a.page.getByRole("status").filter({ hasText: "Reconnecting ·" }),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      a.page.getByLabel("Pending selection", { exact: true }),
    ).not.toContainText(fixture.players[0].username);
    await a.context.setOffline(false);
    await expect(choose).toBeEnabled({ timeout: 10000 });
    await expect(
      a.page.getByRole("button", { name: "Confirm Pick", exact: true }),
    ).toBeDisabled();
    await choose.focus();
    await choose.press("Enter");
    const payloads: object[] = [];
    await a.page.route(
      `**/api/tournaments/${slug}/draft/picks`,
      async (route) => {
        payloads.push(route.request().postDataJSON());
        if (payloads.length === 1) {
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          await route.abort("failed");
        } else await route.continue();
      },
    );
    await a.page
      .getByRole("button", { name: "Confirm Pick", exact: true })
      .click();
    await expect(
      a.page.getByText(/Connection interrupted/).first(),
    ).toBeVisible();
    await expect(
      a.page.getByRole("button", {
        name: `Choose ${fixture.players[1].username}`,
        exact: true,
      }),
    ).toBeDisabled();
    await a.page
      .getByRole("button", { name: "Retry confirmed pick", exact: true })
      .dblclick();
    await expect(a.page.getByText(/Pick committed to/).first()).toBeVisible();
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toEqual(payloads[0]);
    expect(await db().select().from(draftPicks)).toHaveLength(1);
    await expect(
      a.page
        .getByRole("list", { name: "My team roster", exact: true })
        .locator("li"),
    ).toHaveCount(1);
    await expect(a.page.getByRole("dialog")).toHaveCount(0);
  });
});
