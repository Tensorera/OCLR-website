import { setEditionAppearance } from "../fixtures/editions";
import { expect, test } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { closeDb, db } from "../../src/db";
import {
  developerApiTokens,
  editionState,
  registrations,
  siteSettings,
  staffRoles,
  userProfileCache,
  users,
} from "../../src/db/schema";
import { normalizeOsuProfile } from "../../src/lib/osu-profile-model";
import { appearances } from "../../src/lib/preferences";
import { assertTestDatabase } from "../database";
import { seedSession } from "../e2e/session";
import { edition } from "../fixtures/edition";
import { seedEditions } from "../fixtures/editions";
import { historicalArchive } from "../fixtures/historical-archive";
import { profileResponse } from "../fixtures/osu-profile";
import { seedPublicDirectory } from "../fixtures/players";
import { waitForRemoteRateWindow } from "../fixtures/remote-rate-window";
import { bundledSeasonThemes } from "../fixtures/theme-assets";
const backend = "http://127.0.0.1:3100",
  local = "http://127.0.0.1:31470";
test.afterAll(async () => {
  if (process.env.TEST_DATABASE_URL) {
    assertTestDatabase(process.env.TEST_DATABASE_URL);
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    await db().delete(siteSettings).where(eq(siteSettings.id, 1));
  }
  await closeDb();
});
test("uses real remote grants for core SSR/navigation without local DB or OAuth, isolates sessions and removes revoked private data", async ({
  page,
  context,
  browser,
  isMobile,
}, info) => {
  assertTestDatabase(process.env.TEST_DATABASE_URL);
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  // Always exercise the shipped asset inventory, including the core smoke lane.
  for (const { assets } of bundledSeasonThemes)
    for (const asset of assets)
      for (const method of ["GET", "HEAD"]) {
        const response = await context.request.fetch(asset, {
          method,
          maxRedirects: 0,
        });
        expect(response.status(), `${method} ${asset}`).toBe(200);
        expect(response.headers()["content-type"], asset).toMatch(/^image\//);
        expect(await response.body(), `${method} ${asset}`).toEqual(
          method === "HEAD"
            ? Buffer.alloc(0)
            : readFileSync(new URL(`../../public${asset}`, import.meta.url)),
        );
      }
  await db().execute(
    sql`TRUNCATE edition_state,users,user_profile_cache,site_settings CASCADE`,
  );
  const base = isMobile ? 2709000 : 2708000,
    owner = base + 500;
  const backendContext = await browser.newContext({ baseURL: backend });
  await backendContext.addCookies([await seedSession(owner)]);
  await db()
    .insert(staffRoles)
    .values({ userId: owner, role: "developer", grantedBy: owner });
  const fixture = await seedPublicDirectory(base);
  await seedEditions(
    [
      {
        ...edition,
        slug: "remote-history",
        name: "Synthetic remote history",
        season: "S1",
        status: "completed",
        registration: null,
        archive: { ...historicalArchive, editionSlug: "remote-history" },
      },
    ],
    false,
  );
  await db()
    .insert(siteSettings)
    .values({ id: 1, defaultAppearance: "cute-pastel" });
  const row = (
    await db()
      .select()
      .from(editionState)
      .where(eq(editionState.slug, "test-cup"))
  )[0];
  await db()
    .update(editionState)
    .set({
      configuration: {
        ...row.configuration!,
        defaultAppearance: "esports-broadcast",
      },
    })
    .where(eq(editionState.slug, "test-cup"));
  const privateEdition = (
    await db()
      .select()
      .from(editionState)
      .where(eq(editionState.slug, "private-test-cup"))
  )[0];
  await db()
    .update(editionState)
    .set({
      configuration: {
        ...privateEdition.configuration!,
        defaultAppearance: "retro-arcade",
      },
    })
    .where(eq(editionState.slug, "private-test-cup"));
  const extra = Array.from({ length: 105 }, (_, index) => ({
    osuId: base + 100 + index,
    username: `Synthetic Remote ${index}`,
  }));
  await db().insert(users).values(extra);
  await db()
    .insert(registrations)
    .values(
      extra.map((p) => ({
        userId: p.osuId,
        editionSlug: "test-cup",
        status: "accepted" as const,
        answers: { private: "SYNTHETIC_PRIVATE_CONTACT" },
      })),
    );
  for (const id of [base, base + 1, base + 3, ...extra.map((p) => p.osuId)]) {
    const profile = normalizeOsuProfile(
      {
        ...profileResponse,
        id,
        statistics: {
          ...profileResponse.statistics,
          global_rank: id === base + 1 ? null : 12345,
          pp: id === base + 1 ? 0 : 1234.56,
        },
      },
      id,
      "osu",
    );
    await db()
      .insert(userProfileCache)
      .values({
        osuId: id,
        mode: "osu",
        profile,
        attemptedAt: new Date(),
        retryAt: new Date(Date.now() + 3600000),
      });
  }
  const issued = await backendContext.request.post("/api/developer/tokens", {
    headers: { Origin: backend },
    data: {
      origin: local,
      scopes: [
        "identity:read",
        "tournaments:read",
        "tournaments:private:read",
        "profiles:read",
      ],
    },
  });
  expect(issued.status()).toBe(201);
  const credential = await issued.json();
  async function renewConnection(returnTo?: string) {
    const issue = () =>
      backendContext.request.post("/api/developer/tokens", {
        headers: { Origin: backend },
        data: {
          origin: local,
          scopes: [
            "identity:read",
            "tournaments:read",
            "tournaments:private:read",
            "profiles:read",
          ],
        },
      });
    let renewed = await issue();
    if (renewed.status() === 429) {
      // The full appearance workload can reach the real issuance quota.
      const retryAfter = Number(renewed.headers()["retry-after"] ?? "60");
      await page.waitForTimeout(retryAfter * 1000);
      renewed = await issue();
    }
    expect(renewed.status()).toBe(201);
    credential.token = (await renewed.json()).token;
    await page.goto("/remote");
    await page
      .getByLabel("Developer token", { exact: true })
      .fill(credential.token);
    await Promise.all([
      page.waitForEvent("load"),
      page.getByRole("button", { name: "Connect", exact: true }).click(),
    ]);
    await expect(
      page.getByText(`Connected as Synthetic Player ${owner}`),
    ).toBeVisible();
    if (returnTo) await page.goto(returnTo);
  }
  const authHeaders: string[] = [];
  page.on("request", (r) => {
    if (r.headers().authorization) authHeaders.push(r.url());
    expect(r.url()).not.toContain(credential.token);
  });
  await context.route("https://a.ppy.sh/**", (route) => route.abort());
  await page.goto("/tournaments");
  await expect(
    page.getByText(
      "Connect to the remote backend or choose anonymous public browsing.",
    ),
  ).toBeVisible();
  await page.goto("/remote");
  await page
    .getByLabel("Developer token", { exact: true })
    .fill(credential.token);
  await waitForRemoteRateWindow(page);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByText(`Connected as Synthetic Player ${owner}`),
  ).toBeVisible();
  await expect(page.getByLabel("Developer token", { exact: true })).toHaveValue(
    "",
  );
  expect(await page.content()).not.toContain(credential.token);
  if (isMobile) await page.setViewportSize({ width: 320, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({
    path: info.outputPath("remote-connection-light.png"),
    fullPage: false,
    animations: "disabled",
  });
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    ),
  ).not.toContain(credential.token);
  const me = await context.request.get("/api/me");
  expect((await me.json()).osuId).toBe(owner);
  const cookie = (await context.cookies()).find(
    (c) => c.name === "oclr_remote_session",
  );
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Strict");
  expect(cookie?.value).not.toBe(credential.token);
  await page
    .getByRole("link", { name: "Public tournaments", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-appearance",
    "cute-pastel",
  );
  const tournamentLink = page
    .locator(".edition-card")
    .filter({
      has: page.getByRole("heading", {
        name: "Synthetic test edition",
        exact: true,
      }),
    })
    .getByRole("link", {
      name: "View tournament: Synthetic test edition",
      exact: true,
    });
  await expect(tournamentLink).toBeVisible();
  await expect(tournamentLink).toHaveAttribute("href", "/tournaments/test-cup");
  if (isMobile) {
    // The separate Register action covers the whole-card link's center at 320px.
    await tournamentLink.focus();
    await tournamentLink.press("Enter");
  } else await tournamentLink.click();
  await expect(page).toHaveURL(/\/tournaments\/test-cup$/);
  await expect(page.locator("html")).toHaveAttribute(
    "data-appearance",
    "esports-broadcast",
  );
  await expect(
    page.getByText("Synthetic rules for automated testing only.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.goto("/tournaments/test-cup/rules");
  await expect(
    page.getByText("Synthetic rules for automated testing only.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.goto("/tournaments/test-cup/players");
  await page.reload();
  await expect(page.locator(".event-player-row")).toHaveCount(108);
  await expect(page.locator(".event-player-identity .avatar")).toHaveCount(108);
  await expect(
    page
      .locator(".event-player-identity")
      .getByText(
        "Message boards are not supported in remote development yet.",
        { exact: true },
      ),
  ).toHaveCount(0);
  const member = page
    .locator(".event-player-row")
    .filter({ hasText: `Synthetic Directory ${base} Member` });
  await expect(member.locator("dd")).toHaveText(["—", "0"]);
  await expect(
    page.getByRole("link", { name: "OCLR profile", exact: true }),
  ).toHaveCount(108);
  const legacyDirectory = await context.request.get(
    "/api/tournaments/test-cup/players",
  );
  expect((await legacyDirectory.json()).rows).toHaveLength(108);
  const legacyDetail = await context.request.get("/api/tournaments/test-cup");
  expect((await legacyDetail.json()).rules.version).toBe("test-v1");

  expect(await page.content()).not.toContain("SYNTHETIC_PRIVATE_CONTACT");
  await member.getByRole("link", { name: "OCLR profile", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "osu! profile snapshot" }),
  ).toBeVisible();
  const legacy = await context.request.get(
    `/api/players/${fixture.memberId}?edition=test-cup`,
  );
  expect(legacy.status()).toBe(200);
  expect((await legacy.json()).snapshot.profile.statistics.pp).toBe(0);
  for (const path of [
    "/tournaments/remote-history",
    "/tournaments/remote-history/rules",
    "/tournaments/remote-history/players",
    `/tournaments/remote-history/players/${historicalArchive.players[0].osuId}`,
  ]) {
    await page.goto(path);
    await expect(
      page.getByText("Historical archive", { exact: true }),
    ).toBeVisible();
  }
  await page.goto(
    `/players/${historicalArchive.players[0].osuId}?edition=remote-history`,
  );
  await expect(page).toHaveURL(
    new RegExp(
      `/players/${historicalArchive.players[0].osuId}\\?edition=remote-history$`,
    ),
  );
  await expect(
    page.getByRole("heading", {
      name: historicalArchive.players[0].username,
      level: 1,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Published participation", exact: true }),
  ).toContainText("Historical archive");
  await page.goto("/remote");
  await page
    .getByRole("link", { name: "Internal tournaments", exact: true })
    .click();
  await page
    .locator('a[href="/admin/tournaments/private-test-cup"]')
    .filter({ hasText: "Open tournament" })
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-appearance",
    "retro-arcade",
  );
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Developer access is read-only." }),
  ).toBeVisible();
  const privateRead = await context.request.get(
    "/api/remote/read/staff/tournaments/private-test-cup",
  );
  expect(privateRead.status()).toBe(200);
  expect((await privateRead.json()).data.configuration.published).toBe(false);
  await renewConnection("/admin/tournaments/private-test-cup");
  let failedHealthChecks = 0;
  await page.route("**/api/remote/connection", (route) => {
    failedHealthChecks++;
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ code: "REMOTE_UNAVAILABLE" }),
    });
  });
  await expect
    .poll(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      return failedHealthChecks;
    })
    .toBeGreaterThan(0);
  await expect(
    page
      .getByText(
        "The remote backend is unavailable or returned invalid data. Try again.",
      )
      .first(),
  ).toBeVisible();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Developer access is read-only." }),
  ).toHaveCount(0);
  await page.unroute("**/api/remote/connection");
  await page.reload();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Developer access is read-only." }),
  ).toBeVisible();
  const other = await browser.newContext({
    baseURL: local,
    storageState: {
      cookies: [
        {
          name: "oclr-locale",
          value: "en",
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    },
  });
  const isolated = await other.request.get(
    "/api/remote/read/staff/tournaments/private-test-cup",
  );
  expect(isolated.status()).toBe(401);
  await other.request.post("/api/remote/connection", {
    headers: { Origin: local },
    data: { mode: "anonymous" },
  });
  expect(
    (await other.request.get("/api/remote/read/staff/tournaments")).status(),
  ).toBe(401);
  await other.close();
  for (const path of [
    "/api/admin/tournaments/test-cup",
    "/api/admin/profiles",
    "/api/registrations",
    "/auth/osu/callback",
  ]) {
    const response = await context.request.post(path, {
      headers: { Origin: local },
      data: {},
    });
    expect(response.status()).toBe(403);
  }
  expect(
    (
      await context.request.get("/api/remote/read/https%3A%2F%2Fevil.example")
    ).status(),
  ).toBe(400);
  await page.goto("/tournaments/test-cup/mappools");
  await expect(
    page.getByRole("heading", { name: "Mappools", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "This page or feature is not supported in remote development yet. See the coverage list.",
    ),
  ).toHaveCount(0);
  // Appearance/navigation coverage is intentionally a separate workload from
  // authorization checks; keep the backend's real per-token rate limit intact.
  await renewConnection();
  const appearanceCases = info.config.metadata.remoteCore
    ? ["default"]
    : appearances;
  for (const [index, appearance] of appearanceCases.entries()) {
    if (index > 0 && index % 4 === 0) await renewConnection();
    await context.addCookies([
      { name: "oclr-appearance", value: appearance, url: local },
    ]);
    await setEditionAppearance("test-cup", appearance);
    await renewConnection();
    await page.goto("/tournaments/test-cup/players");
    await expect(page.locator(".event-player-row")).toHaveCount(108);
    await expect(page.locator("html")).toHaveAttribute(
      "data-appearance",
      appearance,
    );
    const theme = bundledSeasonThemes.find(
      (theme) => theme.appearance === appearance,
    );
    if (theme) {
      const decoded = await page.evaluate(async (assets) => {
        return Promise.all(
          assets.map(async (src) => {
            const image = new Image();
            image.src = src;
            await image.decode();
            return {
              src,
              width: image.naturalWidth,
              height: image.naturalHeight,
            };
          }),
        );
      }, theme.assets);
      for (const image of decoded) {
        expect(image.width, image.src).toBeGreaterThan(0);
        expect(image.height, image.src).toBeGreaterThan(0);
      }
      const background = await page
        .locator(".page-heading")
        .evaluate(
          (heading) => getComputedStyle(heading, "::before").backgroundImage,
        );
      expect(theme.assets.some((asset) => background.includes(asset))).toBe(
        true,
      );
      await page.screenshot({
        path: info.outputPath(`remote-${appearance}.png`),
        animations: "disabled",
      });
    }
    if (isMobile) await page.setViewportSize({ width: 320, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await context.addCookies([{ name: "oclr-theme", value: "dark", url: local }]);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: info.outputPath("remote-players-dark.png"),
    fullPage: false,
  });
  await context.addCookies([
    { name: "oclr-locale", value: "zh-Hant", url: local },
  ]);
  await page.goto("/remote");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant");
  await context.addCookies([{ name: "oclr-locale", value: "en", url: local }]);
  await page.goto("/admin/tournaments/private-test-cup");
  await db()
    .update(staffRoles)
    .set({ revokedAt: new Date() })
    .where(eq(staffRoles.userId, owner));
  const deniedBackend = await backendContext.request.get("/api/v1/me", {
    headers: { Origin: local, Authorization: `Bearer ${credential.token}` },
  });
  expect(deniedBackend.status()).toBe(403);
  expect(await deniedBackend.json()).toMatchObject({
    error: { code: "DEVELOPER_REQUIRED" },
  });
  await page.reload();
  // SSR observes the backend denial and invalidates the local connection.
  const denied = await context.request.get("/api/remote/connection");
  expect(denied.status()).toBe(401);
  expect(await denied.json()).toMatchObject({
    state: "unavailable",
    code: "REMOTE_EXPIRED",
  });
  const deniedPrivateRead = await context.request.get(
    "/api/remote/read/staff/tournaments/private-test-cup",
  );
  expect(deniedPrivateRead.status()).toBe(401);
  expect(await deniedPrivateRead.json()).not.toHaveProperty("data");
  await expect(
    page
      .getByRole("status")
      .filter({
        has: page.getByRole("heading", {
          name: "Remote frontend development",
          exact: true,
        }),
      })
      .getByText("Developer access is required.", { exact: true })
      .first(),
  ).toBeVisible();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Developer access is read-only." }),
  ).toHaveCount(0);
  await db()
    .update(staffRoles)
    .set({ revokedAt: null })
    .where(eq(staffRoles.userId, owner));
  await page.goto("/remote");
  await page
    .getByLabel("Developer token", { exact: true })
    .fill(credential.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByText(`Connected as Synthetic Player ${owner}`),
  ).toBeVisible();
  await db()
    .update(developerApiTokens)
    .set({
      createdAt: new Date(Date.now() - 7200000),
      expiresAt: new Date(Date.now() - 3600000),
    })
    .where(eq(developerApiTokens.userId, owner));
  await page.goto("/tournaments");
  await expect(
    page
      .getByText("Remote access expired or was revoked. Connect again.")
      .first(),
  ).toBeVisible();
  await page.goto("/remote");
  await Promise.all([
    page.waitForEvent("load"),
    page
      .getByRole("button", {
        name: "Browse public data anonymously",
        exact: true,
      })
      .click(),
  ]);
  await expect(
    page.getByText("Anonymous public browsing", { exact: true }),
  ).toBeVisible();
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Disconnect", exact: true }).click(),
  ]);
  await expect(
    page.getByText(
      "Connect to the remote backend or choose anonymous public browsing.",
    ),
  ).toBeVisible();
  expect(authHeaders).toEqual([]);
  expect(readFileSync(process.env.OCLR_TEST_NO_DB_ATTEMPTS!, "utf8")).toBe("");
  await backendContext.close();
});
