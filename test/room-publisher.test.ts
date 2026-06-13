import { describe, expect, test } from "bun:test";
import type { CanvasView } from "@keelson/shared";
import { createCoalescingPublisher } from "../src/room-publisher.ts";

const board = (title: string): CanvasView => ({ view: "board", title, sections: [] });

describe("coalescing room publisher", () => {
  test("seeds a valid empty board before the first publish", () => {
    const { latest } = createCoalescingPublisher(() => Promise.resolve());
    expect(latest()).toEqual({ view: "board", title: "Room", sections: [] });
  });

  test("latest() returns the most recently published board", async () => {
    const { publisher, latest } = createCoalescingPublisher(() => Promise.resolve());
    await publisher.publish(board("first"));
    expect(latest()).toEqual(board("first"));
    await publisher.publish(board("second"));
    expect(latest()).toEqual(board("second"));
  });

  test("an idle publish composes exactly once", async () => {
    let n = 0;
    const pub = createCoalescingPublisher(() => {
      n += 1;
      return Promise.resolve();
    });
    await pub.publisher.publish(board("only"));
    expect(n).toBe(1);
  });

  test("a publish mid-compose triggers a second recompose (no lost frame)", async () => {
    let releaseFirst: () => void = () => {};
    const composedTitles: string[] = [];
    let n = 0;
    let latestRef: () => CanvasView = () => board("Room");
    const recompose = () => {
      // Capture what the manager would broadcast (it reads `latest` at compose time).
      const view = latestRef();
      composedTitles.push(view.view === "board" ? (view.title ?? "") : view.view);
      n += 1;
      if (n === 1) {
        return new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve();
    };
    const pub = createCoalescingPublisher(recompose);
    latestRef = pub.latest;

    const p1 = pub.publisher.publish(board("A")); // starts compose 1 (held in flight)
    await Promise.resolve(); // let publish enter the compose loop and suspend
    const p2 = pub.publisher.publish(board("B")); // lands mid-compose -> sets dirty
    releaseFirst(); // compose 1 settles -> the loop sees dirty -> compose 2
    await Promise.all([p1, p2]);

    expect(n).toBe(2); // composed twice — the mid-compose publish was not lost
    expect(composedTitles).toEqual(["A", "B"]); // the second compose broadcasts the latest board
  });
});
