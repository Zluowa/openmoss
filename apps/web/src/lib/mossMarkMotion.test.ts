import { describe, expect, it } from "vitest";

import {
  createMossMarkMotion,
  noteMossMarkProgress,
  setMossMarkActivity,
  stepMossMarkMotion,
  type MossMarkActivity,
  type MossMarkMotion,
} from "./mossMarkMotion";

const FRAME = 1 / 60;

/** Runs frames like the component does, honouring rests; returns every angle seen. */
function run(motion: MossMarkMotion, seconds: number, eachFrame?: () => void): number[] {
  const angles: number[] = [];
  let clock = 0;
  let rested = 0;
  while (clock < seconds) {
    eachFrame?.();
    const wait = stepMossMarkMotion(motion, FRAME + rested);
    angles.push(motion.angle);
    clock += FRAME + rested;
    if (wait === Infinity) break;
    rested = wait;
  }
  return angles;
}

const neverTurnsBack = (angles: number[]) =>
  angles.every((angle, index) => index === 0 || angle <= angles[index - 1]! + 1e-9);
const isRestPose = (angle: number) => Math.abs(angle / 90 - Math.round(angle / 90)) < 1e-9;

describe("moss mark motion", () => {
  it("thinks in quarter-turn gusts that rest on the still logo", () => {
    const motion = createMossMarkMotion("thinking");
    const angles = run(motion, 12);
    expect(neverTurnsBack(angles)).toBe(true);
    expect(motion.gusts).toBeGreaterThanOrEqual(5);
    // Every rest between gusts is a multiple of 90 degrees.
    const rests = angles.filter((angle, index) => index > 0 && angle === angles[index - 1]);
    expect(rests.length).toBeGreaterThan(0);
    expect(rests.every(isRestPose)).toBe(true);
  });

  it("asks for no frames while it rests between gusts", () => {
    const motion = createMossMarkMotion("thinking");
    let longestRest = 0;
    for (let frame = 0; frame < 600; frame += 1) {
      const wait = stepMossMarkMotion(motion, FRAME);
      if (wait !== Infinity) longestRest = Math.max(longestRest, wait);
    }
    expect(longestRest).toBeGreaterThan(0.5);
  });

  it("spins faster the faster text arrives, and slows when it stops", () => {
    const motion = createMossMarkMotion("replying");
    run(motion, 3, () => noteMossMarkProgress(motion, 1));
    const slow = motion.speed;
    run(motion, 3, () => noteMossMarkProgress(motion, 5));
    const fast = motion.speed;
    run(motion, 4);
    const quiet = motion.speed;
    expect(fast).toBeGreaterThan(slow * 1.5);
    expect(quiet).toBeLessThan(slow);
    expect(quiet).toBeGreaterThan(0);
  });

  it("follows the text closely: a burst shows in the spin within half a second", () => {
    const motion = createMossMarkMotion("replying");
    // 40 characters a second, in network-sized chunks every fifth frame.
    let frame = 0;
    const chunked = (perSecond: number) => () => {
      frame += 1;
      if (frame % 5 === 0) noteMossMarkProgress(motion, perSecond / 12);
    };
    run(motion, 2, chunked(40));
    const steady = motion.speed;
    expect(steady).toBeGreaterThan(220);
    const ripple: number[] = [];
    run(motion, 1, () => {
      chunked(40)();
      ripple.push(motion.speed);
    });
    // Chunked arrival does not make the spin flutter.
    expect(Math.max(...ripple) - Math.min(...ripple)).toBeLessThan(steady * 0.12);
    run(motion, 0.5, chunked(120));
    expect(motion.speed).toBeGreaterThan(steady * 1.3);
  });

  it("swells into a gust instead of kicking: its top speed comes a third of the way in", () => {
    const motion = createMossMarkMotion("thinking");
    const speeds: number[] = [];
    run(motion, 1.6, () => speeds.push(motion.speed));
    const top = Math.max(...speeds);
    const moving = speeds.filter((speed) => speed > 0);
    expect(top).toBeLessThan(160);
    expect(moving.indexOf(top) / moving.length).toBeGreaterThan(0.2);
    expect(moving[1]! - moving[0]!).toBeLessThan(15);
  });

  it("lets new activity bring the next gust forward while thinking", () => {
    const motion = createMossMarkMotion("thinking");
    for (let frame = 0; frame < 100; frame += 1) stepMossMarkMotion(motion, FRAME);
    expect(motion.gusts).toBe(1);
    expect(motion.settle).toBeNull();
    noteMossMarkProgress(motion, 1);
    stepMossMarkMotion(motion, FRAME);
    expect(motion.gusts).toBe(2);
  });

  const stillStates: MossMarkActivity[] = ["sending", "thinking", "working", "waiting", "done"];
  it.each(stillStates)("lands on the still logo from a full spin into %s", (next) => {
    const motion = createMossMarkMotion("replying");
    const spin = run(motion, 2.37, () => noteMossMarkProgress(motion, 6));
    expect(motion.speed).toBeGreaterThan(150);
    setMossMarkActivity(motion, next);
    const landing: number[] = [];
    let previousSpeed = motion.speed;
    let onlySlowsDown = true;
    for (let frame = 0; frame < 90; frame += 1) {
      stepMossMarkMotion(motion, FRAME);
      landing.push(motion.angle);
      if (motion.speed > previousSpeed + 1e-6) onlySlowsDown = false;
      previousSpeed = motion.speed;
      if (motion.settle === null) break;
    }
    // A fast mark coasts down: it never speeds up on the way to rest.
    expect(onlySlowsDown).toBe(true);
    expect(motion.settle).toBeNull();
    expect(isRestPose(motion.angle)).toBe(true);
    expect(neverTurnsBack([...spin, ...landing])).toBe(true);
    // It coasts on: it never stops short of where it already was.
    expect(spin.at(-1)! - motion.angle).toBeLessThan(180);
  });

  it("keeps one direction and a continuous speed through every change of state", () => {
    const motion = createMossMarkMotion("sending");
    const order: MossMarkActivity[] = [
      "thinking",
      "replying",
      "working",
      "replying",
      "stalled",
      "replying",
      "waiting",
      "thinking",
      "done",
    ];
    const angles: number[] = [];
    let previousSpeed = 0;
    let largestJump = 0;
    for (const [index, activity] of order.entries()) {
      setMossMarkActivity(motion, activity);
      // Odd durations, so changes land mid-gust and mid-spin.
      for (let frame = 0; frame < 47 + index * 31; frame += 1) {
        if (activity === "replying") noteMossMarkProgress(motion, 3);
        stepMossMarkMotion(motion, FRAME);
        angles.push(motion.angle);
        largestJump = Math.max(largestJump, Math.abs(motion.speed - previousSpeed));
        previousSpeed = motion.speed;
      }
    }
    expect(neverTurnsBack(angles)).toBe(true);
    // No single frame changes the speed by more than a gentle push would.
    expect(largestJump).toBeLessThan(30);
  });

  it("comes to rest for good when a turn is done, after one ripple of light", () => {
    const motion = createMossMarkMotion("replying");
    run(motion, 1.5, () => noteMossMarkProgress(motion, 4));
    setMossMarkActivity(motion, "done");
    const radii: number[] = [];
    let brightest = 0;
    let wait = 0;
    for (let frame = 0; frame < 600 && wait !== Infinity; frame += 1) {
      wait = stepMossMarkMotion(motion, FRAME);
      if (motion.rippleLight > 0) radii.push(motion.rippleRadius);
      brightest = Math.max(brightest, motion.rippleLight);
    }
    expect(wait).toBe(Infinity);
    // One ring, travelling outward only, from the hub nearly to the tips, then gone.
    expect(brightest).toBeGreaterThan(0.5);
    expect(radii.every((radius, index) => index === 0 || radius >= radii[index - 1]!)).toBe(true);
    expect(radii[0]).toBeLessThan(0.1);
    expect(radii.at(-1)).toBeGreaterThan(0.95);
    expect(motion.rippleLight).toBe(0);
    expect(isRestPose(motion.angle)).toBe(true);
    expect(motion.opacity).toBeCloseTo(1, 2);
  });

  it("ripples outward again and again while sending, without turning", () => {
    const motion = createMossMarkMotion("sending");
    let ripples = 0;
    let lit = false;
    run(motion, 6, () => {
      if (motion.rippleLight > 0.3 && !lit) ripples += 1;
      lit = motion.rippleLight > 0.3;
    });
    expect(ripples).toBe(4);
    expect(motion.angle).toBe(0);
  });

  it("drains its colour while stalled and gets it back when text returns", () => {
    const motion = createMossMarkMotion("replying");
    run(motion, 1, () => noteMossMarkProgress(motion, 4));
    setMossMarkActivity(motion, "stalled");
    run(motion, 8);
    expect(motion.saturation).toBeLessThan(0.5);
    expect(motion.speed).toBeLessThan(15);
    setMossMarkActivity(motion, "replying");
    run(motion, 2, () => noteMossMarkProgress(motion, 4));
    expect(motion.saturation).toBeGreaterThan(0.95);
  });

  it("breathes while waiting and walks its folds while a tool runs, without turning", () => {
    const waiting = createMossMarkMotion("waiting");
    const opacities: number[] = [];
    run(waiting, 5, () => opacities.push(waiting.opacity));
    expect(Math.min(...opacities)).toBeLessThan(0.6);
    expect(waiting.angle).toBe(0);

    const working = createMossMarkMotion("working");
    const lit = new Set<number>();
    run(working, 4, () => {
      const brightest = working.folds.indexOf(Math.max(...working.folds));
      if (working.folds[brightest]! > 0.8) lit.add(brightest);
    });
    expect(lit.size).toBe(4);
    expect(working.angle).toBe(0);
  });
});
