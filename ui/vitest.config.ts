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

import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@opentrace/components/chat': resolve(
        __dirname,
        'src/components/chat/index.ts',
      ),
      '@opentrace/components/pipeline': resolve(
        __dirname,
        'src/components/pipeline/index.ts',
      ),
      '@opentrace/components/utils': resolve(
        __dirname,
        'src/components/utils.ts',
      ),
      '@opentrace/components': resolve(__dirname, 'src/components/index.ts'),
    },
  },
  test: {
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    environment: 'node',
    setupFiles: ['src/__tests__/setup.ts'],
  },
});
