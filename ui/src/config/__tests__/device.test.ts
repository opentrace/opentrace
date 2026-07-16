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
import { describe, it, expect, afterEach } from 'vitest';
import { isConstrainedDevice } from '../device';

function setDeviceMemory(value: number | undefined): void {
  if (value === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (navigator as any).deviceMemory;
    return;
  }
  Object.defineProperty(navigator, 'deviceMemory', {
    value,
    configurable: true,
  });
}

afterEach(() => setDeviceMemory(undefined));

describe('isConstrainedDevice', () => {
  it('treats low reported memory (<=4 GB) as constrained', () => {
    setDeviceMemory(2);
    expect(isConstrainedDevice()).toBe(true);
  });

  it('treats ample memory (>4 GB) as unconstrained', () => {
    setDeviceMemory(8);
    expect(isConstrainedDevice()).toBe(false);
  });

  it('is unconstrained by default (desktop jsdom: no deviceMemory, fine pointer)', () => {
    // jsdom exposes no matchMedia and no deviceMemory → neither signal fires.
    setDeviceMemory(undefined);
    expect(isConstrainedDevice()).toBe(false);
  });
});
