/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Smoke tests — verify the app loads and key UI elements render.
 *
 * These run against the Vite preview server (built output) or a deployed URL
 * via the BASE_URL env var.
 */

import { test, expect } from "@playwright/test";

test.describe("App smoke tests", () => {
  test("app loads without blank screen", async ({ page }) => {
    await page.goto("/");

    // The root div should have children (app rendered)
    const root = page.locator("#root");
    await expect(root).not.toBeEmpty();

    // Page title should be set
    await expect(page).toHaveTitle(/OpenTrace/);
  });

  test("no critical console errors on load", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    await page.goto("/");
    // Wait for initial render to settle
    await page.waitForTimeout(2000);

    // Filter out known non-critical errors (e.g. favicon 404, dev warnings)
    const critical = errors.filter(
      (e) =>
        !e.includes("favicon") &&
        !e.includes("DevTools") &&
        !e.includes("Download the React DevTools"),
    );

    expect(critical).toEqual([]);
  });

  test("graph container renders", async ({ page }) => {
    await page.goto("/");

    // The graph viewer renders a canvas (Pixi.js) or a container div
    const canvas = page.locator("canvas");
    const graphContainer = page.locator(
      '[class*="graph"], [class*="Graph"], [data-testid*="graph"]',
    );

    // At least one of these should be present
    const canvasCount = await canvas.count();
    const containerCount = await graphContainer.count();
    expect(canvasCount + containerCount).toBeGreaterThan(0);
  });

  test("search input is present and interactive", async ({ page }) => {
    await page.goto("/");

    const searchInput = page.locator(
      'input[placeholder*="Search"], .ot-search-input',
    );

    // Search input should exist (may need to wait for toolbar to render)
    await expect(searchInput.first()).toBeVisible({ timeout: 10_000 });

    // Should accept text input
    await searchInput.first().fill("test query");
    await expect(searchInput.first()).toHaveValue("test query");
  });

  test("static assets load successfully", async ({ page }) => {
    const failedRequests: string[] = [];

    page.on("response", (response) => {
      const url = response.url();
      const status = response.status();
      // Check JS, CSS, and WASM assets
      if (/\.(js|css|wasm)(\?|$)/.test(url) && status >= 400) {
        failedRequests.push(`${status} ${url}`);
      }
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    expect(failedRequests).toEqual([]);
  });
});
