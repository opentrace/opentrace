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

import { useEffect, useState } from 'react';

function readThemeKey(): string {
  const d = document.documentElement.dataset;
  return `${d.theme ?? ''}_${d.mode ?? ''}`;
}

/**
 * Returns a string key that changes whenever `data-theme` or `data-mode`
 * changes on `<html>`. Useful as a React dependency to invalidate memos
 * that read CSS variables (node/edge/label colors, graph background).
 */
export function useThemeKey(): string {
  const [key, setKey] = useState(readThemeKey);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setKey(readThemeKey());
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-mode'],
    });
    return () => observer.disconnect();
  }, []);

  return key;
}
