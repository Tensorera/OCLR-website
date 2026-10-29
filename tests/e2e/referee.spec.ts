import { test, expect } from "@playwright/test";
import { db, closeDb } from "../../src/db";
import { eq } from "drizzle-orm";
import { matchResults, staffRoles, users } from "../../src/db/schema";
import { createSession } from "../../src/lib/auth/sessions";
import {
  seedRefereeFixture,
  refereeTestAdmin,
  refereeTestUser,
} from "../fixtures/referee";
import { seedBrowserEditions } from "./setup";
import { assertTestDatabase } from "../database";
import { appearances } from "../../src/lib/preferences";
import { englishStorage } from "../fixtures/preferences";
import type { RefereeWorkspace } from "../../src/lib/referee";

async function seed() {
  assertTestDatabase(process.env.TEST_DATABASE_URL);
  if (
    new URL(process.env.TEST_DATABASE_URL!).pathname === "/oclr_frontend_test"
  )
    throw new Error("Never run against the local preview database.");
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  await seedBrowserEditions();
  const fixture = await seedRefereeFixture();
  await db()
    .insert(staffRoles)
    .values({
      userId: refereeTestAdmin.osuId,
      editionSlug: "test-cup",
      role: "admin",
      grantedBy: refereeTestAdmin.osuId,
    })
    .onConflictDoNothing();
  const session = await createSession(refereeTestUser.osuId);
  return {
    ...fixture,
    cookie: {
      name: "oclr_session",
      value: session.token,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax" as const,
      secure: false,
    },
  };
}

test.describe("referee command workspace", () => {
  test.skip(!process.env.TEST_DATABASE_URL, "Requires isolated PostgreSQL");
  test.afterAll(async () => closeDb());
  test("keeps unpaired IRC disconnected and preserves authorized saved records", async ({
    page,
    context,
    browser,
    isMobile,
    baseURL,
  }) => {
    test.setTimeout(120000);
    const seeded = await seed();
    await context.addCookies([seeded.cookie]);
    if (isMobile) await page.setViewportSize({ width: 320, height: 844 });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (window as unknown as { lastCopied: string }).lastCopied = text;
          },
        },
      });
    });
    const path = `/admin/tournaments/test-cup/matches/${seeded.fixtureId}/referee`;
    const api = `/api/admin/tournaments/test-cup/matches/${seeded.fixtureId}/referee`;
    const officialResult = () =>
      db()
        .select({
          version: matchResults.version,
          publishedRevision: matchResults.publishedRevision,
        })
        .from(matchResults)
        .where(eq(matchResults.fixtureId, seeded.fixtureId));
    const officialBefore = await officialResult();

    const read = async () =>
      (await (await context.request.get(api)).json()) as RefereeWorkspace;
    await page.goto("/admin/tournaments/test-cup/matches");
    await page
      .getByRole("link", { name: "Referee panel", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`${seeded.fixtureId}/referee$`));
    await expect(
      page.getByRole("heading", { name: "Command list", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("IRC not connected", { exact: true }),
    ).toBeVisible();
    const [home, away] = seeded.workspace.teams;
    await page
      .getByLabel("First Ban team", { exact: true })
      .selectOption(home.id);
    await expect(
      page.getByLabel("First Pick team", { exact: true }),
    ).toHaveValue(away.id);
    await page
      .getByRole("button", { name: "Apply order", exact: true })
      .click();
    await expect
      .poll(async () => (await read()).session?.firstBanTeamId)
      .toBe(home.id);
    const beforePrepare = (await read()).events.length;
    await page
      .locator("#referee-preparation button[data-copied]:not([disabled])")
      .first()
      .click();
    await expect(
      page.getByLabel("IRC command", { exact: true }),
    ).not.toHaveValue("");
    await expect(
      page.getByRole("button", { name: "Send to local IRC", exact: true }),
    ).toBeDisabled();
    expect((await read()).events).toHaveLength(beforePrepare);
    // The independent saved-record API is still authorized and persistent; the
    // disconnected IRC UI must never pretend it acknowledged these commands.
    async function record(entryId: string) {
      const workspace = await read();
      const response = await context.request.patch(api, {
        headers: { Origin: baseURL! },
        data: {
          action: "record_selection",
          entryId,
          requestKey: crypto.randomUUID(),
          expectedRevision: workspace.session?.revision ?? 0,
          dependencyFingerprint: workspace.dependencyFingerprint,
        },
      });
      expect(response.status()).toBe(200);
    }
    await record(seeded.workspace.maps.find((m) => m.beatmapId === 10001)!.id);
    await record(seeded.workspace.maps.find((m) => m.beatmapId === 10002)!.id);
    await page.reload();
    const summary = page.getByRole("region", {
      name: "Referee records",
      exact: true,
    });
    await expect(summary).toContainText("BAN NM1");
    await expect(summary).toContainText("PICK NM2");
    await expect(summary.locator("button")).toHaveCount(0);
    await page
      .getByText("Record and correct outcomes", { exact: true })
      .click();
    await page
      .getByRole("button", { name: `Record win: ${home.name}`, exact: true })
      .click();
    await expect
      .poll(async () => (await read()).projection.score[home.id])
      .toBe(1);
    await expect(summary).toContainText(`${home.name} 1`);
    await page
      .getByRole("button", { name: "Record replay", exact: true })
      .click();
    await expect
      .poll(async () => (await read()).projection.score[home.id])
      .toBe(0);
    await expect(summary).toContainText("Replays used: 1");
    await page.reload();
    await expect(summary).toContainText("Replays used: 1");
    expect((await read()).projection.activeSelections[1].attempts).toHaveLength(
      2,
    );
    expect(await officialResult()).toEqual(officialBefore);
    const guest = await browser.newContext({
      storageState: englishStorage,
      baseURL,
    });
    expect((await guest.request.get(api)).status()).toBe(401);
    const outsiderId = 891099;
    await db()
      .insert(users)
      .values({ osuId: outsiderId, username: "Synthetic Unassigned Referee" })
      .onConflictDoNothing();
    await db()
      .insert(staffRoles)
      .values({
        userId: outsiderId,
        editionSlug: "test-cup",
        role: "referee",
        grantedBy: refereeTestAdmin.osuId,
      })
      .onConflictDoNothing();
    const outsider = await createSession(outsiderId);
    await guest.addCookies([{ ...seeded.cookie, value: outsider.token }]);
    expect((await guest.request.get(api)).status()).toBe(403);
    const deniedPage = await guest.newPage();
    expect((await deniedPage.goto(path))?.status()).toBe(404);
    await guest.close();
  });
  test("advances BP only after the relay confirms an authoritative record", async ({
    page,
    context,
    baseURL,
  }) => {
    const seeded = await seed();
    await context.addCookies([seeded.cookie]);
    const api = `/api/admin/tournaments/test-cup/matches/${seeded.fixtureId}/referee`;
    const commands: {
      id: string;
      requestKey: string;
      text: string;
      target: string;
      status: string;
      recordError: null;
      createdAt: string;
    }[] = [];
    let selection:
      | {
          entryId: string;
          expectedRevision: number;
          dependencyFingerprint: string;
        }
      | undefined;
    await page.route(`**${api}/irc`, async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        expect(body.action).toBe("queue");
        selection = body.selection;
        commands.push({
          id: crypto.randomUUID(),
          requestKey: body.requestKey,
          text: body.text,
          target: "#mp_12345",
          status: "queued",
          recordError: null,
          createdAt: new Date().toISOString(),
        });
      }
      const workspace = await (await context.request.get(api)).json();
      await route.fulfill({
        json: {
          connection: {
            id: crypto.randomUUID(),
            roomId: 12345,
            ircUsername: "TestRef",
            status: "connected",
            lastSeenAt: new Date().toISOString(),
            connected: true,
          },
          messages: [],
          commands,
          workspace,
        },
      });
    });
    await page.goto(
      `/admin/tournaments/test-cup/matches/${seeded.fixtureId}/referee`,
    );
    await expect(
      page.getByText("IRC connected", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("First Ban team", { exact: true })
      .selectOption(seeded.workspace.teams[0].id);
    await page
      .getByRole("button", { name: "Apply order", exact: true })
      .click();
    await expect(
      page.getByText("Showing applied order", { exact: true }),
    ).toBeVisible();
    const pool = page.getByRole("region", {
      name: "Round mappool",
      exact: true,
    });
    await pool
      .getByRole("button", { name: "Blue team BAN", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: "Send to local IRC", exact: true })
      .click();
    await expect(
      page.getByText("Queued for local IRC", { exact: true }),
    ).toBeVisible();
    expect(commands).toHaveLength(1);
    expect(selection).toBeDefined();
    const summary = page.getByRole("region", {
      name: "Referee records",
      exact: true,
    });
    await expect(summary).not.toContainText("BAN NM1");
    commands[0].status = "sent";
    await expect(
      page.getByText("Sent; awaiting room confirmation", { exact: true }),
    ).toBeVisible();
    await expect(summary).not.toContainText("BAN NM1");
    const response = await context.request.patch(api, {
      headers: { Origin: baseURL! },
      data: {
        action: "record_selection",
        ...selection,
        requestKey: crypto.randomUUID(),
      },
    });
    expect(response.status()).toBe(200);
    commands[0].status = "confirmed";
    await expect(
      page.getByText("Confirmed by IRC", { exact: true }),
    ).toBeVisible();
    await expect(summary).toContainText("BAN NM1");
  });
  test("keeps every appearance usable in light/dark and all locales @full", async ({
    page,
    context,
    isMobile,
    baseURL,
  }, info) => {
    test.setTimeout(180000);
    const seeded = await seed();
    await context.addCookies([seeded.cookie]);
    const path = `/admin/tournaments/test-cup/matches/${seeded.fixtureId}/referee`;
    const width = isMobile ? 320 : 1440;
    await page.setViewportSize({ width, height: 900 });
    for (const appearance of appearances)
      for (const theme of ["light", "dark"]) {
        await context.addCookies([
          {
            name: "oclr-appearance",
            value: appearance,
            url: baseURL!,
          },
          { name: "oclr-theme", value: theme, url: baseURL! },
        ]);
        await page.goto(path);
        await expect(
          page.getByRole("heading", { name: "Command list", exact: true }),
        ).toBeVisible();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
          `${appearance} ${theme} ${width}`,
        ).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: info.outputPath(`referee-${appearance}-${theme}-${width}.png`),
          fullPage: true,
          animations: "disabled",
        });
      }
    for (const locale of ["zh-Hans", "zh-Hant", "en"]) {
      await context.addCookies([
        { name: "oclr-locale", value: locale, url: baseURL! },
      ]);
      await page.goto(path);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: info.outputPath(`referee-${locale}-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
  });
});
