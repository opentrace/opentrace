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

// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import GraphLegend from "../GraphLegend";
import type { GraphLegendProps } from "../types";

afterEach(cleanup);

function makeProps(overrides?: Partial<GraphLegendProps>): GraphLegendProps {
  return {
    colorMode: "type",
    legendItems: [
      { type: "Repository", count: 5, color: "#10b981" },
      { type: "Class", count: 12, color: "#3b82f6" },
      { type: "Function", count: 30, color: "#a855f7" },
    ],
    communityLegendItems: [],
    legendLinkItems: [{ type: "CALLS", count: 20, color: "#666" }],
    ...overrides,
  };
}

describe("GraphLegend", () => {
  it("renders node type items in type mode", () => {
    const { getByText } = render(React.createElement(GraphLegend, makeProps()));
    expect(getByText("Repository")).toBeDefined();
    expect(getByText("Class")).toBeDefined();
    expect(getByText("Function")).toBeDefined();
  });

  it("renders counts for each item", () => {
    const { getByText } = render(React.createElement(GraphLegend, makeProps()));
    expect(getByText("5")).toBeDefined();
    expect(getByText("12")).toBeDefined();
    expect(getByText("30")).toBeDefined();
  });

  it("renders link items after a divider", () => {
    const { container, getByText } = render(
      React.createElement(GraphLegend, makeProps()),
    );
    expect(getByText("CALLS")).toBeDefined();
    expect(getByText("20")).toBeDefined();
    const divider = container.querySelector(".legend-divider");
    expect(divider).not.toBeNull();
  });

  it("does not render divider when there are no link items", () => {
    const { container } = render(
      React.createElement(GraphLegend, makeProps({ legendLinkItems: [] })),
    );
    const divider = container.querySelector(".legend-divider");
    expect(divider).toBeNull();
  });

  it("renders community items when colorMode is community", () => {
    const { getByText, queryByText } = render(
      React.createElement(
        GraphLegend,
        makeProps({
          colorMode: "community",
          communityLegendItems: [
            { label: "Frontend", count: 10, color: "#f00" },
            { label: "Backend", count: 8, color: "#0f0" },
          ],
        }),
      ),
    );
    expect(getByText("Frontend")).toBeDefined();
    expect(getByText("Backend")).toBeDefined();
    // Node type items should not appear in community mode
    expect(queryByText("Repository")).toBeNull();
  });

  describe("overflow", () => {
    const manyItems = Array.from({ length: 8 }, (_, i) => ({
      type: `Type${i}`,
      count: i + 1,
      color: `#${String(i).repeat(6).slice(0, 6)}`,
    }));

    it('shows "+N more" button when items exceed maxVisible (default 5)', () => {
      const { getByText } = render(
        React.createElement(GraphLegend, makeProps({ legendItems: manyItems })),
      );
      expect(getByText("+3 more")).toBeDefined();
    });

    it("respects custom maxVisible prop", () => {
      const { getByText } = render(
        React.createElement(
          GraphLegend,
          makeProps({ legendItems: manyItems, maxVisible: 3 }),
        ),
      );
      expect(getByText("+5 more")).toBeDefined();
    });

    it("does not show overflow button when items fit", () => {
      const { queryByText } = render(
        React.createElement(GraphLegend, makeProps()),
      );
      // 3 items, default maxVisible=5
      expect(queryByText(/more/)).toBeNull();
    });

    it("shows popover with all items when overflow button is clicked", () => {
      const { getByText, container } = render(
        React.createElement(GraphLegend, makeProps({ legendItems: manyItems })),
      );
      fireEvent.click(getByText("+3 more"));
      const popover = container.querySelector(".legend-popover");
      expect(popover).not.toBeNull();
      // Popover shows ALL items (not just overflow)
      for (const item of manyItems) {
        expect(popover!.textContent).toContain(item.type);
      }
    });

    it("toggles popover off on second click", () => {
      const { getByText, container } = render(
        React.createElement(GraphLegend, makeProps({ legendItems: manyItems })),
      );
      fireEvent.click(getByText("+3 more"));
      expect(container.querySelector(".legend-popover")).not.toBeNull();
      fireEvent.click(getByText("+3 more"));
      expect(container.querySelector(".legend-popover")).toBeNull();
    });

    it("truncates long labels to 10 chars in inline view", () => {
      const { getByText } = render(
        React.createElement(
          GraphLegend,
          makeProps({
            legendItems: [
              { type: "VeryLongTypeName", count: 1, color: "#000" },
            ],
          }),
        ),
      );
      // Should show truncated text with ellipsis
      expect(getByText("VeryLongTy…")).toBeDefined();
    });
  });
});
